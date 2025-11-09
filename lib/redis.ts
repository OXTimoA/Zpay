import { Redis } from "@upstash/redis";
import { env } from "./env";
import {
  PaymentSession,
  PaymentSessionSchema,
  PaymentStatus,
} from "./domain/payment";
import { logger } from "./logger";

const SESSION_KEY_PREFIX = "payment:session";
const SESSION_INDEX_KEY = "payment:sessions";
const SESSION_PENDING_SET_KEY = "payment:pending";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return client;
}

const sessionKey = (id: string) => `${SESSION_KEY_PREFIX}:${id}`;

export async function createPaymentSession(session: PaymentSession): Promise<void> {
  const redis = getRedis();
  const ttl = env.UPSTASH_REDIS_DEFAULT_TTL_SECONDS;

  await redis.set(sessionKey(session.id), session, {
    ex: ttl,
  });
  await redis.zadd(SESSION_INDEX_KEY, {
    score: Date.parse(session.createdAt),
    member: session.id,
  });
  await updatePendingIndex(session.id, session.status);
}

export async function updatePaymentSession(
  id: string,
  updater: (session: PaymentSession) => PaymentSession | Promise<PaymentSession>
): Promise<PaymentSession | null> {
  const current = await getPaymentSession(id);
  if (!current) {
    return null;
  }
  const next = await updater(current);
  const parseResult = PaymentSessionSchema.safeParse(next);
  if (!parseResult.success) {
    logger.error({ id, errors: parseResult.error.format() }, "invalid session update");
    throw new Error("Invalid session update payload");
  }
  const redis = getRedis();
  const ttlMs = Date.parse(parseResult.data.expiresAt) - Date.now();
  const ttlSeconds = ttlMs > 0 ? Math.ceil(ttlMs / 1000) : env.UPSTASH_REDIS_DEFAULT_TTL_SECONDS;
  await redis.set(sessionKey(id), parseResult.data, { ex: ttlSeconds });
  await updatePendingIndex(id, parseResult.data.status);
  return parseResult.data;
}

export async function getPaymentSession(id: string): Promise<PaymentSession | null> {
  const redis = getRedis();
  const raw = await redis.get<PaymentSession>(sessionKey(id));
  if (!raw) {
    return null;
  }
  const parsed = PaymentSessionSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ id, error: parsed.error }, "Failed to parse payment session");
    return null;
  }
  return parsed.data;
}

export interface ListSessionsParams {
  cursor?: string;
  limit?: number;
}

export interface ListSessionsResult {
  sessions: PaymentSession[];
  nextCursor: string | null;
}

export async function listPaymentSessions({
  cursor,
  limit = 20,
}: ListSessionsParams): Promise<ListSessionsResult> {
  const redis = getRedis();
  const normalizedLimit = Math.max(1, Math.min(limit, 100));

  let start = 0;
  if (cursor) {
    const rank = await redis.zrevrank(SESSION_INDEX_KEY, cursor);
    if (rank !== null) {
      start = rank + 1;
    }
  }

  const ids = await redis.zrange<string[]>(
    SESSION_INDEX_KEY,
    start,
    start + normalizedLimit - 1,
    { rev: true },
  );

  if (ids.length === 0) {
    return { sessions: [], nextCursor: null };
  }

  const keys = ids.map((id) => sessionKey(id));
  const rawSessions = await redis.mget<(PaymentSession | null)[]>(...keys);
  const sessions: PaymentSession[] = [];
  for (const raw of rawSessions) {
    if (!raw) continue;
    const parsed = PaymentSessionSchema.safeParse(raw);
    if (parsed.success) {
      sessions.push(parsed.data);
    }
  }

  const nextCursor =
    ids.length === normalizedLimit ? ids[ids.length - 1] ?? null : null;

  return { sessions, nextCursor };
}

async function updatePendingIndex(id: string, status: PaymentStatus): Promise<void> {
  const redis = getRedis();
  if (status === "pending" || status === "confirmed") {
    await redis.sadd(SESSION_PENDING_SET_KEY, id);
  } else {
    await redis.srem(SESSION_PENDING_SET_KEY, id);
  }
}

export async function getPendingSessionIds(): Promise<string[]> {
  const redis = getRedis();
  return redis.smembers(SESSION_PENDING_SET_KEY);
}

