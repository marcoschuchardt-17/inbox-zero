import { describe, expect, it, vi } from "vitest";
import { imapFlagsToLabelIds, imapKeyword } from "./imap-flags";
import { createImapProvider } from "./imap";
import type { Logger } from "@/utils/logger";

const { rawMessage, movedTo, appended, flagsRemoved, mailboxState } =
  vi.hoisted(() => ({
    movedTo: [] as string[],
    appended: [] as { mailbox: string; raw: string }[],
    flagsRemoved: [] as string[],
    mailboxState: {
      exists: 1,
      unseen: [] as number[],
      fromUids: [] as number[],
    },
    rawMessage: [
      "From: Sam <sam@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Welcome to the mailbox",
      "Date: Mon, 28 Sep 2026 12:00:00 +0000",
      "Message-ID: <welcome-1@example.com>",
      "In-Reply-To: <parent@example.com>",
      "References: <parent@example.com>",
      "",
      "The mailbox is ready.",
    ].join("\r\n"),
  }));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    mailbox = mailboxState;
    async search(query: { from?: string }) {
      if (query?.from) return mailboxState.fromUids;
      return mailboxState.unseen;
    }
    async messageFlagsRemove(_uid: number, flags: string[]) {
      flagsRemoved.push(...flags);
    }
    async connect() {}
    async getMailboxLock() {
      return { release() {} };
    }
    async *fetch() {
      yield {
        uid: 1,
        source: Buffer.from(rawMessage),
        flags: new Set(["\\Seen"]),
        internalDate: new Date("2026-09-28T12:00:00.000Z"),
      };
    }
    async logout() {}
    async list() {
      return [{ path: "INBOX", name: "INBOX" }];
    }
    async mailboxCreate() {}
    async messageMove(_uid: number, mailbox: string) {
      movedTo.push(mailbox);
    }
    async append(mailbox: string, raw: string) {
      appended.push({ mailbox, raw });
      return { uid: 7 };
    }
  },
}));

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  trace: () => undefined,
  child: () => logger,
} as unknown as Logger;

