import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { consumePaymentEvents, eventsEnabled } from "@/lib/services/events";

export const runtime = "edge";

function toSse(data: string, event?: string) {
  if (event) {
    return `event: ${event}\ndata: ${data}\n\n`;
  }
  return `data: ${data}\n\n`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function GET() {
  if (!eventsEnabled()) {
    return NextResponse.json({ message: "Events not configured" }, { status: 503 });
  }

  const encoder = new TextEncoder();
  const topics = env.UPSTASH_KAFKA_TOPIC ? [env.UPSTASH_KAFKA_TOPIC] : [];
  const groupId = env.UPSTASH_KAFKA_CONSUMER_GROUP;
  const timeout = env.UPSTASH_KAFKA_CONSUMER_TIMEOUT_MS;
  const instanceId = crypto.randomUUID();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(toSse("{}", "ready")));

      let active = true;
      while (active) {
        try {
          const messages = await consumePaymentEvents({
            consumerGroupId: groupId,
            instanceId,
            topics,
            timeout,
          });
          if (messages.length === 0) {
            await sleep(timeout);
            continue;
          }
          for (const message of messages) {
            controller.enqueue(encoder.encode(toSse(message.value)));
          }
        } catch (error) {
          controller.enqueue(encoder.encode(toSse('"stream_error"', "error")));
          active = false;
        }
      }
      controller.close();
    },
    cancel() {
      return;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

