import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockedEnv } = vi.hoisted(() => ({
  mockedEnv: {
    UPSTASH_REDIS_URL: undefined as string | undefined,
    UPSTASH_REDIS_TOKEN: undefined as string | undefined,
  },
}));

vi.mock("server-only", () => ({}));

vi.mock("@/env", () => ({
  env: mockedEnv,
}));

vi.mock("@/utils/prisma");

vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

import prisma from "@/utils/__mocks__/prisma";
import { redis } from "@/utils/redis";
import {
  getEmailAccount,
  invalidateAccountValidation,
} from "@/utils/redis/account-validation";

describe("getEmailAccount", () => {
  beforeEach(() => {
    mockedEnv.UPSTASH_REDIS_URL = undefined;
    mockedEnv.UPSTASH_REDIS_TOKEN = undefined;
    vi.clearAllMocks();
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockResolvedValue("OK");
    vi.mocked(redis.del).mockResolvedValue(1);
  });

  it("reads the database without calling Redis when Redis is not configured", async () => {
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue({
      email: "starttls.imap@example.com",
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>);

    await expect(
      getEmailAccount({
        userId: "user-1",
        emailAccountId: "account-1",
      }),
    ).resolves.toBe("starttls.imap@example.com");

    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: "account-1", userId: "user-1" },
      select: { email: true },
    });
  });

  it("returns a cached account without querying the database", async () => {
    mockedEnv.UPSTASH_REDIS_URL = "https://redis.example.com";
    mockedEnv.UPSTASH_REDIS_TOKEN = "token";
    vi.mocked(redis.get).mockResolvedValue("cached@example.com");

    await expect(
      getEmailAccount({
        userId: "user-1",
        emailAccountId: "account-1",
      }),
    ).resolves.toBe("cached@example.com");

    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
  });

  it("caches a database lookup when Redis is configured", async () => {
    mockedEnv.UPSTASH_REDIS_URL = "https://redis.example.com";
    mockedEnv.UPSTASH_REDIS_TOKEN = "token";
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue({
      email: "mailbox@example.com",
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>);

    await expect(
      getEmailAccount({
        userId: "user-1",
        emailAccountId: "account-1",
      }),
    ).resolves.toBe("mailbox@example.com");

    expect(redis.set).toHaveBeenCalledWith(
      "account:user-1:account-1",
      "mailbox@example.com",
      { ex: 60 * 60 },
    );
  });

  it("skips cache invalidation when Redis is not configured", async () => {
    await invalidateAccountValidation({
      userId: "user-1",
      emailAccountId: "account-1",
    });

    expect(redis.del).not.toHaveBeenCalled();
  });
});