describe("createImapProvider", () => {
  it("is not a thenable, so async callers return the provider itself", async () => {
    const provider = createImapProvider(
      {
        emailAccountId: "account-1",
        ownerEmail: "owner@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecure: true,
        imapUsername: "owner@example.com",
        imapPassword: "secret",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: "owner@example.com",
        smtpPassword: "secret",
        syncFolder: "INBOX",
      },
      logger,
    );

    const resolved = await Promise.resolve(provider);

    expect(resolved).toBe(provider);
    expect(provider.name).toBe("imap");
  });

  it("reads an inbox message from the raw mailbox source", async () => {
    const provider = createImapProvider(
      {
        emailAccountId: "account-1",
        ownerEmail: "owner@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecure: true,
        imapUsername: "owner@example.com",
        imapPassword: "secret",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: "owner@example.com",
        smtpPassword: "secret",
        syncFolder: "INBOX",
      },
      logger,
    );

    const messages = await provider.getInboxMessages(5);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toBe("Welcome to the mailbox");
    expect(messages[0]?.headers.from).toContain("sam@example.com");
    expect(messages[0]?.headers["in-reply-to"]).toContain("parent@example.com");
    expect(messages[0]?.textPlain).toContain("The mailbox is ready.");
  });

  it("archives a thread into the Archive mailbox", async () => {
    movedTo.length = 0;
    const provider = createImapProvider(
      {
        emailAccountId: "account-1",
        ownerEmail: "owner@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecure: true,
        imapUsername: "owner@example.com",
        imapPassword: "secret",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: "owner@example.com",
        smtpPassword: "secret",
        syncFolder: "INBOX",
      },
      logger,
    );

    const [message] = await provider.getInboxMessages(5);
    await provider.archiveThread(message?.threadId || "", "owner@example.com");

    expect(movedTo).toEqual(["Archive"]);
  });

  it("saves a reply draft in the Drafts mailbox", async () => {
    appended.length = 0;
    const provider = createImapProvider(
      {
        emailAccountId: "account-1",
        ownerEmail: "owner@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecure: true,
        imapUsername: "owner@example.com",
        imapPassword: "secret",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: "owner@example.com",
        smtpPassword: "secret",
        syncFolder: "INBOX",
      },
      logger,
    );

    const [message] = await provider.getInboxMessages(5);
    if (!message) throw new Error("Missing message");
    const result = await provider.draftEmail(
      message,
      { content: "Thanks, I will reply." },
      "owner@example.com",
    );

    expect(result.draftId).toBe("7");
    expect(appended[0]?.mailbox).toBe("Drafts");
    expect(appended[0]?.raw).toContain("Thanks, I will reply.");
    expect(appended[0]?.raw).toContain("In-Reply-To: <welcome-1@example.com>");
  });

  it("counts messages in the inbox and how many are unread", async () => {
    mailboxState.exists = 4;
    mailboxState.unseen = [2, 3];
    const provider = createImapProvider(
      {
        emailAccountId: "account-1",
        ownerEmail: "owner@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecure: true,
        imapUsername: "owner@example.com",
        imapPassword: "secret",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: "owner@example.com",
        smtpPassword: "secret",
        syncFolder: "INBOX",
      },
      logger,
    );

    await expect(provider.getInboxStats()).resolves.toEqual({
      total: 4,
      unread: 2,
    });
    mailboxState.exists = 1;
    mailboxState.unseen = [];
  });

  it("archives every inbox message from a sender", async () => {
    movedTo.length = 0;
    mailboxState.fromUids = [1];
    const provider = createImapProvider(imapConfig(), logger);

    await provider.bulkArchiveFromSenders(
      ["sam@example.com"],
      "owner@example.com",
      "account-1",
    );

    expect(movedTo).toEqual(["Archive"]);
    mailboxState.fromUids = [];
  });

  it("moves every inbox message from a sender into Trash", async () => {
    movedTo.length = 0;
    mailboxState.fromUids = [1];
    const provider = createImapProvider(imapConfig(), logger);

    await provider.bulkTrashFromSenders(
      ["sam@example.com"],
      "owner@example.com",
      "account-1",
    );

    expect(movedTo).toEqual(["Trash"]);
    mailboxState.fromUids = [];
  });

  it("archives the messages that belong to a thread", async () => {
    movedTo.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.bulkArchiveThreads(
      [{ threadId: "welcome to the mailbox", messageIds: ["1"] }],
      "owner@example.com",
    );

    expect(movedTo).toEqual(["Archive"]);
    expect(result).toEqual({
      succeededThreadIds: ["welcome to the mailbox"],
      failedThreadIds: [],
    });
  });

  it("moves a thread into Trash", async () => {
    movedTo.length = 0;
    const provider = createImapProvider(imapConfig(), logger);
    const [message] = await provider.getInboxMessages(5);
    if (!message) throw new Error("Missing message");

    await provider.trashThread(message.threadId, "owner@example.com", "user");

    expect(movedTo).toEqual(["Trash"]);
  });

  it("removes a label keyword from a thread", async () => {
    flagsRemoved.length = 0;
    const provider = createImapProvider(imapConfig(), logger);
    const [message] = await provider.getInboxMessages(5);
    if (!message) throw new Error("Missing message");

    await provider.removeThreadLabel(message.threadId, "Rechnungen");

    expect(flagsRemoved).toEqual(["Rechnungen"]);
  });
});

describe("imap flags", () => {
  it("keeps custom keywords and maps unread and starred", () => {
    expect(imapFlagsToLabelIds(["\\Seen", "\\Flagged", "Rechnung"])).toEqual([
      "Rechnung",
      "STARRED",
    ]);
    expect(imapFlagsToLabelIds(["\\Recent"])).toEqual(["UNREAD"]);
  });

  it("rejects an empty label keyword", () => {
    expect(() => imapKeyword("...")).toThrow("Invalid IMAP label");
    expect(imapKeyword("Kontoauszug")).toBe("Kontoauszug");
  });
});

function imapConfig() {
  return {
    emailAccountId: "account-1",
    ownerEmail: "owner@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecure: true,
    imapUsername: "owner@example.com",
    imapPassword: "secret",
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecure: true,
    smtpUsername: "owner@example.com",
    smtpPassword: "secret",
    syncFolder: "INBOX",
  };
}
