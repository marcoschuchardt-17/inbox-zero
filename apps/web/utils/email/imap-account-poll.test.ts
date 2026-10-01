import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";

vi.mock("@/utils/prisma");

const { createEmailProvider } = vi.hoisted(() => ({
  createEmailProvider: vi.fn(),
}));
const {
  ensureImapMailboxRules,
  labelImapMessagesWithStaticRules,
  applyImapStaticMailboxActions,
  archiveBlockedImapSenders,
} = vi.hoisted(() => ({
  ensureImapMailboxRules: vi.fn(),
  labelImapMessagesWithStaticRules: vi.fn(async () => 1),
  applyImapStaticMailboxActions: vi.fn(),
  archiveBlockedImapSenders: vi.fn(),
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider,
}));
vi.mock("@/utils/email/imap-mailbox-rules", () => ({
  ensureImapMailboxRules,
  labelImapMessagesWithStaticRules,
  applyImapStaticMailboxActions,
  archiveBlockedImapSenders,
}));

import { pollImapAccount } from "@/utils/email/imap-account-poll";

const logger = createScopedLogger("imap-account-poll-test");

describe("pollImapAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.imapSmtpConfig.update.mockResolvedValue({} as never);
  });

  it("applies static mailbox rules to mail that has not been synced", async () => {
    createEmailProvider.mockResolvedValue({
      getThreadsWithQuery: vi.fn(async () => ({
        threads: [
          {
            messages: [
              {
                id: "INBOX/22",
                threadId: "keep",
                headers: { from: "Sam <sam@example.com>" },
              },
            ],
          },
        ],
      })),
    });

    const result = await pollImapAccount({
      emailAccountId: "account-1",
      lastSyncedAt: null,
      logger,
    });

    expect(result).toEqual({ ok: true, labeled: 1 });
    expect(prisma.imapSmtpConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: "account-1" },
        data: expect.objectContaining({
          lastConnectionError: null,
          lastSyncUid: BigInt(22),
        }),
      }),
    );
    expect(ensureImapMailboxRules).toHaveBeenCalledWith("account-1");
    expect(labelImapMessagesWithStaticRules).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "account-1",
        messages: [expect.objectContaining({ id: "INBOX/22" })],
      }),
    );
    expect(applyImapStaticMailboxActions).toHaveBeenCalled();
    expect(archiveBlockedImapSenders).toHaveBeenCalled();
  });

  it("records a connection error and skips rules when the mailbox cannot be read", async () => {
    createEmailProvider.mockRejectedValue(new Error("connection refused"));

    const result = await pollImapAccount({
      emailAccountId: "account-1",
      lastSyncedAt: null,
      logger,
    });

    expect(result).toEqual({ ok: false, labeled: 0 });
    expect(ensureImapMailboxRules).not.toHaveBeenCalled();
    expect(prisma.imapSmtpConfig.update).toHaveBeenCalledWith({
      where: { emailAccountId: "account-1" },
      data: { lastConnectionError: "connection refused" },
    });
  });
});
