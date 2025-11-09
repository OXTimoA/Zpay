import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { createPaymentSession } from "@/lib/services/payments";
import { SolanaActionSchema } from "@/lib/domain/payment";

const requestSchema = z.object({
  amountZec: z.coerce.number().positive(),
  targetAction: SolanaActionSchema,
  merchantId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  expiresInSeconds: z.coerce.number().int().positive().optional(),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = requestSchema.parse(body);
    const session = await createPaymentSession(parsed);
    logger.info({ sessionId: session.id }, "payment session created");
    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    console.error(error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { message: "Invalid request", issues: error.format() },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { message: "Failed to create payment session" },
      { status: 500 }
    );
  }
}

