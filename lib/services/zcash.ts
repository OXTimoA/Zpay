import { randomUUID } from "node:crypto";
import axios from "axios";
import { env } from "../env";
import { logger } from "../logger";
import { PaymentSession } from "../domain/payment";

interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: unknown[];
}

interface RpcResponse<T> {
  result: T;
  error: null | {
    code: number;
    message: string;
  };
  id: string;
}

async function rpcCall<T>(method: string, params: unknown[] = []): Promise<T> {
  const request: RpcRequest = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method,
    params,
  };

  try {
    const response = await axios.post<RpcResponse<T>>(
      env.ZCASH_RPC_URL,
      request,
      {
        auth: {
          username: env.ZCASH_RPC_USERNAME,
          password: env.ZCASH_RPC_PASSWORD,
        },
        timeout: 15_000,
      }
    );

    if (response.data.error) {
      throw new Error(
        `Zcash RPC error: ${response.data.error.code} ${response.data.error.message}`
      );
    }

    return response.data.result;
  } catch (error) {
    console.error(JSON.stringify(error, null, 2));
    throw error;
  }
}

export async function generateShieldedAddress(): Promise<string> {
  return rpcCall<string>("z_getnewaccount", ["sapling"]);
}

interface ReceivedTransaction {
  txid: string;
  amount: number;
  memo: string | null;
  confirmations: number;
}

export interface PaymentDetectionResult {
  detected: boolean;
  txId?: string;
  confirmations?: number;
}

export async function detectPayment(
  session: PaymentSession
): Promise<PaymentDetectionResult> {
  const result = await rpcCall<ReceivedTransaction[]>(
    "z_listreceivedbyaddress",
    [session.zcashAddress, env.PAYMENT_CONFIRMATIONS_REQUIRED]
  );

  console.log(JSON.stringify(result, null, 2));

  const match = result.find(
    (tx) =>
      Number(tx.amount) >= session.amountZec &&
      tx.confirmations >= env.PAYMENT_CONFIRMATIONS_REQUIRED
  );

  if (!match) {
    return { detected: false };
  }

  return {
    detected: true,
    txId: match.txid,
    confirmations: match.confirmations,
  };
}
