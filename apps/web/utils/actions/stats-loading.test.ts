import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { saveBatch } from "@/utils/actions/stats-loading";
import type { EmailProvider } from "@/utils/email/types";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

describe("saveBatch", () => {
  it("drops an older copy of the same message", async () => {
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.emailMessage.deleteMany.mockResolvedValue({ count: 1 });
    const date = "2026-09-28T16:55:45.000Z";

    await saveBatch({
      emailAccountId: "account-1",
      emailProvider: providerWith({
        id: "Archive/8",
        threadId: "<offer-1@example.com>",
        subject: "Special offer",
        from: "Ads <ads@example.com>",
        internalDate: date,
      }),
      logger: createScopedLogger("stats-loading-test"),
      nextPageToken: undefined,
      before: undefined,
      after: undefined,
    });

    expect(prisma.emailMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            emailAccountId: "account-1",
            sent: false,
            draft: false,
            from: "ads@example.com",
            date: new Date(date),
            messageId: { notIn: ["Archive/8"] },
            threadId: { in: ["<offer-1@example.com>", "special offer"] },
          },
        ],
      },
    });
  });

  it("keeps sent mail when the saved row is a sent copy", async () => {
    prisma.$executeRaw.mockResolvedValue(1);

    await saveBatch({
      emailAccountId: "account-1",
      emailProvider: providerWith({
        id: "sent:9",
        threadId: "<please-keep@example.com>",
        subject: "Please keep this",
        from: "Starttls <starttls.imap@example.com>",
        internalDate: "2026-09-29T04:22:16.000Z",
        labelIds: ["SENT"],
      }),
      logger: createScopedLogger("stats-loading-test"),
      nextPageToken: undefined,
      before: undefined,
      after: undefined,
    });

    expect(prisma.emailMessage.deleteMany).not.toHaveBeenCalled();
  });

  it("stores every sender on a message from more than one person", async () => {
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.emailMessage.deleteMany.mockResolvedValue({ count: 0 });
    const date = "2026-09-30T13:00:00.000Z";

    await saveBatch({
      emailAccountId: "account-1",
      emailProvider: providerWith({
        id: "INBOX/9",
        threadId: "<chart-both@example.com>",
        subject: "Chart both",
        from: "Sam Chart <sam-chart@example.com>, Ada Chart <ada-chart@example.com>",
        internalDate: date,
      }),
      logger: createScopedLogger("stats-loading-test"),
      nextPageToken: undefined,
      before: undefined,
      after: undefined,
    });

    expect(prisma.emailMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          expect.objectContaining({
            from: "sam-chart@example.com, ada-chart@example.com",
          }),
        ],
      },
    });
  });

  it("stores mail that is only from this account as sent", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "starttls.imap@example.com",
    } as never);
    prisma.$executeRaw.mockResolvedValue(1);

    await saveBatch({
      emailAccountId: "account-1",
      emailProvider: providerWith({
        id: "Archive/96",
        threadId: "<chart-sent-both@example.com>",
        subject: "Chart sent both",
        from: "Starttls <starttls.imap@example.com>",
        internalDate: "2026-09-30T16:05:00.000Z",
      }),
      logger: createScopedLogger("stats-loading-test"),
      nextPageToken: undefined,
      before: undefined,
      after: undefined,
    });

    expect(prisma.emailMessage.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps a message that also names someone else as incoming", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "starttls.imap@example.com",
    } as never);
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.emailMessage.deleteMany.mockResolvedValue({ count: 0 });

    await saveBatch({
      emailAccountId: "account-1",
      emailProvider: providerWith({
        id: "Archive/104",
        threadId: "<profile-co-sender@example.com>",
        subject: "Profile co-sender",
        from: "Sam Participant <sam.participant@gmail.com>, Starttls <starttls.imap@example.com>",
        internalDate: "2026-09-30T13:00:00.000Z",
      }),
      logger: createScopedLogger("stats-loading-test"),
      nextPageToken: undefined,
      before: undefined,
      after: undefined,
    });

    expect(prisma.emailMessage.deleteMany).toHaveBeenCalled();
  });
});

function providerWith(message: {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  internalDate: string;
  labelIds?: string[];
}) {
  return {
    getMessagesWithPagination: async () => ({
      messages: [
        {
          id: message.id,
          threadId: message.threadId,
          subject: message.subject,
          internalDate: message.internalDate,
          labelIds: message.labelIds,
          headers: { from: message.from, to: "owner@example.com" },
        },
      ],
    }),
  } as unknown as EmailProvider;
}
