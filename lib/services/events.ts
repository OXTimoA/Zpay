import { Kafka, Message } from "@upstash/kafka";
import { randomUUID } from "crypto";
import { env } from "../env";
import { logger } from "../logger";

export interface PaymentEvent {
  type: string;
  sessionId: string;
  payload?: unknown;
  timestamp?: string;
}

let kafkaClient: Kafka | null = null;
let producer: ReturnType<Kafka["producer"]> | null = null;

function kafkaConfigured(): boolean {
  return Boolean(
    env.UPSTASH_KAFKA_REST_URL &&
      env.UPSTASH_KAFKA_REST_USERNAME &&
      env.UPSTASH_KAFKA_REST_PASSWORD &&
      env.UPSTASH_KAFKA_TOPIC
  );
}

function getKafka(): Kafka | null {
  if (!kafkaConfigured()) {
    return null;
  }
  if (!kafkaClient) {
    kafkaClient = new Kafka({
      url: env.UPSTASH_KAFKA_REST_URL as string,
      username: env.UPSTASH_KAFKA_REST_USERNAME as string,
      password: env.UPSTASH_KAFKA_REST_PASSWORD as string,
    });
  }
  return kafkaClient;
}

export function eventsEnabled(): boolean {
  return kafkaConfigured();
}

export async function publishPaymentEvent(event: PaymentEvent): Promise<void> {
  try {
    const kafka = getKafka();
    if (!kafka) {
      return;
    }
    if (!producer) {
      producer = kafka.producer();
    }
    const enriched: PaymentEvent = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    await producer.produce(env.UPSTASH_KAFKA_TOPIC as string, enriched);
  } catch (error) {
    logger.error({ error }, "Failed to publish payment event");
  }
}

export function createConsumerInstance() {
  const kafka = getKafka();
  if (!kafka) {
    return null;
  }
  return {
    consumer: kafka.consumer(),
    instanceId: crypto.randomUUID(),
  };
}

export async function consumePaymentEvents(consumerConfig: {
  consumerGroupId: string;
  instanceId: string;
  topics: string[];
  timeout?: number;
}): Promise<Message[]> {
  const kafka = getKafka();
  if (!kafka) {
    return [];
  }
  try {
    const consumer = kafka.consumer();
    return consumer.consume({
      consumerGroupId: consumerConfig.consumerGroupId,
      instanceId: consumerConfig.instanceId,
      topics: consumerConfig.topics,
      timeout: consumerConfig.timeout ?? env.UPSTASH_KAFKA_CONSUMER_TIMEOUT_MS,
      autoCommit: true,
      autoOffsetReset: "latest",
    });
  } catch (error) {
    logger.error({ error }, "Failed to consume payment events");
    return [];
  }
}

