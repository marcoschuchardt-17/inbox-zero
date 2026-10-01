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
    expect(senders.every((sender) => sender.fromName == null)).toBe(true);
  });

  it("names each sender when the stored name lists every person", async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        from: "sam-chart@example.com, ada-chart@example.com",
        fromName: "Sam Chart, Ada Chart",
        minFromName: "Sam Chart, Ada Chart",
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

    expect(senders).toEqual([
      expect.objectContaining({
        from: "ada-chart@example.com",
        fromName: "Ada Chart",
        minFromName: "Ada Chart",
      }),
      expect.objectContaining({
        from: "sam-chart@example.com",
        fromName: "Sam Chart",
        minFromName: "Sam Chart",
      }),
    ]);
  });

  it("keeps a solo name when an earlier shared row has no name to split", async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        from: "sam@example.com, ada@example.com",
        fromName: "Sam",
        minFromName: "Sam",
        count: 2,
        inboxEmails: 0,
        readEmails: 2,
        unsubscribeLink: null,
      },
      {
        from: "ada@example.com",
        fromName: "Ada",
        minFromName: "Ada",
        count: 1,
        inboxEmails: 0,
        readEmails: 1,
        unsubscribeLink: null,
      },
    ]);

    const senders = await getSenderEmailStats({
      emailAccountId: "account-1",
      logger: createScopedLogger("sender-stats-test"),
    });

    expect(senders).toEqual([
      expect.objectContaining({
        from: "ada@example.com",
        fromName: "Ada",
        count: 3,
      }),
      expect.objectContaining({
        from: "sam@example.com",
        fromName: null,
        count: 2,
      }),
    ]);
  });

  it("names the other sender when this account is listed first", async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        from: "starttls.imap@example.com, ada@example.com",
        fromName: "Starttls, Ada",
        minFromName: "Starttls, Ada",
        count: 1,
        inboxEmails: 0,
        readEmails: 1,
        unsubscribeLink: null,
      },
    ]);

    const senders = await getSenderEmailStats({
      emailAccountId: "account-1",
      accountEmail: "starttls.imap@example.com",
      logger: createScopedLogger("sender-stats-test"),
    });

    expect(senders).toEqual([
      expect.objectContaining({
        from: "ada@example.com",
        fromName: "Ada",
      }),
    ]);
  });

  it("leaves the account off the list, including when it is one of two senders", async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        from: "starttls.imap@example.com",
        fromName: "Starttls",
        minFromName: "Starttls",
        count: 4,
        inboxEmails: 0,
        readEmails: 4,
        unsubscribeLink: null,
      },
      {
        from: "sam.participant@gmail.com, starttls.imap@example.com",
        fromName: "Sam Participant",
        minFromName: "Sam Participant",
        count: 1,
        inboxEmails: 0,
        readEmails: 1,
        unsubscribeLink: null,
      },
    ]);

    const senders = await getSenderEmailStats({
      emailAccountId: "account-1",
      accountEmail: "starttls.imap@example.com",
      logger: createScopedLogger("sender-stats-test"),
    });

    expect(senders).toEqual([
      expect.objectContaining({
        from: "sam.participant@gmail.com",
        fromName: "Sam Participant",
        count: 1,
      }),
    ]);
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
