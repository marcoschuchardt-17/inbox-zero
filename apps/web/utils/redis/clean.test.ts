import { beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import { getThreadsByJobId } from "@/utils/redis/clean";

vi.mock("@/utils/redis", () => ({
  redis: {
    scan: vi.fn(),
    get: vi.fn(),
  },
}));

describe("getThreadsByJobId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns no threads when Redis has no URL", async () => {
    vi.mocked(redis.scan).mockRejectedValue(
      new TypeError("Failed to parse URL from /pipeline"),
    );

    await expect(
      getThreadsByJobId({
        emailAccountId: "acc-1",
        jobId: "job-1",
      }),
    ).resolves.toEqual([]);

    expect(redis.get).not.toHaveBeenCalled();
  });

  it("rethrows a Redis outage", async () => {
    vi.mocked(redis.scan).mockRejectedValue(new Error("redis down"));

    await expect(
      getThreadsByJobId({
        emailAccountId: "acc-1",
        jobId: "job-1",
      }),
    ).rejects.toThrow("redis down");
  });
});
