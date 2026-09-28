import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockedEnv } = vi.hoisted(() => ({
  mockedEnv: {
    UPSTASH_REDIS_URL: undefined as string | undefined,
    UPSTASH_REDIS_TOKEN: undefined as string | undefined,
  },
}));

vi.mock("@/env", () => ({
  env: mockedEnv,
}));

vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

import { redis } from "@/utils/redis";
import {
  isAnalyzingReplyTracker,
  startAnalyzingReplyTracker,
  stopAnalyzingReplyTracker,
} from "@/utils/redis/reply-tracker-analyzing";

describe("reply tracker analyzing flag", () => {
  beforeEach(() => {
    mockedEnv.UPSTASH_REDIS_URL = undefined;
    mockedEnv.UPSTASH_REDIS_TOKEN = undefined;
    vi.clearAllMocks();
  });

  it("treats the tracker as idle when Redis is not configured", async () => {
    vi.mocked(redis.get).mockRejectedValue(
      new TypeError("Failed to parse URL from /pipeline"),
    );

    await expect(
      isAnalyzingReplyTracker({ emailAccountId: "account-1" }),
    ).resolves.toBe(false);
    await startAnalyzingReplyTracker({ emailAccountId: "account-1" });
    await stopAnalyzingReplyTracker({ emailAccountId: "account-1" });

    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("reads the analyzing flag when Redis is configured", async () => {
    mockedEnv.UPSTASH_REDIS_URL = "https://redis.example.com";
    mockedEnv.UPSTASH_REDIS_TOKEN = "token";
    vi.mocked(redis.get).mockResolvedValue("true");

    await expect(
      isAnalyzingReplyTracker({ emailAccountId: "account-1" }),
    ).resolves.toBe(true);

    expect(redis.get).toHaveBeenCalledWith("reply-tracker:analyzing:account-1");
  });
});
