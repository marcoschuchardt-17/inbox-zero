import "server-only";
import { env } from "@/env";
import { redis } from "@/utils/redis";
import prisma from "@/utils/prisma";

const EXPIRATION = 60 * 60; // 1 hour

/**
 * Get the Redis key for account validation
 */
function getValidationKey({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): string {
  return `account:${userId}:${emailAccountId}`;
}

/**
 * Validate that an account belongs to a user, using Redis for caching
 * @param userId The user ID
 * @param accountId The account ID to validate
 * @returns email address of the account if it belongs to the user, otherwise null
 */
export async function getEmailAccount({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): Promise<string | null> {
  if (!userId || !emailAccountId) return null;

  const key = getValidationKey({ userId, emailAccountId });

  // An unconfigured Upstash client still attempts a request and times out.
  if (!isAccountValidationCacheConfigured()) {
    return readEmailAccountEmail({ userId, emailAccountId });
  }

  // Check Redis cache first
  try {
    const cachedResult = await redis.get<string>(key);
    if (cachedResult !== null) {
      return cachedResult;
    }
  } catch {
    // Redis unavailable — fall through to database
  }

  const email = await readEmailAccountEmail({ userId, emailAccountId });

  // Cache the result (best-effort)
  try {
    await redis.set(key, email, { ex: EXPIRATION });
  } catch {
    // Redis unavailable — skip caching
  }

  return email;
}

/**
 * Invalidate the cached validation result for a user's account
 * Useful when account ownership changes
 */
export async function invalidateAccountValidation({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): Promise<void> {
  if (!isAccountValidationCacheConfigured()) return;

  const key = getValidationKey({ userId, emailAccountId });
  try {
    await redis.del(key);
  } catch {
    // Redis unavailable — skip invalidation
  }
}

function isAccountValidationCacheConfigured() {
  return Boolean(env.UPSTASH_REDIS_URL && env.UPSTASH_REDIS_TOKEN);
}

async function readEmailAccountEmail({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}) {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId, userId },
    select: { email: true },
  });

  return emailAccount?.email ?? null;
}
