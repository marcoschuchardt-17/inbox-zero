import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";
import { getSenderEmailStats } from "@/utils/sender-stats";

vi.mock("@/utils/prisma");

describe("getSenderEmailStats", () => {
  it("counts mail from other people and leaves out mail the account sent or drafted", async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await getSenderEmailStats({
      emailAccountId: "account-1",
      logger: createScopedLogger("sender-stats-test"),
    });

    const sql = sqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("sent = false");
    expect(sql).toContain("draft = false");
  });

  it("lists every sender stored on one message", async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        from: "sam-chart@example.com, ada-chart@example.com",
        fromName: "Sam Chart",
        minFromName: "Sam Chart",
        count: 1,
        inboxEmails: 1,
        readEmails: 0,
        unsubscribeLink: null,
      },
    ]);

    const senders = await getSenderEmailStats({
      emailAccountId: "account-1",
      logger: createScopedLogger("sender-stats-test"),
    });

    expect(senders.map((sender) => sender.from)).toEqual([
      "ada-chart@example.com",
      "sam-chart@example.com",
    ]);
    expect(senders.every((sender) => sender.count === 1)).toBe(true);
  });
});

function sqlText(query: unknown) {
  if (
    query &&
    typeof query === "object" &&
    "strings" in query &&
    Array.isArray(query.strings)
  ) {
    return query.strings.join(" ");
  }
  return String(query);
}
