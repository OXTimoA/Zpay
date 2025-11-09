import { addSeconds } from "date-fns";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { env } from "../env";
import { logger } from "../logger";
import { PaymentSession, SolanaAction, SolanaActionSchema } from "../domain/payment";
import {
  createPaymentSession as createSessionRecord,
  getPaymentSession,
  listPaymentSessions,
  updatePaymentSession,
  getPendingSessionIds,
} from "../redis";
import { detectPayment, generateShieldedAddress } from "./zcash";
import { createFlashiftSwap } from "./solana";
import { publishPaymentEvent } from "./events";
import { sendMerchantWebhook } from "./webhooks";

const createPaymentInputSchema = z.object({
  amountZec: z.coerce.number().positive(),
  targetAction: SolanaActionSchema,
  merchantId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  expiresInSeconds: z.coerce.number().int().positive().optional(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentInputSchema>;

export async function createPaymentSession(
  input: CreatePaymentInput
): Promise<PaymentSession> {
  const parsed = createPaymentInputSchema.parse(input);

  const id = uuidv4();
  const zcashAddress = await generateShieldedAddress();
  const now = new Date();
  const expiresAt = addSeconds(
    now,
    parsed.expiresInSeconds ?? env.UPSTASH_REDIS_DEFAULT_TTL_SECONDS
  );

  const session: PaymentSession = {
    id,
    zcashAddress,
    amountZec: parsed.amountZec,
    confirmationsRequired: env.PAYMENT_CONFIRMATIONS_REQUIRED,
    targetAction: parsed.targetAction,
    merchantId: parsed.merchantId,
    metadata: parsed.metadata,
    status: "pending",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await createSessionRecord(session);
  await fanOut("payment.created", session);
  return session;
}

export async function getSession(id: string): Promise<PaymentSession | null> {
  return getPaymentSession(id);
}

export async function listSessions(params: {
  cursor?: string;
  limit?: number;
}) {
  return listPaymentSessions(params);
}

async function markSessionFailed(
  id: string,
  reason: string
): Promise<PaymentSession | null> {
  const updated = await updatePaymentSession(id, (session) => ({
    ...session,
    status: "failed",
    errorReason: reason,
    updatedAt: new Date().toISOString(),
  }));
  await fanOut("payment.failed", updated);
  return updated;
}

async function markSessionExecuted(
  id: string,
  updates: Partial<PaymentSession>
): Promise<PaymentSession | null> {
  const updated = await updatePaymentSession(id, (session) => ({
    ...session,
    ...updates,
    status: "executed",
    updatedAt: new Date().toISOString(),
  }));
  await fanOut("payment.executed", updated);
  return updated;
}

function getTargetAmountInSol(action: SolanaAction): string {
  if (action.type !== "send_sol") {
    throw new Error(`Unsupported action for Flashift integration: ${action.type}`);
  }
  const solAmount = action.lamports / 1_000_000_000;
  return solAmount.toString();
}

export async function processPendingSessions(): Promise<void> {
  const ids = await getPendingSessionIds();
  for (const id of ids) {
    const session = await getPaymentSession(id);
    if (!session) {
      continue;
    }

    if (Date.parse(session.expiresAt) <= Date.now()) {
      const expired = await updatePaymentSession(id, (current) => ({
        ...current,
        status: "expired",
        updatedAt: new Date().toISOString(),
      }));
      await fanOut("payment.expired", expired);
      continue;
    }

    if (session.status === "pending") {
      try {
        const detection = await detectPayment(session);
        if (!detection.detected) {
          continue;
        }

        const confirmed = await updatePaymentSession(id, (current) => ({
          ...current,
          status: "confirmed",
          zcashTxId: detection.txId ?? current.zcashTxId,
          updatedAt: new Date().toISOString(),
        }));
        await fanOut("payment.confirmed", confirmed);
      } catch (error) {
        logger.error({ sessionId: id, error }, "Zcash detection failed");
        await markSessionFailed(id, "zcash_detection_failed");
        continue;
      }
    }

    const confirmed = await getPaymentSession(id);
    if (!confirmed || confirmed.status !== "confirmed") {
      continue;
    }

    if (confirmed.solanaTxId || confirmed.flashiftTransactionId) {
      continue;
    }

    try {
      const amount = getTargetAmountInSol(confirmed.targetAction);
      const transaction = await createFlashiftSwap({
        currencyFrom: "zec",
        currencyTo: "sol",
        amount,
        destinationAddress:
          confirmed.targetAction.type === "send_sol" ? confirmed.targetAction.destination : "",
      });

      await markSessionExecuted(id, {
        solanaTxId: transaction.txTo,
        flashiftTransactionId: transaction.id,
        flashiftDepositAddress: transaction.depositAddress,
      });
    } catch (error) {
      logger.error({ sessionId: id, error }, "Flashift execution failed");
      await markSessionFailed(id, "flashift_execution_failed");
    }
  }
}

export async function refreshSession(
  id: string
): Promise<PaymentSession | null> {
  const session = await getPaymentSession(id);
  if (!session) {
    return null;
  }

  if (session.status === "pending" || session.status === "confirmed") {
    await processPendingSessions();
    return getPaymentSession(id);
  }

  return session;
}

async function fanOut(type: string, session: PaymentSession | null) {
  if (!session) {
    return;
  }
  const timestamp = new Date().toISOString();
  await publishPaymentEvent({
    type,
    sessionId: session.id,
    payload: session,
    timestamp,
  });
  await sendMerchantWebhook({
    type,
    session,
    timestamp,
  });
}

