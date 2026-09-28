import { env } from "@/env";
import { redis } from "@/utils/redis";

function getKey({ emailAccountId }: { emailAccountId: string }) {
  return `reply-tracker:analyzing:${emailAccountId}`;
}

function isReplyTrackerRedisConfigured() {
  return Boolean(env.UPSTASH_REDIS_URL && env.UPSTASH_REDIS_TOKEN);
}

export async function startAnalyzingReplyTracker({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  if (!isReplyTrackerRedisConfigured()) return;
  const key = getKey({ emailAccountId });
  // expire in 5 minutes
  await redis.set(key, "true", { ex: 5 * 60 });
}

export async function stopAnalyzingReplyTracker({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  if (!isReplyTrackerRedisConfigured()) return;
  const key = getKey({ emailAccountId });
  await redis.del(key);
}

export async function isAnalyzingReplyTracker({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  if (!isReplyTrackerRedisConfigured()) return false;
  const key = getKey({ emailAccountId });
  const result = await redis.get(key);
  return result === "true";
}
