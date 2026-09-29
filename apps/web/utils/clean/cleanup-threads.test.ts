import { describe, expect, it, vi } from "vitest";
import { cleanupThreadsForDisplay } from "@/utils/clean/cleanup-threads";

describe("cleanupThreadsForDisplay", () => {
  it("shows the archived newsletter and the kept message", async () => {
    const loadThread = vi.fn(async (threadId: string) => {
      if (threadId === "<weekly-newsletter@example.com>") {
        return {
          messages: [
            {
              subject: "Weekly newsletter",
              snippet: "The weekly newsletter.",
              date: "2026-09-01T12:00:00.000Z",
              headers: { from: "News <news@newsletter.example.com>" },
            },
          ],
        };
      }
      return null;
    });

    const threads = await cleanupThreadsForDisplay({
      emailAccountId: "account-1",
      jobId: "job-1",
      rows: [
        {
          threadId: "<weekly-newsletter@example.com>",
          archived: true,
          createdAt: new Date("2026-09-29T03:00:00.000Z"),
        },
        {
          threadId: "<please-keep@example.com>",
          archived: false,
          createdAt: new Date("2026-09-29T03:00:01.000Z"),
        },
      ],
      loadThread,
    });

    expect(threads).toEqual([
      expect.objectContaining({
        subject: "Weekly newsletter",
        from: "News <news@newsletter.example.com>",
        archive: true,
      }),
      expect.objectContaining({
        threadId: "<please-keep@example.com>",
        subject: "<please-keep@example.com>",
        archive: false,
      }),
    ]);
  });
});
