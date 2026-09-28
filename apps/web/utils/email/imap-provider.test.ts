import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { imapFlagsToLabelIds, imapKeyword } from "./imap-flags";
import { createImapProvider } from "./imap";
import type { Logger } from "@/utils/logger";

vi.mock("@/utils/prisma");

const sentMail = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const smtpTransports = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      smtpTransports.push(options);
      return {
        sendMail: async (message: Record<string, unknown>) => {
          sentMail.push(message);
          return { messageId: "<sent@example.com>" };
        },
      };
    },
  },
}));

const {
  rawMessage,
  movedTo,
  movedFrom,
  appended,
  flagsRemoved,
  flagsAdded,
  deleted,
  created,
  mailboxState,
} = vi.hoisted(() => ({
  movedTo: [] as string[],
  movedFrom: [] as string[],
  appended: [] as { mailbox: string; raw: string }[],
  flagsRemoved: [] as string[],
  flagsAdded: [] as { uid: number; flags: string[] }[],
  deleted: [] as { mailbox: string; uid: number }[],
  created: [] as string[],
  mailboxState: {
    exists: 1,
    unseen: [] as number[],
    fromUids: [] as number[],
    allUids: [] as number[],
    opened: "INBOX",
    connectOptions: null as null | Record<string, unknown>,
    archiveSource: "" as string,
    sentSource: "" as string,
    trashSource: "" as string,
    draftSource: "" as string,
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
    constructor(options: Record<string, unknown>) {
      mailboxState.connectOptions = options;
    }
    async search(query: { from?: string; all?: boolean }) {
      if (query?.from) return mailboxState.fromUids;
      if (query?.all) return mailboxState.allUids;
      return mailboxState.unseen;
    }
    async messageFlagsRemove(_uid: number, flags: string[]) {
      flagsRemoved.push(...flags);
    }
    async messageFlagsAdd(uid: number, flags: string[]) {
      flagsAdded.push({ uid, flags: [...flags] });
    }
    async connect() {}
    async getMailboxLock(mailbox = "INBOX") {
      mailboxState.opened = mailbox;
      return { release() {} };
    }
    async *fetch() {
      if (mailboxState.opened === "Archive") {
        if (!mailboxState.archiveSource) return;
        yield {
          uid: 9,
          source: Buffer.from(mailboxState.archiveSource),
          flags: new Set(["\\Seen"]),
          internalDate: new Date("2026-09-28T13:00:00.000Z"),
        };
        return;
      }
      if (mailboxState.opened === "Sent") {
        if (!mailboxState.sentSource) return;
        yield {
          uid: 11,
          source: Buffer.from(mailboxState.sentSource),
          flags: new Set(["\\Seen"]),
          internalDate: new Date("2026-09-28T14:00:00.000Z"),
        };
        return;
      }
      if (mailboxState.opened === "Drafts") {
        if (!mailboxState.draftSource) return;
        yield {
          uid: 13,
          source: Buffer.from(mailboxState.draftSource),
          flags: new Set(["\\Draft", "\\Seen"]),
          internalDate: new Date("2026-09-28T16:00:00.000Z"),
        };
        return;
      }
      if (mailboxState.opened === "Trash") {
        if (!mailboxState.trashSource) return;
        yield {
          uid: 12,
          source: Buffer.from(mailboxState.trashSource),
          flags: new Set(["\\Seen"]),
          internalDate: new Date("2026-09-28T15:00:00.000Z"),
        };
        return;
      }
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
    async mailboxCreate(mailbox: string) {
      created.push(mailbox);
    }
    async messageMove(_uid: number, mailbox: string) {
      movedFrom.push(mailboxState.opened);
      movedTo.push(mailbox);
    }
    async messageDelete(uid: number) {
      deleted.push({ mailbox: mailboxState.opened, uid });
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

  it("stops waiting when the mail server does not answer", async () => {
    smtpTransports.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    await provider.getInboxMessages(1);
    await provider.sendEmailWithHtml({
      to: "a@example.com",
      subject: "Hi",
      messageHtml: "<p>Hi</p>",
    });

    expect(mailboxState.connectOptions).toMatchObject({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
    expect(smtpTransports.at(-1)).toMatchObject({
      connectionTimeout: 10_000,
      socketTimeout: 10_000,
    });
  });

  it("sends a reply on the same conversation", async () => {
    sentMail.length = 0;
    appended.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.sendEmailWithHtml({
      to: "digest@example.com",
      subject: "Re: Morning digest",
      messageHtml: "<p>Thanks</p>",
      replyToEmail: {
        threadId: "morning digest",
        headerMessageId: "<digest-reader@example.com>",
        references: "<digest-reader@example.com>",
      },
    });

    expect(result.threadId).toBe("morning digest");
    expect(sentMail[0]).toMatchObject({
      to: "digest@example.com",
      subject: "Re: Morning digest",
      inReplyTo: "<digest-reader@example.com>",
      references: "<digest-reader@example.com>",
    });
    expect(appended[0]?.mailbox).toBe("Sent");
    expect(appended[0]?.raw).toContain(
      "In-Reply-To: <digest-reader@example.com>",
    );
    expect(appended[0]?.raw).toContain("<p>Thanks</p>");
  });

  it("opens a thread that was moved to Archive", async () => {
    mailboxState.archiveSource = [
      "From: Digest <digest@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Morning digest",
      "Date: Mon, 28 Sep 2026 13:00:00 +0000",
      "Message-ID: <digest-1@example.com>",
      "",
      "Your morning digest.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const thread = await provider.getThread("<digest-1@example.com>");

    expect(thread.messages[0]?.subject).toBe("Morning digest");
    expect(thread.messages[0]?.textPlain).toContain("Your morning digest.");
    mailboxState.archiveSource = "";
  });

  it("opens an inbox message together with the reply stored in Sent", async () => {
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Re: Welcome to the mailbox",
      "Date: Mon, 28 Sep 2026 18:00:00 +0000",
      "Message-ID: <reply-1@example.com>",
      "In-Reply-To: <welcome-1@example.com>",
      "References: <parent@example.com> <welcome-1@example.com>",
      "",
      "I wrote back.",
    ].join("\r\n");
    mailboxState.trashSource = [
      "From: Sam <sam@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Re: Welcome to the mailbox",
      "Date: Mon, 28 Sep 2026 19:00:00 +0000",
      "Message-ID: <trashed-reply@example.com>",
      "References: <parent@example.com>",
      "",
      "This reply was trashed.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const [inbox] = await provider.getInboxMessages(5);
    const thread = await provider.getThread(inbox?.threadId || "");

    expect(thread.messages.map((message) => message.subject)).toEqual([
      "Welcome to the mailbox",
      "Re: Welcome to the mailbox",
    ]);
    expect(thread.messages[1]?.textPlain).toContain("I wrote back.");
    expect(
      thread.messages.some((message) => message.textPlain?.includes("trashed")),
    ).toBe(false);
    mailboxState.sentSource = "";
    mailboxState.trashSource = "";
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
    expect(messages[0]?.labelIds).toContain("INBOX");
  });

  it("marks an opened inbox thread as seen", async () => {
    flagsAdded.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    await provider.markRead("<parent@example.com>");

    expect(flagsAdded).toEqual([{ uid: 1, flags: ["\\Seen"] }]);
    expect(mailboxState.opened).toBe("INBOX");
    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
      where: { emailAccountId: "account-1", messageId: { in: ["1"] } },
      data: { read: true },
    });
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

  it("stars a message and moves spam into Junk", async () => {
    flagsAdded.length = 0;
    movedTo.length = 0;
    created.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    await provider.starMessage("1");
    const [message] = await provider.getInboxMessages(5);
    await provider.markSpam(message?.threadId || "");

    expect(flagsAdded).toEqual([{ uid: 1, flags: ["\\Flagged"] }]);
    expect(movedTo).toEqual(["Junk"]);
    expect(created).toContain("Junk");
    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
      where: { emailAccountId: "account-1", messageId: { in: ["1"] } },
      data: { inbox: false },
    });
  });

  it("creates a mailbox and moves a thread into it", async () => {
    movedTo.length = 0;
    created.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    const folderId = await provider.getOrCreateFolderIdByName("Receipts");
    const [message] = await provider.getInboxMessages(5);
    await provider.moveThreadToFolder(
      message?.threadId || "",
      "owner@example.com",
      folderId,
    );

    expect(folderId).toBe("Receipts");
    expect(created).toContain("Receipts");
    expect(movedTo).toEqual(["Receipts"]);
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
    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
      where: { emailAccountId: "account-1", messageId: { in: ["1"] } },
      data: { inbox: false },
    });
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
    expect(prisma.emailMessage.deleteMany).toHaveBeenCalledWith({
      where: { emailAccountId: "account-1", messageId: { in: ["1"] } },
    });
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
    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
      where: { emailAccountId: "account-1", messageId: { in: ["1"] } },
      data: { inbox: false },
    });
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

  it("has no server-side filters", async () => {
    const provider = createImapProvider(imapConfig(), logger);
    await expect(provider.getFiltersList()).resolves.toEqual([]);
  });

  it("archives the sender when a block filter is created", async () => {
    movedTo.length = 0;
    mailboxState.fromUids = [1];
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.createAutoArchiveFilter({
      from: "sam@example.com",
    });

    expect(result).toEqual({ status: 200 });
    expect(movedTo).toEqual(["Archive"]);
    mailboxState.fromUids = [];
  });

  it("clears inbox stats for mail that is no longer in the mailbox", async () => {
    mailboxState.allUids = [4];
    const provider = createImapProvider(imapConfig(), logger);

    await provider.getMessagesWithPagination({ maxResults: 20 });

    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
      where: {
        emailAccountId: "account-1",
        inbox: true,
        messageId: { notIn: ["4"] },
      },
      data: { inbox: false },
    });
    mailboxState.allUids = [];
  });

  it("drops a stored copy that still uses an older thread id", async () => {
    mailboxState.allUids = [1];
    const provider = createImapProvider(imapConfig(), logger);

    await provider.getMessagesWithPagination({ maxResults: 20 });

    expect(prisma.emailMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        emailAccountId: "account-1",
        OR: [
          {
            messageId: "1",
            threadId: { not: "<parent@example.com>" },
          },
        ],
      },
    });
    mailboxState.allUids = [];
  });

  it("stores sent mail so analytics can count it", async () => {
    mailboxState.allUids = [1];
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: A new IMAP message",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <sent-1@example.com>",
      "",
      "Sent from the mailbox.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    await provider.getMessagesWithPagination({ maxResults: 20 });

    expect(prisma.emailMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId_threadId_messageId: {
            emailAccountId: "account-1",
            threadId: "<sent-1@example.com>",
            messageId: "sent:11",
          },
        },
        create: expect.objectContaining({
          from: "owner@example.com",
          to: "sam@example.com",
          sent: true,
          inbox: false,
          read: true,
        }),
      }),
    );
    mailboxState.allUids = [];
    mailboxState.sentSource = "";
  });

  it("lists sent message ids for response-time stats", async () => {
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: digest@example.com",
      "Subject: Re: Please reply",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <reply-1@example.com>",
      "",
      "Sent from the mailbox.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getSentMessageIds({
      maxResults: 10,
      after: new Date("2026-09-01T00:00:00.000Z"),
      before: new Date("2026-09-30T00:00:00.000Z"),
    });

    expect(mailboxState.opened).toBe("Sent");
    expect(result.messages).toEqual([
      { id: "11", threadId: "<reply-1@example.com>" },
    ]);
    expect(result.nextPageToken).toBeUndefined();

    const outsideRange = await provider.getSentMessageIds({
      maxResults: 10,
      after: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(outsideRange.messages).toEqual([]);
    mailboxState.sentSource = "";
  });

  it("includes a sent reply in the thread and archives only the inbox copy", async () => {
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Re: Welcome to the mailbox",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <reply-1@example.com>",
      "In-Reply-To: <parent@example.com>",
      "References: <parent@example.com>",
      "",
      "Replying from Sent.",
    ].join("\r\n");
    movedTo.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    const messages = await provider.getThreadMessages("<parent@example.com>");

    expect(messages.map((message) => message.id).sort()).toEqual(["1", "11"]);

    await provider.archiveThread("<parent@example.com>", "owner@example.com");

    expect(movedTo).toEqual(["Archive"]);
    mailboxState.sentSource = "";
  });

  it("lists a reply stored in Sent", async () => {
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: digest@example.com",
      "Subject: Re: Please reply",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <reply-1@example.com>",
      "In-Reply-To: <please-reply@example.com>",
      "References: <please-reply@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Saving a copy of this reply.</p>",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      query: { type: "sent" },
    });

    expect(mailboxState.opened).toBe("Sent");
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.messages[0]?.subject).toBe("Re: Please reply");
    expect(result.threads[0]?.messages[0]?.textHtml).toContain(
      "<p>Saving a copy of this reply.</p>",
    );
    expect(result.threads[0]?.messages[0]?.snippet).toContain(
      "Saving a copy of this reply.",
    );
    expect(result.threads[0]?.messages[0]?.snippet).not.toContain("<p>");

    const opened = await provider.getThread(result.threads[0]?.id || "");
    expect(opened.messages[0]?.subject).toBe("Re: Please reply");
    mailboxState.sentSource = "";
  });

  it("moves archived mail back from Archive", async () => {
    movedTo.length = 0;
    movedFrom.length = 0;
    mailboxState.archiveSource = [
      "From: Digest <digest@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Morning digest",
      "Date: Mon, 28 Sep 2026 13:00:00 +0000",
      "Message-ID: <digest-1@example.com>",
      "",
      "Your morning digest.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const listed = await provider.getThreadsWithQuery({
      query: { type: "archive" },
    });
    await provider.unarchiveThread(listed.threads[0]?.id || "");

    expect(mailboxState.opened).toBe("Archive");
    expect(listed.threads[0]?.messages[0]?.subject).toBe("Morning digest");
    expect(movedFrom).toEqual(["Archive"]);
    expect(movedTo).toEqual(["INBOX"]);
    mailboxState.archiveSource = "";
  });

  it("moves trashed mail back from Trash", async () => {
    movedTo.length = 0;
    movedFrom.length = 0;
    mailboxState.trashSource = [
      "From: Trash Test <trash@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Please trash this",
      "Date: Mon, 28 Sep 2026 15:00:00 +0000",
      "Message-ID: <trash-me@example.com>",
      "",
      "Please trash this message.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const listed = await provider.getThreadsWithQuery({
      query: { type: "trash" },
    });
    await provider.untrashThread(listed.threads[0]?.id || "");

    expect(movedFrom).toEqual(["Trash"]);
    expect(movedTo).toEqual(["INBOX"]);
    mailboxState.trashSource = "";
  });

  it("restores one trashed message from Trash and one archived message from Archive", async () => {
    movedFrom.length = 0;
    movedTo.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    await provider.untrashMessages(["12"]);
    await provider.unarchiveMessages(["9"]);

    expect(movedFrom).toEqual(["Trash", "Archive"]);
    expect(movedTo).toEqual(["INBOX", "INBOX"]);
  });

  it("lists a saved reply in Drafts", async () => {
    mailboxState.draftSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Re: Welcome to the mailbox",
      "Date: Mon, 28 Sep 2026 16:00:00 +0000",
      "Message-ID: <draft-1@example.com>",
      "In-Reply-To: <welcome-1@example.com>",
      "",
      "Draft reply.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      query: { type: "drafts" },
    });

    expect(mailboxState.opened).toBe("Drafts");
    expect(result.threads[0]?.messages[0]?.subject).toBe(
      "Re: Welcome to the mailbox",
    );

    const opened = await provider.getThread(result.threads[0]?.id || "");
    expect(opened.messages[0]?.textPlain).toContain("Draft reply.");
    mailboxState.draftSource = "";
  });

  it("sends a saved draft and removes it from Drafts", async () => {
    sentMail.length = 0;
    appended.length = 0;
    deleted.length = 0;
    mailboxState.draftSource = savedDraft();
    const provider = createImapProvider(imapConfig(), logger);

    const listed = await provider.getThreadsWithQuery({
      query: { type: "drafts" },
    });
    const sent = await provider.sendDraft(listed.threads[0]?.id || "");

    expect(sent.threadId).toBe(listed.threads[0]?.id);
    expect(sentMail.at(-1)).toMatchObject({
      to: "sam@example.com",
      subject: "Re: Welcome to the mailbox",
      inReplyTo: "<welcome-1@example.com>",
    });
    expect(String(sentMail.at(-1)?.text)).toContain("Draft reply.");
    expect(appended.at(-1)?.mailbox).toBe("Sent");
    expect(String(appended.at(-1)?.raw)).toContain("Draft reply.");
    expect(deleted).toEqual([{ mailbox: "Drafts", uid: 13 }]);
    mailboxState.draftSource = "";
  });

  it("discards a saved draft without sending it", async () => {
    sentMail.length = 0;
    deleted.length = 0;
    mailboxState.draftSource = savedDraft();
    const provider = createImapProvider(imapConfig(), logger);

    const listed = await provider.getThreadsWithQuery({
      query: { type: "drafts" },
    });
    const removed = await provider.deleteDraft(listed.threads[0]?.id || "");

    expect(removed).toBe(true);
    expect(sentMail).toEqual([]);
    expect(deleted).toEqual([{ mailbox: "Drafts", uid: 13 }]);
    mailboxState.draftSource = "";
  });

  it("lists the mailbox named by folder id", async () => {
    const provider = createImapProvider(imapConfig(), logger);

    await provider.getThreadsWithQuery({
      query: { folderId: "Receipts" },
    });

    expect(mailboxState.opened).toBe("Receipts");
  });

  it("lists mail stored in Trash", async () => {
    mailboxState.trashSource = [
      "From: Trash Test <trash@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Please trash this",
      "Date: Mon, 28 Sep 2026 15:00:00 +0000",
      "Message-ID: <trash-me@example.com>",
      "",
      "Please trash this message.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      query: { type: "trash" },
    });

    expect(mailboxState.opened).toBe("Trash");
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.messages[0]?.subject).toBe("Please trash this");

    const opened = await provider.getThread(result.threads[0]?.id || "");
    expect(opened.messages[0]?.textPlain).toContain(
      "Please trash this message.",
    );
    mailboxState.trashSource = "";
  });

  it("returns recent subjects from one sender", async () => {
    const provider = createImapProvider(imapConfig(), logger);
    const threads = await provider.getThreadsFromSenderWithSubject(
      "sam@example.com",
      3,
    );

    expect(threads).toEqual([
      expect.objectContaining({
        subject: "Welcome to the mailbox",
        snippet: expect.stringContaining("The mailbox is ready."),
      }),
    ]);
  });

  it("returns threads from one sender", async () => {
    const provider = createImapProvider(imapConfig(), logger);
    const result = await provider.getThreadsWithQuery({
      query: { fromEmail: "sam@example.com" },
    });

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.messages[0]?.headers.from).toContain(
      "sam@example.com",
    );

    const other = await provider.getThreadsWithQuery({
      query: { fromEmail: "other@example.com" },
    });
    expect(other.threads).toEqual([]);
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

function savedDraft() {
  return [
    "From: Owner <owner@example.com>",
    "To: sam@example.com",
    "Subject: Re: Welcome to the mailbox",
    "Date: Mon, 28 Sep 2026 16:00:00 +0000",
    "Message-ID: <draft-1@example.com>",
    "In-Reply-To: <welcome-1@example.com>",
    "",
    "Draft reply.",
  ].join("\r\n");
}

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
