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
  appended: [] as { mailbox: string; raw: string; flags?: string[] }[],
  flagsRemoved: [] as string[],
  flagsAdded: [] as { uid: number; flags: string[] }[],
  deleted: [] as { mailbox: string; uid: number }[],
  created: [] as string[],
  mailboxState: {
    exists: 1,
    unseen: [] as number[],
    fromUids: [] as number[],
    allUids: [] as number[],
    missingMailboxes: [] as string[],
    inboxSearchUids: [] as number[],
    sentSearchUids: [] as number[],
    listed: [{ path: "INBOX", name: "INBOX" }] as {
      path: string;
      name: string;
    }[],
    opened: "INBOX",
    inboxSource: "",
    connectOptions: null as null | Record<string, unknown>,
    archiveSource: "" as string,
    sentSource: "" as string,
    trashSource: "" as string,
    draftSource: "" as string,
    folderSources: {} as Record<
      string,
      string | { uid: number; source: string }
    >,
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
    async search(query: {
      from?: string;
      to?: string;
      all?: boolean;
      or?: unknown;
    }) {
      if (query?.from) return mailboxState.fromUids;
      if (query?.to) {
        return mailboxState.opened === "Sent"
          ? mailboxState.sentSearchUids
          : [];
      }
      if (query?.all) return mailboxState.allUids;
      if (query?.or) {
        return mailboxState.opened === "Sent"
          ? mailboxState.sentSearchUids
          : mailboxState.inboxSearchUids;
      }
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
      if (mailboxState.missingMailboxes.includes(mailbox)) {
        const error = new Error("Command failed") as Error & {
          mailboxMissing?: boolean;
        };
        error.mailboxMissing = true;
        throw error;
      }
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
      const folderSource = mailboxState.folderSources[mailboxState.opened];
      if (folderSource) {
        const source =
          typeof folderSource === "string" ? folderSource : folderSource.source;
        const uid = typeof folderSource === "string" ? 14 : folderSource.uid;
        yield {
          uid,
          source: Buffer.from(source),
          flags: new Set(["\\Seen"]),
          internalDate: new Date("2026-09-28T17:00:00.000Z"),
        };
        return;
      }
      yield {
        uid: 1,
        source: Buffer.from(mailboxState.inboxSource || rawMessage),
        flags: new Set(["\\Seen"]),
        internalDate: new Date("2026-09-28T12:00:00.000Z"),
      };
    }
    async fetchOne(uid: number) {
      for await (const message of this.fetch()) {
        if (message.uid === uid) return message;
      }
      return false;
    }
    async logout() {}
    async list() {
      return mailboxState.listed;
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
    async append(mailbox: string, raw: string, flags?: string[]) {
      appended.push({ mailbox, raw, flags });
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

  it("opens a message stored only in Junk", async () => {
    mailboxState.folderSources.Junk = [
      "From: Ads <ads@example.com>",
      "To: owner@example.com",
      "Subject: Spam offer",
      "Date: Mon, 28 Sep 2026 17:00:00 +0000",
      "Message-ID: <junk-1@example.com>",
      "",
      "This is spam.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const thread = await provider.getThread("<junk-1@example.com>");

    expect(thread.messages[0]?.subject).toBe("Spam offer");
    expect(thread.messages[0]?.textPlain).toContain("This is spam.");
    mailboxState.folderSources = {};
  });

  it("opens a message stored only in a custom folder", async () => {
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Receipts", name: "Receipts" },
    ];
    mailboxState.folderSources.Receipts = [
      "From: Billing <billing@example.com>",
      "To: owner@example.com",
      "Subject: Receipt",
      "Date: Mon, 28 Sep 2026 17:00:00 +0000",
      "Message-ID: <receipt-1@example.com>",
      "",
      "Amount due.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const thread = await provider.getThread("<receipt-1@example.com>");

    expect(thread.messages[0]?.subject).toBe("Receipt");
    expect(thread.messages[0]?.textPlain).toContain("Amount due.");
    mailboxState.listed = [{ path: "INBOX", name: "INBOX" }];
    mailboxState.folderSources = {};
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

  it("opens a thread that was saved under its subject", async () => {
    mailboxState.archiveSource = [
      "From: Billing <billing@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Rechnung 2026-09",
      "Date: Mon, 28 Sep 2026 13:00:00 +0000",
      "Message-ID: <rechnung-2026-09@example.com>",
      "",
      "Bitte begleiche die Rechnung.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const thread = await provider.getThread("rechnung 2026-09");

    expect(thread.messages.map((message) => message.subject)).toEqual([
      "Rechnung 2026-09",
    ]);
    expect(thread.messages[0]?.id).toBe("Archive/9");
    mailboxState.archiveSource = "";
  });

  it("downloads the attachment from the folder named in the message id", async () => {
    mailboxState.archiveSource = archivedAttachment();
    mailboxState.folderSources.Junk = {
      uid: 9,
      source: archivedAttachment()
        .replace("Subject: File", "Subject: Junk file")
        .replace("Tm90ZQ==", "SnVuaw=="),
    };
    const provider = createImapProvider(imapConfig(), logger);

    const junk = await provider.getAttachment("Junk/9", "9:0");
    const archived = await provider.getAttachment("Archive/9", "9:0");

    expect(Buffer.from(junk.data, "base64").toString("utf8")).toBe("Junk");
    expect(Buffer.from(archived.data, "base64").toString("utf8")).toBe("Note");
    mailboxState.archiveSource = "";
    mailboxState.folderSources = {};
  });

  it("downloads an attachment stored in Archive", async () => {
    mailboxState.archiveSource = archivedAttachment();
    const provider = createImapProvider(imapConfig(), logger);

    const attachment = await provider.getAttachment("9", "9:0");

    expect(Buffer.from(attachment.data, "base64").toString("utf8")).toBe(
      "Note",
    );
    expect(attachment.size).toBe(4);
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

  it("keeps the unsubscribe header from the mailbox message", async () => {
    mailboxState.inboxSource = [
      "From: News <news@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Weekly",
      "Date: Mon, 28 Sep 2026 12:00:00 +0000",
      "Message-ID: <weekly@example.com>",
      "List-Unsubscribe: <https://example.com/unsub>, <mailto:unsub@example.com>",
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      "",
      "The weekly note.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const [message] = await provider.getInboxMessages(1);

    expect(message?.headers["list-unsubscribe"]).toBe(
      "<https://example.com/unsub>, <mailto:unsub@example.com>",
    );
    expect(message?.headers["list-unsubscribe-post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    mailboxState.inboxSource = "";
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
      where: { emailAccountId: "account-1", messageId: { in: ["INBOX/1"] } },
      data: { read: true },
    });
  });

  it("clears the seen flag when an inbox thread is marked unread", async () => {
    flagsRemoved.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    await provider.markReadThread("<parent@example.com>", false);

    expect(flagsRemoved).toEqual(["\\Seen"]);
    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
      where: { emailAccountId: "account-1", messageId: { in: ["INBOX/1"] } },
      data: { read: false },
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

  it("sets the flagged state on the mailbox named in the message id", async () => {
    flagsAdded.length = 0;
    flagsRemoved.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    await provider.markMessagesStarredState(["INBOX/1"], true);
    await provider.markMessagesStarredState(["Junk/3"], false);

    expect(flagsAdded).toEqual([{ uid: 1, flags: ["\\Flagged"] }]);
    expect(flagsRemoved).toEqual(["\\Flagged"]);
    expect(mailboxState.opened).toBe("Junk");
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
      where: { emailAccountId: "account-1", messageId: { in: ["INBOX/1"] } },
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

  it("removes every label keyword from a thread", async () => {
    flagsRemoved.length = 0;
    const provider = createImapProvider(imapConfig(), logger);
    const [message] = await provider.getInboxMessages(5);
    if (!message) throw new Error("Missing message");

    await provider.removeThreadLabels(message.threadId, [
      "Rechnungen",
      "Newsletter",
    ]);

    expect(flagsRemoved).toEqual(["Rechnungen", "Newsletter"]);
  });

  it("has no provider signature or contact list", async () => {
    const provider = createImapProvider(imapConfig(), logger);

    await expect(provider.getSignatures()).resolves.toEqual([]);
    await expect(provider.searchContacts("ada")).resolves.toEqual([]);
  });

  it("removes a label keyword from a thread", async () => {
    flagsRemoved.length = 0;
    const provider = createImapProvider(imapConfig(), logger);
    const [message] = await provider.getInboxMessages(5);
    if (!message) throw new Error("Missing message");

    await provider.removeThreadLabel(message.threadId, "Rechnungen");

    expect(flagsRemoved).toEqual(["Rechnungen"]);
  });

  it("lists no sender labels when none are saved", async () => {
    prisma.rule.findMany.mockResolvedValue([]);
    const provider = createImapProvider(imapConfig(), logger);
    await expect(provider.getFiltersList()).resolves.toEqual([]);
  });

  it("saves a sender label and can remove it again", async () => {
    prisma.rule.upsert.mockResolvedValue({ id: "rule-1" } as never);
    prisma.rule.findMany.mockResolvedValue([
      {
        id: "rule-1",
        from: "ads@example.com",
        actions: [{ labelId: "Receipt" }],
      },
    ] as never);
    prisma.rule.findFirst.mockResolvedValue({ id: "rule-1" } as never);
    prisma.rule.delete.mockResolvedValue({ id: "rule-1" } as never);
    const provider = createImapProvider(imapConfig(), logger);

    await expect(
      provider.createFilter({
        from: "Ads <ads@example.com>",
        addLabelIds: ["Receipt"],
      }),
    ).resolves.toEqual({ status: 200 });
    await expect(provider.getFiltersList()).resolves.toEqual([
      {
        id: "rule-1",
        criteria: { from: "ads@example.com" },
        action: { addLabelIds: ["Receipt"] },
      },
    ]);
    await expect(provider.deleteFilter("rule-1")).resolves.toEqual({
      status: 200,
    });

    expect(prisma.rule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          emailAccountId: "account-1",
          from: "ads@example.com",
          actions: {
            create: expect.objectContaining({
              labelId: "Receipt",
            }),
          },
        }),
      }),
    );
    expect(prisma.rule.delete).toHaveBeenCalledWith({
      where: { id: "rule-1" },
    });
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

  it("finds an archived message that matches the search", async () => {
    mailboxState.archiveSource = [
      "From: Sam <sam@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Please trash this",
      "Date: Mon, 28 Sep 2026 13:00:00 +0000",
      "Message-ID: <trash-me@example.com>",
      "",
      "This copy lives in Archive.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const inbox = await provider.getMessagesWithPagination({ maxResults: 20 });
    const listed = await provider.getMessagesWithPagination({
      query: "",
      maxResults: 20,
    });
    const found = await provider.getMessagesWithPagination({
      query: "Please trash",
      maxResults: 20,
    });

    expect(inbox.messages.map((message) => message.id)).toEqual(["INBOX/1"]);
    expect(listed.messages.map((message) => message.subject)).toEqual([
      "Please trash this",
      "Welcome to the mailbox",
    ]);
    expect(found.messages.map((message) => message.subject)).toEqual([
      "Please trash this",
    ]);
    expect(found.messages[0]?.id).toBe("Archive/9");
    mailboxState.archiveSource = "";
  });

  it("clears inbox stats for mail that is no longer in the mailbox", async () => {
    mailboxState.allUids = [4];
    const provider = createImapProvider(imapConfig(), logger);

    await provider.getMessagesWithPagination({ maxResults: 20 });

    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
      where: {
        emailAccountId: "account-1",
        inbox: true,
        messageId: { notIn: ["INBOX/4"] },
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
            messageId: "INBOX/1",
            threadId: { not: "<parent@example.com>" },
          },
        ],
      },
    });
    mailboxState.allUids = [];
  });

  it("loads inbox stats when the account has no Sent folder", async () => {
    const errors: unknown[] = [];
    const warnings: unknown[] = [];
    const recordingLogger = {
      info: () => undefined,
      warn: (message: unknown) => {
        warnings.push(message);
      },
      error: (message: unknown) => {
        errors.push(message);
      },
      trace: () => undefined,
      child: () => recordingLogger,
    } as unknown as Logger;
    mailboxState.missingMailboxes = [
      "Sent",
      "Sent Items",
      "[Gmail]/Sent Mail",
      "Archive",
      "Trash",
      "Drafts",
    ];
    const provider = createImapProvider(imapConfig(), recordingLogger);

    const page = await provider.getMessagesWithPagination({ maxResults: 20 });
    const [inboxMessage] = await provider.getInboxMessages(5);
    if (!inboxMessage) throw new Error("Missing message");
    const thread = await provider.getThread(inboxMessage.threadId);

    expect(page.messages.map((message) => message.id)).toEqual(["INBOX/1"]);
    expect(thread.messages.map((message) => message.id)).toEqual(["INBOX/1"]);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    mailboxState.missingMailboxes = [];
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
      { id: "Sent/11", threadId: "<reply-1@example.com>" },
    ]);
    expect(result.nextPageToken).toBeUndefined();

    const outsideRange = await provider.getSentMessageIds({
      maxResults: 10,
      after: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(outsideRange.messages).toEqual([]);
    mailboxState.sentSource = "";
  });

  it("treats earlier company-domain mail as prior contact and ignores the open message", async () => {
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Sent", name: "Sent" },
    ];
    mailboxState.inboxSearchUids = [1];
    mailboxState.sentSearchUids = [11];
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: billing@acme.example",
      "Subject: Invoice question",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <invoice-question@example.com>",
      "",
      "Earlier mail to the company.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const earlierCompanyMail =
      await provider.hasPreviousCommunicationsWithSenderOrDomain({
        from: "introducer@acme.example",
        date: new Date("2026-09-28T15:00:00.000Z"),
        messageId: "1",
      });
    mailboxState.sentSearchUids = [];
    const onlyTheOpenMessage =
      await provider.hasPreviousCommunicationsWithSenderOrDomain({
        from: "sam@example.com",
        date: new Date("2026-09-28T13:00:00.000Z"),
        messageId: "1",
      });

    expect(earlierCompanyMail).toBe(true);
    expect(onlyTheOpenMessage).toBe(false);
    mailboxState.sentSource = "";
    mailboxState.inboxSearchUids = [];
    mailboxState.sentSearchUids = [];
    mailboxState.listed = [{ path: "INBOX", name: "INBOX" }];
  });

  it("matches a public-email sender by the full address", async () => {
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Sent", name: "Sent" },
    ];
    mailboxState.sentSearchUids = [11];
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: mutual.contact@gmail.com",
      "Subject: Re: Hello",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <hello-reply@example.com>",
      "",
      "Earlier reply.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const samePerson =
      await provider.hasPreviousCommunicationsWithSenderOrDomain({
        from: "mutual.contact@gmail.com",
        date: new Date("2026-09-28T15:00:00.000Z"),
        messageId: "1",
      });
    const differentPerson =
      await provider.hasPreviousCommunicationsWithSenderOrDomain({
        from: "other.person@gmail.com",
        date: new Date("2026-09-28T15:00:00.000Z"),
        messageId: "1",
      });

    expect(samePerson).toBe(true);
    expect(differentPerson).toBe(false);
    mailboxState.sentSource = "";
    mailboxState.sentSearchUids = [];
    mailboxState.listed = [{ path: "INBOX", name: "INBOX" }];
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

    expect(messages.map((message) => message.id).sort()).toEqual([
      "INBOX/1",
      "Sent/11",
    ]);

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

  it("finds a saved draft by its message so the view can discard it", async () => {
    mailboxState.draftSource = savedDraft();
    const provider = createImapProvider(imapConfig(), logger);

    const listed = await provider.getThreadsWithQuery({
      query: { type: "drafts" },
    });
    const message = listed.threads[0]?.messages[0];
    if (!message) throw new Error("Missing draft");

    const byMessage = await provider.getDraft(message.id);
    const byThread = await provider.getDraft(message.threadId);
    const reference = await provider.getDraftReferenceForMessage(message.id);

    expect(byMessage?.id).toBe(message.id);
    expect(byThread?.textPlain).toContain("Draft reply.");
    expect(reference).toEqual({ id: message.id });
    await expect(provider.getDraft("missing-draft")).resolves.toBeNull();
    await expect(
      provider.getDraftReferenceForMessage("missing-draft"),
    ).resolves.toBeNull();

    mailboxState.missingMailboxes = ["Drafts"];
    await expect(provider.getDraft(message.id)).resolves.toBeNull();
    mailboxState.missingMailboxes = [];
    mailboxState.draftSource = "";
  });

  it("saves a new message as a draft and can replace that draft", async () => {
    appended.length = 0;
    deleted.length = 0;
    mailboxState.draftSource = "";
    const provider = createImapProvider(imapConfig(), logger);

    const created = await provider.createDraft({
      to: "",
      subject: "Note to send",
      messageHtml: "<p>Hold this</p>",
    });

    expect(created.id).toMatch(/^<imap-draft-.+@example\.com>$/);
    expect(appended[0]?.mailbox).toBe("Drafts");
    expect(appended[0]?.flags).toEqual(["\\Draft"]);
    expect(appended[0]?.raw).toContain(`Message-ID: ${created.id}`);
    expect(appended[0]?.raw).toContain("Subject: Note to send");
    expect(appended[0]?.raw).toContain("<p>Hold this</p>");

    mailboxState.draftSource = savedDraft();
    await provider.updateDraft("<draft-1@example.com>", {
      to: "sam@example.com",
      cc: "copy@example.com",
      subject: "Updated note",
      messageHtml: "<p>Changed</p>",
    });

    expect(deleted).toEqual([{ mailbox: "Drafts", uid: 13 }]);
    const replacement = appended.at(-1);
    expect(replacement?.mailbox).toBe("Drafts");
    expect(replacement?.raw).toContain("Message-ID: <draft-1@example.com>");
    expect(replacement?.raw).toContain("In-Reply-To: <welcome-1@example.com>");
    expect(replacement?.raw).toContain("To: sam@example.com");
    expect(replacement?.raw).toContain("Cc: copy@example.com");
    expect(replacement?.raw).toContain("Subject: Updated note");
    expect(replacement?.raw).toContain("<p>Changed</p>");
    await expect(
      provider.getDraft("<draft-1@example.com>"),
    ).resolves.toMatchObject({
      id: "Drafts/13",
    });
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

  it("detects a sent reply and counts mail from that sender", async () => {
    mailboxState.sentSearchUids = [11];
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Re: Welcome",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <reply-sam@example.com>",
      "",
      "Replying to Sam.",
    ].join("\r\n");
    mailboxState.fromUids = [1];
    const provider = createImapProvider(imapConfig(), logger);

    await expect(provider.checkIfReplySent("sam@example.com")).resolves.toBe(
      true,
    );
    await expect(provider.checkIfReplySent("other@example.com")).resolves.toBe(
      false,
    );
    await expect(
      provider.countReceivedMessages("sam@example.com", 5),
    ).resolves.toBe(1);
    await expect(
      provider.countReceivedMessages("other@example.com", 5),
    ).resolves.toBe(0);

    mailboxState.sentSearchUids = [];
    mailboxState.sentSource = "";
    mailboxState.fromUids = [];
  });

  it("returns messages from one sender and skips a different address", async () => {
    mailboxState.fromUids = [1];
    const provider = createImapProvider(imapConfig(), logger);

    const matched = await provider.getMessagesFromSender({
      senderEmail: "sam@example.com",
      maxResults: 5,
    });
    const differentSender = await provider.getMessagesFromSender({
      senderEmail: "other@example.com",
      maxResults: 5,
    });
    const olderThanTheMessage = await provider.getMessagesFromSender({
      senderEmail: "sam@example.com",
      before: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(matched.messages.map((message) => message.id)).toEqual(["INBOX/1"]);
    expect(matched.messages[0]?.headers.from).toContain("sam@example.com");
    expect(differentSender.messages).toEqual([]);
    expect(olderThanTheMessage.messages).toEqual([]);
    mailboxState.fromUids = [];
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

function archivedAttachment() {
  return [
    "From: Ads <ads@example.com>",
    "To: owner@example.com",
    "Subject: File",
    "Date: Mon, 28 Sep 2026 18:00:00 +0000",
    "Message-ID: <file@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="bound"',
    "",
    "--bound",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See attached.",
    "--bound",
    'Content-Type: text/plain; name="note.txt"',
    'Content-Disposition: attachment; filename="note.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    "Tm90ZQ==",
    "--bound--",
    "",
  ].join("\r\n");
}

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
