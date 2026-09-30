import { describe, expect, it, vi } from "vitest";
import PostalMime from "postal-mime";
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
    folderDateUids: {} as Record<string, number[]>,
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
    connectError: null as string | null,
    archiveSource: "" as string,
    archiveMessages: [] as {
      uid: number;
      source: string;
      flags: string[];
      internalDate: string;
    }[],
    sentSource: "" as string,
    sentMessages: [] as {
      uid: number;
      source: string;
      flags: string[];
      internalDate: string;
    }[],
    trashSource: "" as string,
    draftSource: "" as string,
    draftMessages: [] as {
      uid: number;
      source: string;
      flags: string[];
      internalDate: string;
    }[],
    folderSources: {} as Record<
      string,
      string | { uid: number; source: string }
    >,
    inboxMessages: [] as {
      uid: number;
      source: string;
      flags: string[];
      internalDate: string;
    }[],
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
      since?: Date;
      before?: Date;
      seen?: boolean;
      text?: string;
      keyword?: string;
      header?: Record<string, string>;
    }) {
      if (query?.from) {
        if (
          mailboxState.inboxMessages.length &&
          (query.since || query.before || query.seen === false)
        ) {
          return mailboxState.inboxMessages
            .filter((message) => {
              if (
                (query.since || query.before) &&
                !imapDateMatches(message, query)
              ) {
                return false;
              }
              if (query.seen === false && message.flags.includes("\\Seen")) {
                return false;
              }
              return true;
            })
            .map((message) => message.uid);
        }
        return mailboxState.fromUids;
      }
      if (query?.to) {
        if (mailboxState.opened !== "Sent") return [];
        if (mailboxState.sentMessages.length) {
          return sentUidsWithHeader(mailboxState.sentMessages, "To", query.to);
        }
        return mailboxState.sentSearchUids;
      }
      if (query?.all) {
        const folderUids = mailboxState.folderDateUids[mailboxState.opened];
        if (folderUids) return folderUids;
        return mailboxState.allUids;
      }
      if (query?.or) {
        if (mailboxState.opened !== "Sent") {
          if (mailboxState.inboxMessages.length && Array.isArray(query.or)) {
            return mailboxState.inboxMessages
              .filter((message) =>
                query.or?.some((clause) => {
                  if (!clause || typeof clause !== "object") return false;
                  const record = clause as {
                    to?: string;
                    cc?: string;
                    bcc?: string;
                    from?: string;
                  };
                  if (
                    record.to &&
                    headerLineIncludes(message.source, "To", record.to)
                  ) {
                    return true;
                  }
                  if (
                    record.cc &&
                    headerLineIncludes(message.source, "Cc", record.cc)
                  ) {
                    return true;
                  }
                  if (
                    record.bcc &&
                    headerLineIncludes(message.source, "Bcc", record.bcc)
                  ) {
                    return true;
                  }
                  if (
                    record.from &&
                    headerLineIncludes(message.source, "From", record.from)
                  ) {
                    return true;
                  }
                  return false;
                }),
              )
              .map((message) => message.uid);
          }
          return mailboxState.inboxSearchUids;
        }
        if (mailboxState.sentMessages.length && Array.isArray(query.or)) {
          return mailboxState.sentMessages
            .filter((message) =>
              query.or?.some((clause) => {
                if (!clause || typeof clause !== "object") return false;
                const record = clause as {
                  to?: string;
                  cc?: string;
                  bcc?: string;
                  from?: string;
                };
                if (
                  record.to &&
                  headerLineIncludes(message.source, "To", record.to)
                ) {
                  return true;
                }
                if (
                  record.cc &&
                  headerLineIncludes(message.source, "Cc", record.cc)
                ) {
                  return true;
                }
                if (
                  record.bcc &&
                  headerLineIncludes(message.source, "Bcc", record.bcc)
                ) {
                  return true;
                }
                if (
                  record.from &&
                  headerLineIncludes(message.source, "From", record.from)
                ) {
                  return true;
                }
                return false;
              }),
            )
            .map((message) => message.uid);
        }
        return mailboxState.sentSearchUids;
      }
      if (query?.since || query?.before) {
        const folderUids = mailboxState.folderDateUids[mailboxState.opened];
        if (folderUids) return folderUids;
        const opened = sourcesForOpenedMailbox();
        const pool = opened.length ? opened : inboxMessagesForSearch();
        return pool
          .filter((message) => imapDateMatches(message, query))
          .map((message) => message.uid);
      }
      if (query?.seen === false) {
        if (
          mailboxState.opened === "Sent" &&
          mailboxState.sentMessages.length
        ) {
          return mailboxState.sentMessages
            .filter((message) => !message.flags.includes("\\Seen"))
            .map((message) => message.uid);
        }
        if (mailboxState.inboxMessages.length) {
          return mailboxState.inboxMessages
            .filter((message) => !message.flags.includes("\\Seen"))
            .map((message) => message.uid);
        }
        return mailboxState.unseen;
      }
      if (query?.text) {
        const needle = query.text.toLowerCase();
        return sourcesForOpenedMailbox()
          .filter((message) => message.source.toLowerCase().includes(needle))
          .map((message) => message.uid);
      }
      if (query?.header && typeof query.header === "object") {
        const value = Object.values(query.header).find(
          (item) => typeof item === "string",
        );
        if (typeof value !== "string") return [];
        const needle = value.toLowerCase().replace(/^<|>$/g, "");
        return sourcesForOpenedMailbox()
          .filter((message) => message.source.toLowerCase().includes(needle))
          .map((message) => message.uid);
      }
      if (query?.keyword) {
        const keyword = query.keyword.toLowerCase();
        return sourcesForOpenedMailbox()
          .filter((message) =>
            message.flags.some((flag) => flag.toLowerCase() === keyword),
          )
          .map((message) => message.uid);
      }
      return mailboxState.unseen;
    }
    async messageFlagsRemove(_uid: number, flags: string[]) {
      flagsRemoved.push(...flags);
    }
    async messageFlagsAdd(uid: number, flags: string[]) {
      flagsAdded.push({ uid, flags: [...flags] });
    }
    async connect() {
      if (mailboxState.connectError) {
        throw new Error(mailboxState.connectError);
      }
    }
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
    async *fetch(
      range?: string,
      _query?: unknown,
      options?: { uid?: boolean },
    ) {
      if (
        mailboxState.opened === "INBOX" &&
        mailboxState.inboxMessages.length
      ) {
        const wanted = fetchTargets(
          range,
          mailboxState.inboxMessages,
          options?.uid === true,
        );
        for (const message of mailboxState.inboxMessages) {
          if (!wanted.has(message.uid)) continue;
          yield {
            uid: message.uid,
            source: Buffer.from(message.source),
            flags: new Set(message.flags),
            internalDate: new Date(message.internalDate),
          };
        }
        return;
      }
      if (mailboxState.opened === "Archive") {
        if (mailboxState.archiveMessages.length) {
          const wanted = fetchTargets(
            range,
            mailboxState.archiveMessages,
            options?.uid === true,
          );
          for (const message of mailboxState.archiveMessages) {
            if (!wanted.has(message.uid)) continue;
            yield {
              uid: message.uid,
              source: Buffer.from(message.source),
              flags: new Set(message.flags),
              internalDate: new Date(message.internalDate),
            };
          }
          return;
        }
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
        if (mailboxState.sentMessages.length) {
          const wanted = fetchTargets(
            range,
            mailboxState.sentMessages,
            options?.uid === true,
          );
          for (const message of mailboxState.sentMessages) {
            if (!wanted.has(message.uid)) continue;
            yield {
              uid: message.uid,
              source: Buffer.from(message.source),
              flags: new Set(message.flags),
              internalDate: new Date(message.internalDate),
            };
          }
          return;
        }
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
        if (mailboxState.draftMessages.length) {
          const wanted = fetchTargets(
            range,
            mailboxState.draftMessages,
            options?.uid === true,
          );
          for (const message of mailboxState.draftMessages) {
            if (!wanted.has(message.uid)) continue;
            yield {
              uid: message.uid,
              source: Buffer.from(message.source),
              flags: new Set(message.flags),
              internalDate: new Date(message.internalDate),
            };
          }
          return;
        }
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
      if (mailboxState.opened !== "INBOX") return;
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
  it("reports a failed connection instead of the raw network error", async () => {
    mailboxState.connectError = "getaddrinfo ENOTFOUND mail.example.com";
    try {
      const provider = createImapProvider(imapConfig(), logger);
      await expect(provider.getInboxMessages()).rejects.toThrow(
        "IMAP connection failed. Check host, port, TLS, and credentials.",
      );
    } finally {
      mailboxState.connectError = null;
    }
  });

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

  it("gives outgoing mail a Message-ID the other person can answer", async () => {
    sentMail.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    await provider.sendEmailWithHtml({
      to: "sam@example.com",
      subject: "Hello",
      messageHtml: "<p>Hi</p>",
    });
    await provider.sendEmail({
      to: "sam@example.com",
      subject: "Hello",
      messageText: "Hi",
    });

    for (const message of sentMail) {
      expect(message.messageId).toMatch(/^<[^<>\s@]+@[^<>\s@]+>$/);
    }
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

  it("keeps the earlier message on a reply's references", async () => {
    sentMail.length = 0;
    appended.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    await provider.sendEmailWithHtml({
      to: "sam@example.com",
      subject: "Re: Please keep this",
      messageHtml: "<p>Thanks</p>",
      replyToEmail: {
        threadId: "<older@example.com>",
        headerMessageId: "<please-keep@example.com>",
        references: "<older@example.com>",
      },
    });

    expect(sentMail[0]).toMatchObject({
      inReplyTo: "<please-keep@example.com>",
      references: "<older@example.com> <please-keep@example.com>",
    });
    expect(appended[0]?.raw).toContain(
      "References: <older@example.com> <please-keep@example.com>",
    );
  });

  it("sends mail with the account display name", async () => {
    sentMail.length = 0;
    appended.length = 0;
    const provider = createImapProvider(
      { ...imapConfig(), displayName: "Starttls" },
      logger,
    );

    await provider.sendEmailWithHtml({
      to: "sam@example.com",
      subject: "Hello",
      messageHtml: "<p>Hi</p>",
    });

    expect(sentMail[0]?.from).toBe("Starttls <owner@example.com>");
    expect(appended[0]?.raw).toContain("From: Starttls <owner@example.com>");
  });

  it("replies to the sender on the same conversation", async () => {
    sentMail.length = 0;
    appended.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    await provider.replyToEmail(replySource(), "Thanks");

    expect(sentMail[0]).toMatchObject({
      to: "Sam <sam@example.com>",
      subject: "Re: Please keep this",
      inReplyTo: "<please-keep@example.com>",
      references: "<older@example.com> <please-keep@example.com>",
    });
    const parsed = await new PostalMime().parse(String(appended[0]?.raw));
    expect(parsed.inReplyTo).toBe("<please-keep@example.com>");
    expect(parsed.html).toContain("Thanks");
    expect(parsed.html).toContain("Please keep this note.");
  });

  it("replies to the other person when the message was sent by the account", async () => {
    sentMail.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    await provider.replyToEmail(
      replySource({
        from: "Starttls <owner@example.com>",
        to: "Sam <sam@example.com>",
        labelIds: ["SENT"],
        subject: "Re: Please keep this",
      }),
      "Following up",
    );

    expect(sentMail[0]).toMatchObject({
      to: "Sam <sam@example.com>",
      subject: "Re: Please keep this",
    });
  });

  it("keeps a file on a rule reply", async () => {
    sentMail.length = 0;
    appended.length = 0;
    const provider = createImapProvider(imapConfig(), logger);
    const content = Buffer.from("hello file").toString("base64");

    await provider.replyToEmail(replySource(), "See attached", {
      attachments: [
        { filename: "note.txt", content, contentType: "text/plain" },
      ],
    });

    expect(sentMail[0]?.attachments).toEqual([
      expect.objectContaining({
        filename: "note.txt",
        content,
        contentType: "text/plain",
      }),
    ]);
    const parsed = await new PostalMime().parse(String(appended[0]?.raw));
    expect(parsed.attachments?.[0]?.filename).toBe("note.txt");
  });

  it("forwards the stored message when a rule only has the message id", async () => {
    sentMail.length = 0;
    appended.length = 0;
    mailboxState.inboxMessages = [
      {
        uid: 22,
        source: [
          "From: Sam <sam@example.com>",
          "To: Starttls <owner@example.com>",
          "Subject: Please keep this",
          "Date: Mon, 01 Sep 2026 12:05:00 +0000",
          "Message-ID: <please-keep@example.com>",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="bound"',
          "",
          "--bound",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Please keep this note.",
          "--bound",
          'Content-Type: text/plain; name="note.txt"',
          'Content-Disposition: attachment; filename="note.txt"',
          "Content-Transfer-Encoding: base64",
          "",
          "aGVsbG8gZmlsZQ==",
          "--bound--",
          "",
        ].join("\r\n"),
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:05:00.000Z",
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      await provider.forwardEmail(
        {
          id: "INBOX/22",
          threadId: "<please-keep@example.com>",
          historyId: "",
          inline: [],
          snippet: "",
          subject: "Please keep this",
          date: "Mon, 01 Sep 2026 12:05:00 +0000",
          headers: {
            from: "Sam <sam@example.com>",
            to: "Starttls <owner@example.com>",
            subject: "Please keep this",
            date: "Mon, 01 Sep 2026 12:05:00 +0000",
          },
        },
        {
          to: "ada@example.com",
          content: "FYI",
          from: "Starttls <owner@example.com>",
        },
      );
    } finally {
      mailboxState.inboxMessages = [];
    }

    expect(sentMail[0]).toMatchObject({
      to: "ada@example.com",
      from: "Starttls <owner@example.com>",
      subject: "Fwd: Please keep this",
    });
    expect(sentMail[0]?.attachments).toEqual([
      expect.objectContaining({ filename: "note.txt" }),
    ]);
    const parsed = await new PostalMime().parse(String(appended[0]?.raw));
    expect(parsed.subject).toBe("Fwd: Please keep this");
    expect(parsed.html).toContain("FYI");
    expect(parsed.html).toContain("Please keep this note.");
    expect(parsed.attachments?.[0]?.filename).toBe("note.txt");
  });

  it("keeps an attachment on the sent IMAP copy", async () => {
    sentMail.length = 0;
    appended.length = 0;
    const provider = createImapProvider(imapConfig(), logger);
    const content = Buffer.from("hello file").toString("base64");

    await provider.sendEmailWithHtml({
      to: "sam@example.com",
      subject: "Notes",
      messageHtml: "<p>See attached</p>",
      attachments: [
        { filename: "note.txt", content, contentType: "text/plain" },
      ],
    });

    expect(sentMail[0]?.attachments).toEqual([
      expect.objectContaining({
        filename: "note.txt",
        content,
        contentType: "text/plain",
      }),
    ]);
    const parsed = await new PostalMime().parse(String(appended[0]?.raw));
    expect(parsed.html).toContain("See attached");
    expect(parsed.attachments?.[0]?.filename).toBe("note.txt");
    expect(Buffer.from(parsed.attachments?.[0]?.content || []).toString()).toBe(
      "hello file",
    );
  });

  it("keeps an inline image attached to the message it was inserted in", async () => {
    sentMail.length = 0;
    appended.length = 0;
    const provider = createImapProvider(imapConfig(), logger);
    const content = Buffer.from("hello image").toString("base64");

    await provider.sendEmailWithHtml({
      to: "sam@example.com",
      subject: "Photo",
      messageHtml: '<p>See <img src="cid:photo@inboxzero.local"></p>',
      attachments: [
        {
          filename: "photo.png",
          content,
          contentType: "image/png",
          disposition: "inline",
          contentId: "photo@inboxzero.local",
        },
      ],
    });

    expect(sentMail[0]?.attachments).toEqual([
      expect.objectContaining({
        filename: "photo.png",
        content,
        cid: "photo@inboxzero.local",
        contentDisposition: "inline",
      }),
    ]);
    const parsed = await new PostalMime().parse(String(appended[0]?.raw));
    expect(parsed.attachments?.[0]).toMatchObject({
      filename: "photo.png",
      disposition: "inline",
      contentId: "<photo@inboxzero.local>",
    });
  });

  it("keeps a file on the sent copy when a rule sends mail", async () => {
    sentMail.length = 0;
    appended.length = 0;
    const provider = createImapProvider(imapConfig(), logger);

    await provider.sendEmail({
      to: "sam@example.com",
      subject: "Notes",
      messageText: "See attached",
      attachments: [
        {
          filename: "note.txt",
          content: Buffer.from("hello file"),
          contentType: "text/plain",
        },
      ],
    });

    expect(sentMail[0]?.attachments).toEqual([
      expect.objectContaining({ filename: "note.txt" }),
    ]);
    const parsed = await new PostalMime().parse(String(appended[0]?.raw));
    expect(parsed.text).toContain("See attached");
    expect(parsed.attachments?.[0]?.filename).toBe("note.txt");
    expect(Buffer.from(parsed.attachments?.[0]?.content || []).toString()).toBe(
      "hello file",
    );
  });

  it("lists mail when the server arrival time cannot be parsed", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 5,
        source: [
          "From: Sam <sam@example.com>",
          "To: owner@example.com",
          "Subject: Broken arrival",
          "Date: Mon, 28 Sep 2026 12:00:00 +0000",
          "Message-ID: <broken-arrival@example.com>",
          "",
          "Still listed.",
        ].join("\r\n"),
        flags: ["\\Seen"],
        internalDate: "not-a-date",
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const [message] = await provider.getInboxMessages(5);
      expect(message?.subject).toBe("Broken arrival");
      expect(message?.headers.date).toBe("2026-09-28T12:00:00.000Z");
      expect(message?.snippet).toContain("Still listed.");
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("keeps the rest of the inbox when one message cannot be read", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 2;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        source: nestedMimeMessage(),
        flags: ["\\Seen"],
        internalDate: "2026-09-28T12:00:00.000Z",
      },
      {
        uid: 2,
        source: [
          "From: Sam <sam@example.com>",
          "To: owner@example.com",
          "Subject: Please keep this",
          "Date: Mon, 28 Sep 2026 12:05:00 +0000",
          "Message-ID: <please-keep@example.com>",
          "",
          "Please keep this note.",
        ].join("\r\n"),
        flags: ["\\Seen"],
        internalDate: "2026-09-28T12:05:00.000Z",
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const messages = await provider.getInboxMessages(5);
      expect(messages.map((message) => message.subject)).toEqual([
        "Please keep this",
      ]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("lists mail when the Date header cannot be parsed", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 4,
        source: [
          "From: Sam <sam@example.com>",
          "To: owner@example.com",
          "Subject: Broken date",
          "Date: not a date",
          "Message-ID: <broken-date@example.com>",
          "",
          "Still readable.",
        ].join("\r\n"),
        flags: ["\\Seen"],
        internalDate: "2026-09-28T12:00:00.000Z",
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const [message] = await provider.getInboxMessages(5);
      expect(message?.subject).toBe("Broken date");
      expect(message?.headers.date).toBe("2026-09-28T12:00:00.000Z");
      expect(message?.snippet).toContain("Still readable.");
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("keeps a file on a rule draft", async () => {
    appended.length = 0;
    const provider = createImapProvider(imapConfig(), logger);
    const [message] = await provider.getInboxMessages(5);
    if (!message) throw new Error("Missing message");

    await provider.draftEmail(
      message,
      {
        content: "Thanks, I will reply.",
        attachments: [
          {
            filename: "note.txt",
            content: Buffer.from("hello file"),
            contentType: "text/plain",
          },
        ],
      },
      "owner@example.com",
    );

    const parsed = await new PostalMime().parse(String(appended[0]?.raw));
    expect(parsed.html).toContain("Thanks, I will reply.");
    expect(parsed.attachments?.[0]?.filename).toBe("note.txt");
    expect(Buffer.from(parsed.attachments?.[0]?.content || []).toString()).toBe(
      "hello file",
    );
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

  it("keeps two different emails that reuse one message id", async () => {
    mailboxState.archiveMessages = [
      {
        uid: 3,
        flags: [],
        internalDate: "2026-09-28T16:30:00.000Z",
        source: [
          "From: billing@example.com",
          "To: owner@example.com",
          "Subject: Rechnung 2026-09",
          "Date: Mon, 28 Sep 2026 16:30:00 +0000",
          "Message-ID: <rechnung-2026-09@example.com>",
          "",
          "Bitte die Rechnung begleichen.",
        ].join("\r\n"),
      },
      {
        uid: 7,
        flags: ["\\Seen", "FYI"],
        internalDate: "2026-09-28T19:40:00.000Z",
        source: [
          "From: Billing <billing@example.com>",
          "To: owner@example.com",
          "Subject: Rechnung 2026-09",
          "Date: Mon, 28 Sep 2026 19:40:00 +0000",
          "Message-ID: <rechnung-2026-09@example.com>",
          "",
          "Bitte begleiche die Rechnung.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    const thread = await provider.getThread("<rechnung-2026-09@example.com>");

    expect(thread.messages.map((message) => message.textPlain?.trim())).toEqual(
      ["Bitte die Rechnung begleichen.", "Bitte begleiche die Rechnung."],
    );
    mailboxState.archiveMessages = [];
  });

  it("shows one copy when the same email is stored in two folders", async () => {
    const source = [
      "From: Sam <sam@example.com>",
      "To: owner@example.com",
      "Subject: Please keep this",
      "Date: Mon, 01 Sep 2026 12:05:00 +0000",
      "Message-ID: <please-keep@example.com>",
      "",
      "Please keep this note.",
    ].join("\r\n");
    mailboxState.inboxSource = source;
    mailboxState.archiveSource = source;
    const provider = createImapProvider(imapConfig(), logger);

    const thread = await provider.getThread("<please-keep@example.com>");

    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]?.textPlain).toContain("Please keep this note.");
    mailboxState.inboxSource = "";
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
    expect(thread.messages[0]?.labelIds).toContain("INBOX");
    expect(thread.messages[1]?.labelIds).toContain("SENT");
    expect(
      thread.messages.some((message) => message.textPlain?.includes("trashed")),
    ).toBe(false);
    mailboxState.sentSource = "";
    mailboxState.trashSource = "";
  });

  it("opens a conversation in the order of the date on the mail when that mail arrived later", async () => {
    mailboxState.inboxMessages = [
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: sam@example.com",
          "Subject: Written later",
          "Date: Tue, 29 Sep 2026 12:00:00 +0000",
          "Message-ID: <written-later@example.com>",
          "In-Reply-To: <written-earlier@example.com>",
          "References: <written-earlier@example.com>",
          "",
          "This was written later.",
        ].join("\r\n"),
      },
      {
        uid: 8,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T12:00:00.000Z",
        source: [
          "From: Sam <sam@example.com>",
          "To: owner@example.com",
          "Subject: Written earlier",
          "Date: Tue, 01 Sep 2026 12:00:00 +0000",
          "Message-ID: <written-earlier@example.com>",
          "",
          "This was written earlier.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    const thread = await provider.getThread("<written-earlier@example.com>");

    expect(thread.messages.map((message) => message.subject)).toEqual([
      "Written earlier",
      "Written later",
    ]);
    mailboxState.inboxMessages = [];
  });

  it("leaves Papierkorb and Entwürfe out of the open conversation", async () => {
    const previousListed = mailboxState.listed;
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Papierkorb", name: "Papierkorb" },
      { path: "Entwürfe", name: "Entwürfe" },
    ];
    mailboxState.folderSources.Papierkorb = [
      "From: Sam <sam@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Re: Welcome to the mailbox",
      "Date: Mon, 28 Sep 2026 19:00:00 +0000",
      "Message-ID: <trashed-de@example.com>",
      "References: <parent@example.com>",
      "",
      "This reply was in the waste bin.",
    ].join("\r\n");
    mailboxState.folderSources.Entwürfe = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Re: Welcome to the mailbox",
      "Date: Mon, 28 Sep 2026 19:30:00 +0000",
      "Message-ID: <draft-de@example.com>",
      "References: <parent@example.com>",
      "",
      "This draft stays in Entwürfe.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);
    const [inbox] = await provider.getInboxMessages(5);

    try {
      const thread = await provider.getThread(inbox?.threadId || "");
      expect(thread.messages.map((message) => message.subject)).toEqual([
        "Welcome to the mailbox",
      ]);
      expect(
        thread.messages.some((message) =>
          message.textPlain?.includes("waste bin"),
        ),
      ).toBe(false);
      expect(
        thread.messages.some((message) =>
          message.textPlain?.includes("stays in Entwürfe"),
        ),
      ).toBe(false);

      const withDrafts = await provider.getThread(inbox?.threadId || "", {
        includeDrafts: true,
      });
      expect(
        withDrafts.messages.some((message) =>
          message.textPlain?.includes("stays in Entwürfe"),
        ),
      ).toBe(true);
      expect(
        withDrafts.messages.some((message) =>
          message.textPlain?.includes("waste bin"),
        ),
      ).toBe(false);
    } finally {
      mailboxState.listed = previousListed;
      mailboxState.folderSources = {};
    }
  });

  it("leaves Papierkorb and Entwürfe out of search", async () => {
    const previousListed = mailboxState.listed;
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Papierkorb", name: "Papierkorb" },
      { path: "Entwürfe", name: "Entwürfe" },
      { path: "Junk E-mail", name: "Junk E-mail" },
    ];
    mailboxState.folderSources.Papierkorb = [
      "From: Sam <sam@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Secret bin note",
      "Date: Mon, 28 Sep 2026 19:00:00 +0000",
      "Message-ID: <bin-search@example.com>",
      "",
      "secretbinword",
    ].join("\r\n");
    mailboxState.folderSources.Entwürfe = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Secret draft note",
      "Date: Mon, 28 Sep 2026 19:30:00 +0000",
      "Message-ID: <draft-search@example.com>",
      "",
      "secretdraftword",
    ].join("\r\n");
    mailboxState.folderSources["Junk E-mail"] = [
      "From: Ads <ads@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Secret junk note",
      "Date: Mon, 28 Sep 2026 19:40:00 +0000",
      "Message-ID: <junk-search@example.com>",
      "",
      "secretjunkword",
    ].join("\r\n");
    mailboxState.archiveSource = [
      "From: Billing <billing@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Archive still searchable",
      "Date: Mon, 28 Sep 2026 13:00:00 +0000",
      "Message-ID: <archive-search@example.com>",
      "",
      "archivekeepword",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const hidden = await provider.getMessagesWithPagination({
        query: "secretbinword",
        maxResults: 20,
      });
      const hiddenDraft = await provider.getMessagesWithPagination({
        query: "secretdraftword",
        maxResults: 20,
      });
      const hiddenJunk = await provider.getMessagesWithPagination({
        query: "secretjunkword",
        maxResults: 20,
      });
      const kept = await provider.getMessagesWithPagination({
        query: "archivekeepword",
        maxResults: 20,
      });
      expect(hidden.messages).toEqual([]);
      expect(hiddenDraft.messages).toEqual([]);
      expect(hiddenJunk.messages).toEqual([]);
      expect(kept.messages.map((message) => message.subject)).toEqual([
        "Archive still searchable",
      ]);
    } finally {
      mailboxState.listed = previousListed;
      mailboxState.folderSources = {};
      mailboxState.archiveSource = "";
    }
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

  it("clears the seen flag on archived mail when that thread is marked unread", async () => {
    flagsRemoved.length = 0;
    mailboxState.archiveSource = [
      "From: News <news@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Todays newsletter",
      "Date: Tue, 29 Sep 2026 12:00:00 +0000",
      "Message-ID: <today-newsletter@example.com>",
      "",
      "This newsletter arrived today.",
    ].join("\r\n");
    try {
      const provider = createImapProvider(imapConfig(), logger);

      await provider.markReadThread("<today-newsletter@example.com>", false);

      expect(flagsRemoved).toEqual(["\\Seen"]);
      expect(mailboxState.opened).toBe("Archive");
      expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
        where: {
          emailAccountId: "account-1",
          messageId: { in: ["Archive/9"] },
        },
        data: { read: false },
      });
    } finally {
      mailboxState.archiveSource = "";
    }
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
    expect(appended[0]?.raw).toContain(
      "References: <parent@example.com> <welcome-1@example.com>",
    );
    const parsed = await new PostalMime().parse(String(appended[0]?.raw));
    expect(parsed.html).toContain("Thanks, I will reply.");
    expect(parsed.html).toContain("The mailbox is ready.");
  });

  it("finds and deletes a rule draft by the id draftEmail returns", async () => {
    appended.length = 0;
    deleted.length = 0;
    mailboxState.inboxMessages = [];
    mailboxState.draftMessages = [];
    mailboxState.draftSource = "";
    const provider = createImapProvider(imapConfig(), logger);
    const [message] = await provider.getInboxMessages(5);
    if (!message) throw new Error("Missing message");

    const result = await provider.draftEmail(
      message,
      { content: "Thanks, I will reply." },
      "owner@example.com",
    );

    // The same uid can exist in the inbox. The returned id still names the draft.
    mailboxState.inboxMessages = [
      {
        uid: 7,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T12:00:00.000Z",
        source: rawMessage,
      },
    ];
    mailboxState.draftMessages = [
      {
        uid: 7,
        flags: ["\\Draft"],
        internalDate: "2026-09-28T16:00:00.000Z",
        source: String(appended[0]?.raw),
      },
    ];

    const draft = await provider.getDraft(result.draftId);
    expect(draft?.textHtml).toContain("Thanks, I will reply.");

    await expect(provider.deleteDraft(result.draftId)).resolves.toBe(true);
    expect(deleted).toEqual([{ mailbox: "Drafts", uid: 7 }]);

    mailboxState.inboxMessages = [];
    mailboxState.draftMessages = [];
  });

  it("keeps the other recipients on a rule draft", async () => {
    appended.length = 0;
    const provider = createImapProvider(imapConfig(), logger);
    const [message] = await provider.getInboxMessages(5);
    if (!message) throw new Error("Missing message");

    await provider.draftEmail(
      {
        ...message,
        headers: {
          ...message.headers,
          from: "Sam <sam@example.com>",
          "reply-to": "list@example.com",
          to: "owner@example.com, Ada <ada@example.com>",
          cc: "copy@example.com",
        },
      },
      {
        content: "Thanks, I will reply.",
        cc: "extra@example.com",
        bcc: "hidden@example.com",
      },
      "owner@example.com",
    );

    const parsed = await new PostalMime().parse(String(appended[0]?.raw));
    expect(parsed.to?.map((address) => address.address)).toEqual([
      "list@example.com",
    ]);
    expect(parsed.cc?.map((address) => address.address).sort()).toEqual([
      "ada@example.com",
      "copy@example.com",
      "extra@example.com",
    ]);
    expect(parsed.bcc?.map((address) => address.address)).toEqual([
      "hidden@example.com",
    ]);
    expect(parsed.cc?.map((address) => address.address)).not.toContain(
      "owner@example.com",
    );
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
      where: { emailAccountId: "account-1", messageId: { in: ["INBOX/1"] } },
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
      where: { emailAccountId: "account-1", messageId: { in: ["INBOX/1"] } },
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

  it("moves archived mail to Trash", async () => {
    movedTo.length = 0;
    movedFrom.length = 0;
    mailboxState.archiveSource = [
      "From: News <news@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Todays newsletter",
      "Date: Tue, 29 Sep 2026 12:00:00 +0000",
      "Message-ID: <today-newsletter@example.com>",
      "",
      "This newsletter arrived today.",
    ].join("\r\n");
    try {
      const provider = createImapProvider(imapConfig(), logger);

      await provider.trashThread(
        "<today-newsletter@example.com>",
        "owner@example.com",
        "user",
      );

      expect(movedFrom).toEqual(["Archive"]);
      expect(movedTo).toEqual(["Trash"]);
    } finally {
      mailboxState.archiveSource = "";
    }
  });

  it("moves archived mail to Junk", async () => {
    movedTo.length = 0;
    movedFrom.length = 0;
    created.length = 0;
    mailboxState.archiveSource = [
      "From: News <news@example.com>",
      "To: inbox.imap@example.com",
      "Subject: Todays newsletter",
      "Date: Tue, 29 Sep 2026 12:00:00 +0000",
      "Message-ID: <today-newsletter@example.com>",
      "",
      "This newsletter arrived today.",
    ].join("\r\n");
    try {
      const provider = createImapProvider(imapConfig(), logger);

      await provider.markSpam("<today-newsletter@example.com>");

      expect(movedFrom).toEqual(["Archive"]);
      expect(movedTo).toEqual(["Junk"]);
    } finally {
      mailboxState.archiveSource = "";
    }
  });

  it("archives mail that is stored in another folder", async () => {
    movedTo.length = 0;
    movedFrom.length = 0;
    const previousListed = mailboxState.listed;
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
    try {
      const provider = createImapProvider(imapConfig(), logger);

      await provider.archiveThread(
        "<receipt-1@example.com>",
        "owner@example.com",
      );

      expect(movedFrom).toEqual(["Receipts"]);
      expect(movedTo).toEqual(["Archive"]);
    } finally {
      mailboxState.listed = previousListed;
      mailboxState.folderSources = {};
    }
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

  it("reads earlier mail with the same person, including a sent reply", async () => {
    const previous = {
      inboxSearchUids: [...mailboxState.inboxSearchUids],
      sentSearchUids: [...mailboxState.sentSearchUids],
      sentSource: mailboxState.sentSource,
    };
    mailboxState.inboxSearchUids = [1];
    mailboxState.sentSearchUids = [11];
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: Sam <sam@example.com>",
      "Subject: Re: Welcome to the mailbox",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <welcome-reply@example.com>",
      "In-Reply-To: <welcome-1@example.com>",
      "References: <welcome-1@example.com>",
      "",
      "Thanks, the mailbox is ready.",
    ].join("\r\n");

    try {
      const provider = createImapProvider(imapConfig(), logger);
      const threads = await provider.getThreadsWithParticipant({
        participantEmail: "Sam <sam@example.com>",
        maxThreads: 5,
      });
      const froms = threads
        .flatMap((thread) => thread.messages)
        .map((message) => message.headers.from);

      expect(froms).toEqual(
        expect.arrayContaining([
          expect.stringContaining("sam@example.com"),
          expect.stringContaining("owner@example.com"),
        ]),
      );
      await expect(
        provider.getThreadsWithParticipant({
          participantEmail: "other@example.com",
        }),
      ).resolves.toEqual([]);
    } finally {
      mailboxState.inboxSearchUids = previous.inboxSearchUids;
      mailboxState.sentSearchUids = previous.sentSearchUids;
      mailboxState.sentSource = previous.sentSource;
    }
  });

  it("finds a person who is only on the blind copy", async () => {
    const previous = mailboxState.inboxMessages;
    mailboxState.inboxMessages = [
      {
        uid: 4,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T12:00:00.000Z",
        source: [
          "From: News <news@example.com>",
          "To: starttls.imap@example.com",
          "Bcc: Hidden <hidden@example.com>",
          "Subject: Quiet note",
          "Date: Mon, 28 Sep 2026 12:00:00 +0000",
          "Message-ID: <quiet-note@example.com>",
          "",
          "You were copied quietly.",
        ].join("\r\n"),
      },
    ];
    try {
      const provider = createImapProvider(imapConfig(), logger);
      const threads = await provider.getThreadsWithParticipant({
        participantEmail: "hidden@example.com",
      });

      expect(threads.map((thread) => thread.messages[0]?.subject)).toEqual([
        "Quiet note",
      ]);
    } finally {
      mailboxState.inboxMessages = previous;
    }
  });

  it("keeps mail with the newest date on it when newer mail from that person arrived earlier", async () => {
    const previous = {
      inboxSearchUids: [...mailboxState.inboxSearchUids],
      inboxMessages: mailboxState.inboxMessages,
    };
    mailboxState.inboxSearchUids = Array.from(
      { length: 41 },
      (_, index) => index + 1,
    );
    mailboxState.inboxMessages = mailboxState.inboxSearchUids.map((uid) => ({
      uid,
      flags: ["\\Seen"],
      internalDate:
        uid === 1 ? "2026-09-01T12:00:00.000Z" : "2026-09-29T12:00:00.000Z",
      source: datedInboxMessage(
        uid === 1 ? "Written later" : `Arrived later ${uid}`,
        `<person-${uid}@example.com>`,
        uid === 1
          ? "Tue, 29 Sep 2026 12:00:00 +0000"
          : "Tue, 01 Sep 2026 12:00:00 +0000",
      ),
    }));
    try {
      const provider = createImapProvider(imapConfig(), logger);
      const threads = await provider.getThreadsWithParticipant({
        participantEmail: "sam@example.com",
        maxThreads: 1,
      });

      expect(threads.map((thread) => thread.messages[0]?.subject)).toEqual([
        "Written later",
      ]);
    } finally {
      mailboxState.inboxSearchUids = previous.inboxSearchUids;
      mailboxState.inboxMessages = previous.inboxMessages;
    }
  });

  it("returns recent mail that has a file and skips mail without one", async () => {
    const previous = {
      exists: mailboxState.exists,
      inboxMessages: mailboxState.inboxMessages,
      archiveSource: mailboxState.archiveSource,
      trashSource: mailboxState.trashSource,
    };
    const newerFile = archivedAttachment()
      .replace("Subject: File", "Subject: Newer file")
      .replace(
        "Message-ID: <file@example.com>",
        "Message-ID: <newer-file@example.com>",
      );
    const olderFile = archivedAttachment()
      .replace("Subject: File", "Subject: Older file")
      .replace(
        "Message-ID: <file@example.com>",
        "Message-ID: <older-file@example.com>",
      );
    mailboxState.exists = 3;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        source: rawMessage,
        flags: ["\\Seen"],
        internalDate: "2026-09-27T12:00:00.000Z",
      },
      {
        uid: 2,
        source: newerFile,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T12:00:00.000Z",
      },
      {
        uid: 3,
        source: olderFile,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T12:00:00.000Z",
      },
    ];
    mailboxState.archiveSource = archivedAttachment();
    mailboxState.trashSource = archivedAttachment().replace(
      "Subject: File",
      "Subject: Trashed file",
    );

    try {
      const provider = createImapProvider(imapConfig(), logger);
      const first = await provider.getMessagesWithAttachments({
        maxResults: 1,
      });

      expect(first.messages.map((message) => message.subject)).toEqual([
        "Newer file",
      ]);
      expect(first.messages[0]?.attachments[0]?.filename).toBe("note.txt");
      expect(first.nextPageToken).toBe("1");

      const second = await provider.getMessagesWithAttachments({
        maxResults: 1,
        pageToken: first.nextPageToken,
      });
      expect(second.messages.map((message) => message.subject)).toEqual([
        "File",
      ]);

      const all = await provider.getMessagesWithAttachments({
        maxResults: 20,
      });
      expect(all.messages.map((message) => message.subject)).toEqual([
        "Newer file",
        "File",
        "Older file",
      ]);
    } finally {
      mailboxState.exists = previous.exists;
      mailboxState.inboxMessages = previous.inboxMessages;
      mailboxState.archiveSource = previous.archiveSource;
      mailboxState.trashSource = previous.trashSource;
    }
  });

  it("returns the file with the newest date on the mail when that mail arrived earlier", async () => {
    const previous = {
      exists: mailboxState.exists,
      inboxMessages: mailboxState.inboxMessages,
      archiveSource: mailboxState.archiveSource,
      trashSource: mailboxState.trashSource,
    };
    const writtenLater = archivedAttachment()
      .replace("Subject: File", "Subject: Written later")
      .replace(
        "Message-ID: <file@example.com>",
        "Message-ID: <written-later@example.com>",
      )
      .replace(
        "Date: Mon, 28 Sep 2026 18:00:00 +0000",
        "Date: Tue, 29 Sep 2026 12:00:00 +0000",
      );
    const arrivedLater = archivedAttachment()
      .replace("Subject: File", "Subject: Arrived later")
      .replace(
        "Message-ID: <file@example.com>",
        "Message-ID: <arrived-later@example.com>",
      )
      .replace(
        "Date: Mon, 28 Sep 2026 18:00:00 +0000",
        "Date: Tue, 01 Sep 2026 12:00:00 +0000",
      );
    mailboxState.exists = 2;
    mailboxState.archiveSource = "";
    mailboxState.trashSource = "";
    mailboxState.inboxMessages = [
      {
        uid: 1,
        source: writtenLater,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
      },
      {
        uid: 2,
        source: arrivedLater,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T12:00:00.000Z",
      },
    ];

    try {
      const provider = createImapProvider(imapConfig(), logger);
      const page = await provider.getMessagesWithAttachments({
        maxResults: 1,
      });

      expect(page.messages.map((message) => message.subject)).toEqual([
        "Written later",
      ]);
    } finally {
      mailboxState.exists = previous.exists;
      mailboxState.inboxMessages = previous.inboxMessages;
      mailboxState.archiveSource = previous.archiveSource;
      mailboxState.trashSource = previous.trashSource;
    }
  });

  it("reads the conversation messages used to draft a reply", async () => {
    const provider = createImapProvider(imapConfig(), logger);
    const [message] = await provider.getInboxMessages(5);
    if (!message) throw new Error("Missing message");

    const messages = await provider.getPreviousConversationMessages([
      message.id,
    ]);

    expect(messages.map((item) => item.subject)).toEqual([message.subject]);
  });

  it("removes a label keyword from a thread", async () => {
    flagsRemoved.length = 0;
    const provider = createImapProvider(imapConfig(), logger);
    const [message] = await provider.getInboxMessages(5);
    if (!message) throw new Error("Missing message");

    await provider.removeThreadLabel(message.threadId, "Rechnungen");

    expect(flagsRemoved).toEqual(["Rechnungen"]);
  });

  it("removes a label stored on an archived message", async () => {
    flagsRemoved.length = 0;
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

    await provider.removeThreadLabel(
      "<rechnung-2026-09@example.com>",
      "Rechnungen",
    );

    expect(flagsRemoved).toEqual(["Rechnungen"]);
    mailboxState.archiveSource = "";
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
      "From: Billing <billing@example.com>",
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

    const bySender = await provider.getMessagesWithPagination({
      query: "billing@example.com",
      maxResults: 20,
    });
    expect(bySender.messages.map((message) => message.subject)).toEqual([
      "Please trash this",
    ]);
    mailboxState.archiveSource = "";
  });

  it("lists earlier mail by the date written on it when that mail arrived later", async () => {
    const previous = {
      exists: mailboxState.exists,
      inboxMessages: mailboxState.inboxMessages,
      archiveMessages: mailboxState.archiveMessages,
    };
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T03:02:00.000Z",
        source: datedInboxMessage(
          "Old header",
          "<old-header-list@example.com>",
          "Tue, 01 Sep 2026 12:00:00 +0000",
        ),
      },
    ];
    mailboxState.archiveMessages = [
      {
        uid: 4,
        flags: ["\\Seen"],
        internalDate: "2026-09-02T12:00:00.000Z",
        source: datedInboxMessage(
          "Newer header",
          "<newer-header-list@example.com>",
          "Sun, 20 Sep 2026 12:00:00 +0000",
        ),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const listed = await provider.getMessagesWithPagination({
        query: "",
        maxResults: 1,
      });

      expect(listed.messages.map((message) => message.subject)).toEqual([
        "Newer header",
      ]);
    } finally {
      mailboxState.exists = previous.exists;
      mailboxState.inboxMessages = previous.inboxMessages;
      mailboxState.archiveMessages = previous.archiveMessages;
    }
  });

  it("keeps incoming mail on the first page when newer mail was sent", async () => {
    const previous = {
      exists: mailboxState.exists,
      inboxMessages: mailboxState.inboxMessages,
      sentMessages: mailboxState.sentMessages,
      sentSource: mailboxState.sentSource,
    };
    mailboxState.exists = 1;
    mailboxState.sentSource = "";
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: datedInboxMessage(
          "Incoming note",
          "<incoming-note@example.com>",
          "Tue, 01 Sep 2026 12:00:00 +0000",
        ),
      },
    ];
    mailboxState.sentMessages = [
      {
        uid: 8,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T12:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: sam@example.com",
          "Subject: Newer sent note",
          "Date: Tue, 29 Sep 2026 12:00:00 +0000",
          "Message-ID: <newer-sent-note@example.com>",
          "",
          "Sent later.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const listed = await provider.getMessagesWithPagination({
        query: "",
        maxResults: 1,
      });

      expect(listed.messages.map((message) => message.subject)).toEqual([
        "Incoming note",
      ]);
    } finally {
      mailboxState.exists = previous.exists;
      mailboxState.inboxMessages = previous.inboxMessages;
      mailboxState.sentMessages = previous.sentMessages;
      mailboxState.sentSource = previous.sentSource;
    }
  });

  it("keeps an incoming search match on the first page when newer sent mail matches", async () => {
    const previous = {
      exists: mailboxState.exists,
      inboxMessages: mailboxState.inboxMessages,
      sentMessages: mailboxState.sentMessages,
      sentSource: mailboxState.sentSource,
    };
    mailboxState.exists = 1;
    mailboxState.sentSource = "";
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: `${datedInboxMessage(
          "Incoming shared note",
          "<incoming-shared@example.com>",
          "Tue, 01 Sep 2026 12:00:00 +0000",
        )}\r\nsharedword in the inbox`,
      },
    ];
    mailboxState.sentMessages = [
      {
        uid: 8,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T12:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: sam@example.com",
          "Subject: Sent shared note",
          "Date: Tue, 29 Sep 2026 12:00:00 +0000",
          "Message-ID: <sent-shared@example.com>",
          "",
          "sharedword in sent mail",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const found = await provider.getMessagesWithPagination({
        query: "sharedword",
        maxResults: 1,
      });
      const threads = await provider.searchThreads({
        query: "sharedword",
        maxResults: 5,
      });

      expect(found.messages.map((message) => message.subject)).toEqual([
        "Incoming shared note",
      ]);
      expect(
        threads.threads.flatMap((thread) =>
          thread.messages.map((message) => message.subject),
        ),
      ).toEqual(expect.arrayContaining(["Sent shared note"]));
    } finally {
      mailboxState.exists = previous.exists;
      mailboxState.inboxMessages = previous.inboxMessages;
      mailboxState.sentMessages = previous.sentMessages;
      mailboxState.sentSource = previous.sentSource;
    }
  });

  it("orders a search by the incoming message when a newer sent reply matches", async () => {
    const previous = {
      exists: mailboxState.exists,
      inboxMessages: mailboxState.inboxMessages,
      sentMessages: mailboxState.sentMessages,
      sentSource: mailboxState.sentSource,
    };
    mailboxState.exists = 2;
    mailboxState.sentSource = "";
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: `${datedInboxMessage(
          "Older incoming",
          "<older-incoming@example.com>",
          "Tue, 01 Sep 2026 12:00:00 +0000",
        )}\r\nrankword in the inbox`,
      },
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-09-20T12:00:00.000Z",
        source: `${datedInboxMessage(
          "Middle incoming",
          "<middle-incoming@example.com>",
          "Sun, 20 Sep 2026 12:00:00 +0000",
        )}\r\nrankword in the later note`,
      },
    ];
    mailboxState.sentMessages = [
      {
        uid: 8,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T12:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: sam@example.com",
          "Subject: Sent reply",
          "Date: Tue, 29 Sep 2026 12:00:00 +0000",
          "Message-ID: <sent-reply@example.com>",
          "In-Reply-To: <older-incoming@example.com>",
          "References: <older-incoming@example.com>",
          "",
          "rankword in the sent reply",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const threads = await provider.searchThreads({
        query: "rankword",
        maxResults: 5,
      });
      const rows = threads.threads.map((thread) => {
        const incoming = [...thread.messages]
          .reverse()
          .find((message) => !message.id.startsWith("Sent/"));
        return (incoming ?? thread.messages.at(-1))?.subject;
      });

      expect(rows).toEqual(["Middle incoming", "Older incoming"]);

      const first = await provider.searchThreads({
        query: "rankword",
        maxResults: 1,
      });
      const firstRow = first.threads.map((thread) => {
        const incoming = [...thread.messages]
          .reverse()
          .find((message) => !message.id.startsWith("Sent/"));
        return (incoming ?? thread.messages.at(-1))?.subject;
      });
      const second = await provider.searchThreads({
        query: "rankword",
        maxResults: 1,
        pageToken: first.nextPageToken,
      });
      const secondRow = second.threads.map((thread) => {
        const incoming = [...thread.messages]
          .reverse()
          .find((message) => !message.id.startsWith("Sent/"));
        return (incoming ?? thread.messages.at(-1))?.subject;
      });

      expect(firstRow).toEqual(["Middle incoming"]);
      expect(secondRow).toEqual(["Older incoming"]);
    } finally {
      mailboxState.exists = previous.exists;
      mailboxState.inboxMessages = previous.inboxMessages;
      mailboxState.sentMessages = previous.sentMessages;
      mailboxState.sentSource = previous.sentSource;
    }
  });

  it("finds inbox mail that is older than the newest page", async () => {
    mailboxState.exists = 3;
    mailboxState.archiveSource = "";
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: datedInboxMessage(
          "Old billing note",
          "<old-billing@example.com>",
          "Tue, 01 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-09-15T12:00:00.000Z",
        source: datedInboxMessage(
          "September billing",
          "<september-billing@example.com>",
          "Tue, 15 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 8,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T12:00:00.000Z",
        source: datedInboxMessage(
          "Newest note",
          "<newest-note@example.com>",
          "Mon, 28 Sep 2026 12:00:00 +0000",
        ),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    const first = await provider.getMessagesWithPagination({
      query: "billing",
      maxResults: 1,
    });
    const second = await provider.getMessagesWithPagination({
      query: "billing",
      maxResults: 1,
      pageToken: first.nextPageToken,
    });

    expect(first.messages.map((message) => message.subject)).toEqual([
      "September billing",
    ]);
    expect(first.nextPageToken).toBe("1");
    expect(second.messages.map((message) => message.subject)).toEqual([
      "Old billing note",
    ]);
    expect(second.nextPageToken).toBeUndefined();
    mailboxState.inboxMessages = [];
    mailboxState.exists = 1;
  });

  it("returns a search match past the first two hundred", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 201;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-01-01T12:00:00.000Z",
        source: datedInboxMessage(
          "Oldest match",
          "<oldest-match@example.com>",
          "Thu, 01 Jan 2026 12:00:00 +0000",
        ),
      },
      ...Array.from({ length: 200 }, (_, index) => ({
        uid: index + 2,
        flags: ["\\Seen"],
        internalDate: "2026-09-20T12:00:00.000Z",
        source: datedInboxMessage(
          "Newer match",
          `<newer-match-${index}@example.com>`,
          "Sun, 20 Sep 2026 12:00:00 +0000",
        ),
      })),
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const page = await provider.getMessagesWithPagination({
        query: "match",
        maxResults: 1,
        pageToken: "200",
      });

      expect(page.messages.map((message) => message.subject)).toEqual([
        "Oldest match",
      ]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("finds a word in the HTML message when it is past the preview", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T12:00:00.000Z",
        source: [
          "From: Billing <billing@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Invoice preview",
          "Date: Mon, 28 Sep 2026 12:00:00 +0000",
          "Message-ID: <html-search@example.com>",
          "MIME-Version: 1.0",
          "Content-Type: text/html; charset=utf-8",
          "",
          `<p>${"Intro ".repeat(80)}</p><p>Invoice number 44821 is due.</p>`,
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const listed = await provider.getMessagesWithPagination({
        maxResults: 5,
      });
      const found = await provider.searchThreads({
        query: "44821",
        maxResults: 20,
      });

      expect(listed.messages[0]?.snippet).not.toContain("44821");
      expect(
        found.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Invoice preview"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("finds a file name and a copied address that are not in the preview", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T18:00:00.000Z",
        source: [
          "From: Ads <ads@example.com>",
          "To: owner@example.com",
          "Cc: Ada <ada@example.com>",
          "Subject: File",
          "Date: Mon, 28 Sep 2026 18:00:00 +0000",
          "Message-ID: <file-search@example.com>",
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
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const byFile = await provider.searchThreads({
        query: "note.txt",
        maxResults: 20,
      });
      const byCopy = await provider.searchThreads({
        query: "ada@example.com",
        maxResults: 20,
      });

      expect(
        byFile.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["File"]);
      expect(
        byCopy.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["File"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("finds a labeled message when the label is not in the preview", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 2;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen", "FYI"],
        internalDate: "2026-09-28T12:00:00.000Z",
        source: [
          "From: Billing <billing@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Rechnung 2026-09",
          "Date: Mon, 28 Sep 2026 12:00:00 +0000",
          "Message-ID: <labeled-invoice@example.com>",
          "",
          "Bitte begleiche die Rechnung.",
        ].join("\r\n"),
      },
      {
        uid: 2,
        flags: ["\\Seen", "To_Reply"],
        internalDate: "2026-09-27T12:00:00.000Z",
        source: [
          "From: Sam <sam@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Question",
          "Date: Sun, 27 Sep 2026 12:00:00 +0000",
          "Message-ID: <labeled-question@example.com>",
          "",
          "Please answer.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const byLabel = await provider.searchThreads({
        query: "FYI",
        maxResults: 20,
      });
      const byName = await provider.searchThreads({
        query: "To Reply",
        maxResults: 20,
      });

      expect(
        byLabel.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Rechnung 2026-09"]);
      expect(
        byName.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Question"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("finds a word in a text file when that word is not in the message", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T12:00:00.000Z",
        source: [
          "From: Notes <notes@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Filed scan",
          "Date: Tue, 29 Sep 2026 12:00:00 +0000",
          "Message-ID: <filed-scan@example.com>",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="bound"',
          "",
          "--bound",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "See attached.",
          "--bound",
          "Content-Type: text/html; charset=utf-8",
          'Content-Disposition: attachment; filename="scan.bin"',
          "",
          "<style>body { color: papayawhip }",
          "<p>kontostand bleibt im anhang</p>",
          "--bound--",
          "",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const listed = await provider.getMessagesWithPagination({
        maxResults: 5,
      });
      const found = await provider.searchThreads({
        query: "kontostand",
        maxResults: 20,
      });
      const styleOnly = await provider.searchThreads({
        query: "papayawhip",
        maxResults: 20,
      });

      expect(listed.messages[0]?.snippet).not.toContain("kontostand");
      expect(
        found.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Filed scan"]);
      expect(styleOnly.threads).toEqual([]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("finds a reply-to address when that address is not in the message", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T15:00:00.000Z",
        source: [
          "From: News <news@example.com>",
          "Reply-To: List Desk <list-reply@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Weekly digest",
          "Date: Tue, 29 Sep 2026 15:00:00 +0000",
          "Message-ID: <weekly-digest@example.com>",
          "",
          "The weekly note.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const byAddress = await provider.searchThreads({
        query: "list-reply@example.com",
        maxResults: 20,
      });
      const byName = await provider.searchThreads({
        query: "List Desk",
        maxResults: 20,
      });

      expect(
        byAddress.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Weekly digest"]);
      expect(
        byName.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Weekly digest"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("finds a sender and an unsubscribe address when they are not in the message", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T16:00:00.000Z",
        source: [
          "From: News <news@example.com>",
          "Sender: Ada List <ada-sender@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Member note",
          "Date: Tue, 29 Sep 2026 16:00:00 +0000",
          "Message-ID: <member-note@example.com>",
          "List-Unsubscribe: <mailto:leave-list@example.com>",
          "",
          "A short note for members.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const bySender = await provider.searchThreads({
        query: "ada-sender@example.com",
        maxResults: 20,
      });
      const bySenderName = await provider.searchThreads({
        query: "Ada List",
        maxResults: 20,
      });
      const byUnsubscribe = await provider.searchThreads({
        query: "leave-list@example.com",
        maxResults: 20,
      });

      expect(
        bySender.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Member note"]);
      expect(
        bySenderName.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Member note"]);
      expect(
        byUnsubscribe.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Member note"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("keeps every reply-to address when the message lists more than one", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T17:00:00.000Z",
        source: [
          "From: News <news@example.com>",
          "Reply-To: Ada Reply <ada-reply@example.com>, Pat Reply <pat-reply@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Two desks",
          "Date: Tue, 29 Sep 2026 17:00:00 +0000",
          "Message-ID: <two-desks@example.com>",
          "",
          "Please answer both desks.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const opened = await provider.getMessage("INBOX/1");
      const found = await provider.searchThreads({
        query: "pat-reply@example.com",
        maxResults: 20,
      });

      expect(opened.headers["reply-to"]).toBe(
        "Ada Reply <ada-reply@example.com>, Pat Reply <pat-reply@example.com>",
      );
      expect(
        found.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Two desks"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("finds a mailing list when the list name is not in the message", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T18:00:00.000Z",
        source: [
          "From: News <news@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Desk note",
          "Date: Tue, 29 Sep 2026 18:00:00 +0000",
          "Message-ID: <desk-note@example.com>",
          "List-Id: Ada Team <ada-team.lists.example.com>",
          "List-Post: <mailto:post-ada@lists.example.com>",
          "",
          "A short note for the desk.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const byName = await provider.searchThreads({
        query: "Ada Team",
        maxResults: 20,
      });
      const byList = await provider.searchThreads({
        query: "ada-team.lists.example.com",
        maxResults: 20,
      });
      const byPost = await provider.searchThreads({
        query: "post-ada@lists.example.com",
        maxResults: 20,
      });

      expect(
        byName.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Desk note"]);
      expect(
        byList.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Desk note"]);
      expect(
        byPost.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Desk note"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("keeps every sender when the message lists more than one", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T20:00:00.000Z",
        source: [
          "From: Sam <sam@example.com>, Ada <ada@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Two senders",
          "Date: Tue, 29 Sep 2026 20:00:00 +0000",
          "Message-ID: <two-senders@example.com>",
          "",
          "A short note from both.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const messages = await provider.getInboxMessages(5);
      const found = await provider.searchThreads({
        query: "ada@example.com",
        maxResults: 20,
      });

      expect(messages[0]?.headers.from).toContain("sam@example.com");
      expect(messages[0]?.headers.from).toContain("ada@example.com");
      expect(
        found.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Two senders"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("finds a message id when that id is not written in the message", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T19:00:00.000Z",
        source: [
          "From: Ada <ada@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Thread note",
          "Date: Tue, 29 Sep 2026 19:00:00 +0000",
          "Message-ID: <thread-note@example.com>",
          "In-Reply-To: <older-desk@example.com>",
          "References: <first-desk@example.com> <older-desk@example.com>",
          "",
          "A short note about the thread.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const byOwnId = await provider.searchThreads({
        query: "thread-note@example.com",
        maxResults: 20,
      });
      const byParent = await provider.searchThreads({
        query: "older-desk@example.com",
        maxResults: 20,
      });
      const byEarlier = await provider.searchThreads({
        query: "first-desk@example.com",
        maxResults: 20,
      });

      expect(
        byOwnId.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Thread note"]);
      expect(
        byParent.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Thread note"]);
      expect(
        byEarlier.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Thread note"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("returns the search match with the newest written date when that mail arrived earlier", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 3;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: datedInboxMessage(
          "Written later match",
          "<written-later-match@example.com>",
          "Tue, 29 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-09-20T12:00:00.000Z",
        source: datedInboxMessage(
          "Earlier written match",
          "<earlier-written-match@example.com>",
          "Wed, 02 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 3,
        flags: ["\\Seen"],
        internalDate: "2026-09-21T12:00:00.000Z",
        source: datedInboxMessage(
          "Recent arrival match",
          "<recent-arrival-match@example.com>",
          "Thu, 03 Sep 2026 12:00:00 +0000",
        ),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const page = await provider.getMessagesWithPagination({
        query: "match",
        maxResults: 1,
      });

      expect(page.messages.map((message) => message.subject)).toEqual([
        "Written later match",
      ]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("keeps only inbox mail inside the requested dates", async () => {
    const previous = {
      exists: mailboxState.exists,
      inboxMessages: mailboxState.inboxMessages,
    };
    mailboxState.exists = 2;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: datedInboxMessage(
          "Old billing note",
          "<old-billing@example.com>",
          "Tue, 01 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 8,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T12:00:00.000Z",
        source: datedInboxMessage(
          "Newest note",
          "<newest-note@example.com>",
          "Mon, 28 Sep 2026 12:00:00 +0000",
        ),
      },
    ];

    try {
      const provider = createImapProvider(imapConfig(), logger);
      const newer = await provider.getMessagesWithPagination({
        after: new Date("2026-09-20T00:00:00.000Z"),
        maxResults: 20,
      });
      const older = await provider.getMessagesWithPagination({
        before: new Date("2026-09-10T00:00:00.000Z"),
        maxResults: 20,
      });

      expect(newer.messages.map((message) => message.subject)).toEqual([
        "Newest note",
      ]);
      expect(older.messages.map((message) => message.subject)).toEqual([
        "Old billing note",
      ]);
    } finally {
      mailboxState.exists = previous.exists;
      mailboxState.inboxMessages = previous.inboxMessages;
    }
  });

  it("includes mail outside the inbox when loading a date window", async () => {
    const previous = {
      exists: mailboxState.exists,
      inboxMessages: mailboxState.inboxMessages,
      listed: mailboxState.listed,
      folderSources: mailboxState.folderSources,
      folderDateUids: mailboxState.folderDateUids,
    };
    mailboxState.exists = 1;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-08-01T12:00:00.000Z",
        source: datedInboxMessage(
          "Old inbox",
          "<old-inbox@example.com>",
          "Sat, 01 Aug 2026 12:00:00 +0000",
        ),
      },
    ];
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Receipts", name: "Receipts" },
    ];
    mailboxState.folderDateUids = { Receipts: [14] };
    mailboxState.folderSources = {
      Receipts: [
        "From: Billing <billing@example.com>",
        "To: owner@example.com",
        "Subject: Receipt folder check",
        "Date: Mon, 28 Sep 2026 23:51:00 +0000",
        "Message-ID: <receipt-folder-a0b4@example.com>",
        "",
        "This message is in Receipts.",
      ].join("\r\n"),
    };

    try {
      const provider = createImapProvider(imapConfig(), logger);
      const page = await provider.getMessagesWithPagination({
        after: new Date("2026-09-29T00:00:00.000Z"),
        maxResults: 20,
      });

      expect(page.messages.map((message) => message.subject)).toEqual([
        "Receipt folder check",
      ]);
    } finally {
      mailboxState.exists = previous.exists;
      mailboxState.inboxMessages = previous.inboxMessages;
      mailboxState.listed = previous.listed;
      mailboxState.folderSources = previous.folderSources;
      mailboxState.folderDateUids = previous.folderDateUids;
    }
  });

  it("returns older inbox mail when newer mail is past the cutoff", async () => {
    const previous = {
      exists: mailboxState.exists,
      inboxMessages: mailboxState.inboxMessages,
    };
    mailboxState.exists = 2;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: datedInboxMessage(
          "Old billing note",
          "<old-billing@example.com>",
          "Tue, 01 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 20,
        flags: ["\\Seen"],
        internalDate: "2026-09-10T18:00:00.000Z",
        source: datedInboxMessage(
          "Later billing note",
          "<later-billing@example.com>",
          "Thu, 10 Sep 2026 18:00:00 +0000",
        ),
      },
    ];

    try {
      const provider = createImapProvider(imapConfig(), logger);
      const page = await provider.getMessagesWithPagination({
        before: new Date("2026-09-10T12:00:00.000Z"),
        maxResults: 1,
      });

      expect(page.messages.map((message) => message.subject)).toEqual([
        "Old billing note",
      ]);
    } finally {
      mailboxState.exists = previous.exists;
      mailboxState.inboxMessages = previous.inboxMessages;
    }
  });

  it("finds a message id that is older than the newest page", async () => {
    mailboxState.exists = 101;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: datedInboxMessage(
          "Old parent",
          "<old-parent@example.com>",
          "Tue, 01 Sep 2026 12:00:00 +0000",
        ),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    const found = await provider.getMessageByRfc822MessageId(
      "<old-parent@example.com>",
    );

    expect(found?.subject).toBe("Old parent");
    expect(found?.id).toBe("INBOX/1");
    mailboxState.inboxMessages = [];
    mailboxState.exists = 1;
  });

  it("opens a thread that is older than the newest page", async () => {
    mailboxState.exists = 103;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-08-01T12:00:00.000Z",
        source: [
          "From: Sam <sam@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Buried parent",
          "Date: Sat, 01 Aug 2026 12:00:00 +0000",
          "Message-ID: <buried-parent@example.com>",
          "",
          "The older note.",
        ].join("\r\n"),
      },
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-08-02T12:00:00.000Z",
        source: [
          "From: Sam <sam@example.com>",
          "To: inbox.imap@example.com",
          "Subject: Re: Buried parent",
          "Date: Sun, 02 Aug 2026 12:00:00 +0000",
          "Message-ID: <buried-reply@example.com>",
          "In-Reply-To: <buried-parent@example.com>",
          "References: <buried-parent@example.com>",
          "",
          "The older reply.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    const thread = await provider.getThread("<buried-parent@example.com>");

    expect(thread.messages.map((message) => message.subject)).toEqual([
      "Buried parent",
      "Re: Buried parent",
    ]);
    mailboxState.inboxMessages = [];
    mailboxState.exists = 1;
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

  it("stores every recipient on a sent message", async () => {
    mailboxState.allUids = [1];
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: Sam Chart <sam-chart-to@example.com>, Ada Chart <ada-chart-to@example.com>",
      "Subject: Chart sent both",
      "Date: Wed, 30 Sep 2026 13:00:00 +0000",
      "Message-ID: <chart-sent-both@example.com>",
      "",
      "Sent to both of them.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    await provider.getMessagesWithPagination({ maxResults: 20 });

    expect(prisma.emailMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          to: "sam-chart-to@example.com, ada-chart-to@example.com",
          sent: true,
        }),
      }),
    );
    mailboxState.allUids = [];
    mailboxState.sentSource = "";
  });

  it("drops stored sent mail that is no longer in the Sent folder", async () => {
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

    expect(prisma.emailMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        emailAccountId: "account-1",
        sent: true,
        messageId: { startsWith: "sent:", notIn: ["sent:11"] },
      },
    });
    mailboxState.sentSource = "";
  });

  it("keeps stored sent mail when the account has no Sent folder", async () => {
    mailboxState.missingMailboxes = ["Sent", "Sent Items", "[Gmail]/Sent Mail"];
    const provider = createImapProvider(imapConfig(), logger);

    await provider.getMessagesWithPagination({ maxResults: 20 });

    expect(prisma.emailMessage.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sent: true }),
      }),
    );
    mailboxState.missingMailboxes = [];
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

  it("reads the next page of sent message ids", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 2;
    mailboxState.sentMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: old@example.com",
          "Subject: Older sent note",
          "Date: Tue, 01 Sep 2026 12:00:00 +0000",
          "Message-ID: <older-sent@example.com>",
          "",
          "Older sent note.",
        ].join("\r\n"),
      },
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-09-20T12:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: new@example.com",
          "Subject: Newer sent note",
          "Date: Sun, 20 Sep 2026 12:00:00 +0000",
          "Message-ID: <newer-sent@example.com>",
          "",
          "Newer sent note.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);
    const range = {
      after: new Date("2026-08-01T00:00:00.000Z"),
      before: new Date("2026-10-01T00:00:00.000Z"),
    };

    try {
      const first = await provider.getSentMessageIds({
        maxResults: 1,
        ...range,
      });
      expect(first.messages).toEqual([
        { id: "Sent/2", threadId: "<newer-sent@example.com>" },
      ]);
      expect(first.nextPageToken).toBe("1");

      const second = await provider.getSentMessageIds({
        maxResults: 1,
        pageToken: first.nextPageToken,
        ...range,
      });
      expect(second.messages).toEqual([
        { id: "Sent/1", threadId: "<older-sent@example.com>" },
      ]);
      expect(second.nextPageToken).toBeUndefined();
    } finally {
      mailboxState.sentMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("returns older sent mail when newer mail is outside the date window", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 2;
    mailboxState.sentMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: old@example.com",
          "Subject: Older sent note",
          "Date: Tue, 01 Sep 2026 12:00:00 +0000",
          "Message-ID: <older-sent@example.com>",
          "",
          "Older sent note.",
        ].join("\r\n"),
      },
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-10-15T12:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: new@example.com",
          "Subject: Newer sent note",
          "Date: Thu, 15 Oct 2026 12:00:00 +0000",
          "Message-ID: <newer-sent@example.com>",
          "",
          "Newer sent note.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const result = await provider.getSentMessageIds({
        maxResults: 1,
        after: new Date("2026-08-01T00:00:00.000Z"),
        before: new Date("2026-09-30T00:00:00.000Z"),
      });

      expect(result.messages).toEqual([
        { id: "Sent/1", threadId: "<older-sent@example.com>" },
      ]);
    } finally {
      mailboxState.sentMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("returns unread sent mail when newer sent mail is already read", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 2;
    mailboxState.sentMessages = [
      {
        uid: 1,
        flags: [],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: sam@example.com",
          "Subject: Still unread sent",
          "Date: Tue, 01 Sep 2026 12:00:00 +0000",
          "Message-ID: <unread-sent@example.com>",
          "",
          "Still unread sent.",
        ].join("\r\n"),
      },
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-09-20T12:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: sam@example.com",
          "Subject: Already read sent",
          "Date: Sun, 20 Sep 2026 12:00:00 +0000",
          "Message-ID: <read-sent@example.com>",
          "",
          "Already read sent.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const result = await provider.getThreadsWithQuery({
        maxResults: 1,
        query: { type: "sent", isUnread: true },
      });

      expect(
        result.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Still unread sent"]);
    } finally {
      mailboxState.sentMessages = [];
      mailboxState.exists = previousExists;
    }
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

  it("treats a copied address as earlier mail with that person", async () => {
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Sent", name: "Sent" },
    ];
    mailboxState.sentMessages = [
      {
        uid: 11,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T10:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: other@example.com",
          "Cc: Quiet <quiet@acme.example>",
          "Subject: Quiet copy",
          "Date: Mon, 28 Sep 2026 10:00:00 +0000",
          "Message-ID: <quiet-copy@example.com>",
          "",
          "You were copied.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    const copiedEarlier =
      await provider.hasPreviousCommunicationsWithSenderOrDomain({
        from: "introducer@acme.example",
        date: new Date("2026-09-28T15:00:00.000Z"),
        messageId: "1",
      });

    expect(copiedEarlier).toBe(true);
    mailboxState.sentMessages = [];
    mailboxState.listed = [{ path: "INBOX", name: "INBOX" }];
  });

  it("treats a blind copy as earlier mail with that person", async () => {
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Sent", name: "Sent" },
    ];
    mailboxState.sentMessages = [
      {
        uid: 11,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T10:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: other@example.com",
          "Bcc: Quiet <quiet@acme.example>",
          "Subject: Quiet blind copy",
          "Date: Mon, 28 Sep 2026 10:00:00 +0000",
          "Message-ID: <quiet-blind@example.com>",
          "",
          "You were copied quietly.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    const copiedEarlier =
      await provider.hasPreviousCommunicationsWithSenderOrDomain({
        from: "introducer@acme.example",
        date: new Date("2026-09-28T15:00:00.000Z"),
        messageId: "1",
      });

    expect(copiedEarlier).toBe(true);
    mailboxState.sentMessages = [];
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

  it("leaves inbox mail outside the requested dates", async () => {
    const provider = createImapProvider(imapConfig(), logger);

    const inRange = await provider.getThreadsWithQuery({
      query: {
        type: "inbox",
        after: new Date("2026-09-01T00:00:00.000Z"),
        before: new Date("2026-09-29T00:00:00.000Z"),
      },
    });
    expect(
      inRange.threads.map((thread) => thread.messages[0]?.subject),
    ).toEqual(["Welcome to the mailbox"]);

    const tooLate = await provider.getThreadsWithQuery({
      query: {
        type: "inbox",
        after: new Date("2026-10-01T00:00:00.000Z"),
      },
    });
    expect(tooLate.threads).toEqual([]);

    const tooEarly = await provider.getThreadsWithQuery({
      query: {
        type: "inbox",
        before: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    expect(tooEarly.threads).toEqual([]);
  });

  it("reaches inbox mail inside the dates when newer mail fills the page", async () => {
    mailboxState.exists = 4;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: [],
        internalDate: "2026-09-02T12:00:00.000Z",
        source: datedInboxMessage(
          "Early September",
          "<early-september@example.com>",
          "Wed, 02 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 2,
        flags: [],
        internalDate: "2026-09-15T12:00:00.000Z",
        source: datedInboxMessage(
          "September invoice",
          "<september-invoice@example.com>",
          "Tue, 15 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 3,
        flags: ["\\Seen"],
        internalDate: "2026-09-20T12:00:00.000Z",
        source: datedInboxMessage(
          "Read September",
          "<read-september@example.com>",
          "Sun, 20 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 40,
        flags: ["\\Seen"],
        internalDate: "2026-10-02T12:00:00.000Z",
        source: datedInboxMessage(
          "October note",
          "<october-note@example.com>",
          "Fri, 02 Oct 2026 12:00:00 +0000",
        ),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);
    const query = {
      type: "inbox" as const,
      isUnread: true,
      after: new Date("2026-09-01T00:00:00.000Z"),
      before: new Date("2026-10-01T00:00:00.000Z"),
    };

    const first = await provider.getThreadsWithQuery({
      maxResults: 1,
      query,
    });
    const second = await provider.getThreadsWithQuery({
      maxResults: 1,
      pageToken: first.nextPageToken,
      query,
    });

    expect(first.threads.map((thread) => thread.messages[0]?.subject)).toEqual([
      "September invoice",
    ]);
    expect(first.nextPageToken).toBe("1");
    expect(second.threads.map((thread) => thread.messages[0]?.subject)).toEqual(
      ["Early September"],
    );
    expect(second.nextPageToken).toBeUndefined();
    mailboxState.inboxMessages = [];
    mailboxState.exists = 1;
  });

  it("returns unread inbox mail when newer mail is already read", async () => {
    mailboxState.exists = 2;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: [],
        internalDate: "2026-09-02T12:00:00.000Z",
        source: datedInboxMessage(
          "Still unread",
          "<still-unread@example.com>",
          "Wed, 02 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-09-20T12:00:00.000Z",
        source: datedInboxMessage(
          "Already read",
          "<already-read@example.com>",
          "Sun, 20 Sep 2026 12:00:00 +0000",
        ),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      maxResults: 1,
      query: { type: "inbox", isUnread: true },
    });

    expect(result.threads.map((thread) => thread.messages[0]?.subject)).toEqual(
      ["Still unread"],
    );
    mailboxState.inboxMessages = [];
    mailboxState.exists = 1;
  });

  it("returns the unread mail with the newest written date when that mail arrived earlier", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 3;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: [],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: datedInboxMessage(
          "Written later",
          "<written-later-unread@example.com>",
          "Tue, 29 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 2,
        flags: [],
        internalDate: "2026-09-20T12:00:00.000Z",
        source: datedInboxMessage(
          "Earlier written",
          "<earlier-written-unread@example.com>",
          "Wed, 02 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 3,
        flags: [],
        internalDate: "2026-09-21T12:00:00.000Z",
        source: datedInboxMessage(
          "Recent arrival",
          "<recent-arrival-unread@example.com>",
          "Thu, 03 Sep 2026 12:00:00 +0000",
        ),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const first = await provider.getThreadsWithQuery({
        maxResults: 1,
        query: { type: "inbox", isUnread: true },
      });
      const second = await provider.getThreadsWithQuery({
        maxResults: 1,
        pageToken: first.nextPageToken,
        query: { type: "inbox", isUnread: true },
      });

      expect(
        first.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Written later"]);
      expect(
        second.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Recent arrival"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("returns the next page of older inbox mail", async () => {
    mailboxState.exists = 3;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: datedInboxMessage(
          "Oldest note",
          "<oldest-note@example.com>",
          "Tue, 01 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-09-02T12:00:00.000Z",
        source: datedInboxMessage(
          "Middle note",
          "<middle-note@example.com>",
          "Wed, 02 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 3,
        flags: [],
        internalDate: "2026-09-03T12:00:00.000Z",
        source: datedInboxMessage(
          "Newest note",
          "<newest-note@example.com>",
          "Thu, 03 Sep 2026 12:00:00 +0000",
        ),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    const first = await provider.getThreadsWithQuery({
      maxResults: 1,
      query: { type: "inbox" },
    });
    const second = await provider.getThreadsWithQuery({
      maxResults: 1,
      pageToken: first.nextPageToken,
      query: { type: "inbox" },
    });

    expect(first.threads.map((thread) => thread.messages[0]?.subject)).toEqual([
      "Newest note",
    ]);
    expect(first.nextPageToken).toBe("1");
    expect(second.threads.map((thread) => thread.messages[0]?.subject)).toEqual(
      ["Middle note"],
    );
    expect(second.nextPageToken).toBe("2");
    mailboxState.inboxMessages = [];
    mailboxState.exists = 1;
  });

  it("lists mail by the date written on it when that mail arrived later", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 2;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-29T03:02:00.000Z",
        source: datedInboxMessage(
          "Old header",
          "<old-header@example.com>",
          "Tue, 01 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-09-15T12:00:00.000Z",
        source: datedInboxMessage(
          "Newer header",
          "<newer-header@example.com>",
          "Sun, 20 Sep 2026 12:00:00 +0000",
        ),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const result = await provider.getThreadsWithQuery({
        maxResults: 5,
        query: { type: "inbox" },
      });

      expect(
        result.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Newer header", "Old header"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
  });

  it("puts the newest written date on the first page when that mail arrived earlier", async () => {
    const previousExists = mailboxState.exists;
    mailboxState.exists = 3;
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-01T12:00:00.000Z",
        source: datedInboxMessage(
          "Written later",
          "<written-later@example.com>",
          "Tue, 29 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 2,
        flags: ["\\Seen"],
        internalDate: "2026-09-20T12:00:00.000Z",
        source: datedInboxMessage(
          "Earlier written",
          "<earlier-written@example.com>",
          "Wed, 02 Sep 2026 12:00:00 +0000",
        ),
      },
      {
        uid: 3,
        flags: ["\\Seen"],
        internalDate: "2026-09-21T12:00:00.000Z",
        source: datedInboxMessage(
          "Recent arrival",
          "<recent-arrival@example.com>",
          "Thu, 03 Sep 2026 12:00:00 +0000",
        ),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    try {
      const first = await provider.getThreadsWithQuery({
        maxResults: 1,
        query: { type: "inbox" },
      });
      const second = await provider.getThreadsWithQuery({
        maxResults: 1,
        pageToken: first.nextPageToken,
        query: { type: "inbox" },
      });

      expect(
        first.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Written later"]);
      expect(
        second.threads.map((thread) => thread.messages[0]?.subject),
      ).toEqual(["Recent arrival"]);
    } finally {
      mailboxState.inboxMessages = [];
      mailboxState.exists = previousExists;
    }
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
    expect(result.threads[0]?.messages[0]?.labelIds).toContain("SENT");

    const opened = await provider.getThread(result.threads[0]?.id || "");
    expect(opened.messages[0]?.subject).toBe("Re: Please reply");
    mailboxState.sentSource = "";
  });

  it("keeps the recipient name on sent mail", async () => {
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: Sam <sam@example.com>, digest@example.com",
      "Cc: Ada <ada@example.com>",
      "Reply-To: Support <support@example.com>",
      "Subject: Named recipients",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <named-recipients@example.com>",
      "",
      "The names stay on the mail.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      query: { type: "sent" },
    });
    const headers = result.threads[0]?.messages[0]?.headers;

    expect(headers?.to).toBe("Sam <sam@example.com>, digest@example.com");
    expect(headers?.cc).toBe("Ada <ada@example.com>");
    expect(headers?.["reply-to"]).toBe("Support <support@example.com>");
    mailboxState.sentSource = "";
  });

  it("uses the sent mailbox the server already has", async () => {
    const previous = mailboxState.listed;
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Gesendet", name: "Gesendet" },
    ];
    mailboxState.missingMailboxes = ["Sent", "Sent Items", "[Gmail]/Sent Mail"];
    mailboxState.folderSources.Gesendet = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Gesendet note",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <gesendet-note@example.com>",
      "",
      "Stored in the existing sent mailbox.",
    ].join("\r\n");
    appended.length = 0;
    created.length = 0;
    sentMail.length = 0;
    try {
      const provider = createImapProvider(imapConfig(), logger);
      const result = await provider.getThreadsWithQuery({
        query: { type: "sent" },
      });

      expect(result.threads[0]?.messages[0]?.subject).toBe("Gesendet note");
      expect(result.threads[0]?.messages[0]?.labelIds).toContain("SENT");

      await provider.sendEmailWithHtml({
        to: "sam@example.com",
        subject: "Hello",
        messageHtml: "<p>Hi</p>",
      });

      expect(appended.at(-1)?.mailbox).toBe("Gesendet");
      expect(created).not.toContain("Sent");
    } finally {
      mailboxState.listed = previous;
      mailboxState.missingMailboxes = [];
      mailboxState.folderSources.Gesendet = "";
      appended.length = 0;
      created.length = 0;
      sentMail.length = 0;
    }
  });

  it("archives into the mailbox the server already uses", async () => {
    const previous = mailboxState.listed;
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Archiv", name: "Archiv" },
    ];
    movedTo.length = 0;
    created.length = 0;
    try {
      const provider = createImapProvider(imapConfig(), logger);
      const [message] = await provider.getInboxMessages(5);
      await provider.archiveThread(
        message?.threadId || "",
        "owner@example.com",
      );

      expect(movedTo).toEqual(["Archiv"]);
      expect(created).not.toContain("Archive");
    } finally {
      mailboxState.listed = previous;
      movedTo.length = 0;
      created.length = 0;
    }
  });

  it("saves a draft in the mailbox the server already uses", async () => {
    const previous = mailboxState.listed;
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Entwürfe", name: "Entwürfe" },
    ];
    appended.length = 0;
    created.length = 0;
    try {
      const provider = createImapProvider(imapConfig(), logger);
      const [message] = await provider.getInboxMessages(5);
      if (!message) throw new Error("Missing message");
      await provider.draftEmail(
        message,
        { content: "Thanks, I will reply." },
        "owner@example.com",
      );

      expect(appended.at(-1)?.mailbox).toBe("Entwürfe");
      expect(created).not.toContain("Drafts");
    } finally {
      mailboxState.listed = previous;
      appended.length = 0;
      created.length = 0;
    }
  });

  it("shows the readable address in an HTML-only sent snippet", async () => {
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Re: Please keep this",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <html-snippet@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Thanks, I kept this.</p>",
      "<div>On Tue, 1 Sep 2026 at 12:05, Sam &lt;sam@example.com&gt; wrote:</div>",
      "<p>Tom &amp; Jerry&nbsp;sent this.</p>",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      query: { type: "sent" },
    });
    const snippet = result.threads[0]?.messages[0]?.snippet || "";

    expect(snippet).toContain("Thanks, I kept this.");
    expect(snippet).toContain("Sam <sam@example.com> wrote:");
    expect(snippet).toContain("Tom & Jerry sent this.");
    expect(snippet).not.toContain("&lt;");
    expect(snippet).not.toContain("&amp;");
    expect(snippet).not.toContain("&nbsp;");
    expect(snippet).not.toContain("<p>");
    mailboxState.sentSource = "";
  });

  it("leaves style and script out of an HTML-only snippet", async () => {
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Invoice preview",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <styled-snippet@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><head><title>Hidden title</title><style>p { color: red; }</style></head>",
      "<body><script>alert(1)</script><p>Please keep the invoice.</p></body></html>",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      query: { type: "sent" },
    });
    const snippet = result.threads[0]?.messages[0]?.snippet || "";

    expect(snippet).toContain("Please keep the invoice.");
    expect(snippet).not.toContain("color: red");
    expect(snippet).not.toContain("alert");
    expect(snippet).not.toContain("Hidden title");
    mailboxState.sentSource = "";
  });

  it("leaves an unclosed style block out of an HTML-only snippet", async () => {
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Invoice preview",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <unclosed-style-snippet@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html>",
      "<title>Hidden title</title>",
      "<style>p { color: red; }",
      "<p>Please keep the invoice.</p>",
      "<script>alert(1)",
      "<p>And the rest.</p>",
      "<!--[if mso]>",
      "<p>Outlook only text</p>",
      "<![endif]-->",
      "</html>",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      query: { type: "sent" },
    });
    const snippet = result.threads[0]?.messages[0]?.snippet || "";

    expect(snippet).toContain("Please keep the invoice.");
    expect(snippet).toContain("And the rest.");
    expect(snippet).not.toContain("color");
    expect(snippet).not.toContain("red");
    expect(snippet).not.toContain("alert");
    expect(snippet).not.toContain("Hidden title");
    expect(snippet).not.toContain("Outlook");
    mailboxState.sentSource = "";
  });

  it("uses the HTML preview when the plain part is blank", async () => {
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Blank plain part",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <blank-plain-snippet@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="bound"',
      "",
      "--bound",
      "Content-Type: text/plain; charset=utf-8",
      "",
      " ",
      "--bound",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Please keep the invoice.</p>",
      "--bound--",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      query: { type: "sent" },
    });

    expect(result.threads[0]?.messages[0]?.snippet).toContain(
      "Please keep the invoice.",
    );
    mailboxState.sentSource = "";
  });

  it("keeps a plain-text snippet exactly as written", async () => {
    mailboxState.sentSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Plain note",
      "Date: Mon, 28 Sep 2026 14:00:00 +0000",
      "Message-ID: <plain-snippet@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Use &amp; when you mean the characters.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      query: { type: "sent" },
    });

    expect(result.threads[0]?.messages[0]?.snippet).toContain(
      "Use &amp; when you mean the characters.",
    );
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
    expect(result.threads[0]?.messages[0]?.labelIds).toContain("DRAFT");

    const opened = await provider.getThread(result.threads[0]?.id || "");
    expect(opened.messages[0]?.textPlain).toContain("Draft reply.");
    mailboxState.draftSource = "";
  });

  it("keeps a reply draft in the conversation when the inbox message is still there", async () => {
    mailboxState.draftSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Re: Welcome to the mailbox",
      "Date: Mon, 28 Sep 2026 16:00:00 +0000",
      "Message-ID: <draft-1@example.com>",
      "In-Reply-To: <welcome-1@example.com>",
      "References: <parent@example.com> <welcome-1@example.com>",
      "",
      "Draft reply.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const [inbox] = await provider.getInboxMessages(1);
    const thread = await provider.getThread(inbox?.threadId || "", {
      includeDrafts: true,
    });

    expect(thread.messages.map((message) => message.textPlain)).toEqual([
      expect.stringContaining("The mailbox is ready."),
      expect.stringContaining("Draft reply."),
    ]);
    expect(thread.messages[1]?.labelIds).toContain("DRAFT");
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

  it("sends the blind copy saved on a draft", async () => {
    sentMail.length = 0;
    appended.length = 0;
    deleted.length = 0;
    mailboxState.draftSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Bcc: hidden@example.com",
      "Subject: Re: Welcome to the mailbox",
      "Date: Mon, 28 Sep 2026 16:00:00 +0000",
      "Message-ID: <draft-1@example.com>",
      "In-Reply-To: <welcome-1@example.com>",
      "",
      "Draft reply.",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const listed = await provider.getThreadsWithQuery({
      query: { type: "drafts" },
    });
    expect(listed.threads[0]?.messages[0]?.headers.bcc).toBe(
      "hidden@example.com",
    );

    await provider.sendDraft(listed.threads[0]?.id || "");

    expect(sentMail.at(-1)).toMatchObject({
      to: "sam@example.com",
      bcc: "hidden@example.com",
    });
    expect(String(appended.at(-1)?.raw)).toContain("Bcc: hidden@example.com");
    mailboxState.draftSource = "";
  });

  it("sends an inline image that was saved on a draft", async () => {
    sentMail.length = 0;
    appended.length = 0;
    mailboxState.draftSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Photo",
      "Date: Mon, 28 Sep 2026 16:00:00 +0000",
      "Message-ID: <draft-photo@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="bound"',
      "",
      "--bound",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>See <img src="cid:photo@inboxzero.local"></p>',
      "--bound",
      'Content-Type: image/png; name="photo.png"',
      'Content-Disposition: inline; filename="photo.png"',
      "Content-Transfer-Encoding: base64",
      "Content-ID: <photo@inboxzero.local>",
      "",
      "aGVsbG8=",
      "--bound--",
      "",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    const listed = await provider.getThreadsWithQuery({
      query: { type: "drafts" },
    });
    expect(
      listed.threads[0]?.messages[0]?.inline[0]?.headers["content-id"],
    ).toBe("photo@inboxzero.local");

    await provider.sendDraft(listed.threads[0]?.id || "");

    expect(sentMail.at(-1)?.attachments).toEqual([
      expect.objectContaining({
        filename: "photo.png",
        cid: "photo@inboxzero.local",
        contentDisposition: "inline",
      }),
    ]);
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
    expect(reference).toEqual({ id: "<draft-1@example.com>" });
    mailboxState.draftMessages = [
      {
        uid: 21,
        flags: ["\\Draft", "\\Seen"],
        internalDate: "2026-09-28T16:05:00.000Z",
        source: savedDraft(),
      },
    ];
    appended.length = 0;
    await provider.updateDraft(reference?.id || "", {
      messageHtml: "<p>Second edit</p>",
    });
    expect(String(appended.at(-1)?.raw)).toContain("<p>Second edit</p>");
    mailboxState.draftMessages = [];
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

  it("keeps an inline image when a draft is edited without resending the file", async () => {
    appended.length = 0;
    mailboxState.draftSource = [
      "From: Owner <owner@example.com>",
      "To: sam@example.com",
      "Subject: Photo",
      "Date: Mon, 28 Sep 2026 16:00:00 +0000",
      "Message-ID: <draft-photo@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="bound"',
      "",
      "--bound",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>See <img src="cid:photo@inboxzero.local"></p>',
      "--bound",
      'Content-Type: image/png; name="photo.png"',
      'Content-Disposition: inline; filename="photo.png"',
      "Content-Transfer-Encoding: base64",
      "Content-ID: <photo@inboxzero.local>",
      "",
      "aGVsbG8=",
      "--bound--",
      "",
    ].join("\r\n");
    const provider = createImapProvider(imapConfig(), logger);

    await provider.updateDraft("<draft-photo@example.com>", {
      messageHtml: '<p>Updated <img src="cid:photo@inboxzero.local"></p>',
    });

    const parsed = await new PostalMime().parse(String(appended.at(-1)?.raw));
    expect(parsed.html).toContain("Updated");
    expect(parsed.attachments?.[0]).toMatchObject({
      disposition: "inline",
      contentId: "<photo@inboxzero.local>",
    });
    expect(Buffer.from(parsed.attachments?.[0]?.content || []).toString()).toBe(
      "hello",
    );
    mailboxState.draftSource = "";
  });

  it("keeps an attachment on a saved IMAP draft", async () => {
    appended.length = 0;
    mailboxState.draftSource = savedDraft();
    const provider = createImapProvider(imapConfig(), logger);
    const content = Buffer.from("hello file").toString("base64");

    await provider.updateDraft("<draft-1@example.com>", {
      messageHtml: "<p>Changed</p>",
      attachments: [
        { filename: "note.txt", content, contentType: "text/plain" },
      ],
    });

    const parsed = await new PostalMime().parse(String(appended.at(-1)?.raw));
    expect(parsed.html).toContain("Changed");
    expect(parsed.attachments?.[0]?.filename).toBe("note.txt");
    expect(Buffer.from(parsed.attachments?.[0]?.content || []).toString()).toBe(
      "hello file",
    );
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

  it("discards a draft that is older than the newest page", async () => {
    deleted.length = 0;
    mailboxState.exists = 101;
    mailboxState.draftMessages = [
      {
        uid: 1,
        flags: ["\\Draft", "\\Seen"],
        internalDate: "2026-08-01T12:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: sam@example.com",
          "Subject: Old draft",
          "Date: Sat, 01 Aug 2026 12:00:00 +0000",
          "Message-ID: <old-draft@example.com>",
          "",
          "Hold this older draft.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    const removed = await provider.deleteDraft("<old-draft@example.com>");

    expect(removed).toBe(true);
    expect(deleted).toEqual([{ mailbox: "Drafts", uid: 1 }]);
    mailboxState.draftMessages = [];
    mailboxState.exists = 1;
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
    mailboxState.sentMessages = [
      {
        uid: 12,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T14:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: other@example.com",
          "Bcc: hidden@example.com",
          "Subject: Quiet sent copy",
          "Date: Mon, 28 Sep 2026 14:00:00 +0000",
          "Message-ID: <quiet-sent@example.com>",
          "",
          "Sent with a blind copy.",
        ].join("\r\n"),
      },
    ];
    await expect(provider.checkIfReplySent("hidden@example.com")).resolves.toBe(
      true,
    );
    mailboxState.sentMessages = [];
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

  it("finds an older sent reply when newer mail only shares part of the address", async () => {
    const sentTo = (uid: number, to: string) => ({
      uid,
      flags: ["\\Seen"],
      internalDate: "2026-09-28T14:00:00.000Z",
      source: [
        "From: Owner <owner@example.com>",
        `To: ${to}`,
        "Subject: Sent note",
        "Date: Mon, 28 Sep 2026 14:00:00 +0000",
        `Message-ID: <sent-${uid}@example.com>`,
        "",
        "Sent note.",
      ].join("\r\n"),
    });
    mailboxState.sentMessages = [
      sentTo(1, "sam@example.com"),
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((uid) =>
        sentTo(uid, "notsam@example.com"),
      ),
    ];
    const provider = createImapProvider(imapConfig(), logger);

    await expect(provider.checkIfReplySent("sam@example.com")).resolves.toBe(
      true,
    );

    mailboxState.sentMessages = [];
  });

  it("finds a sent reply when the person is only on Cc", async () => {
    mailboxState.sentMessages = [
      {
        uid: 4,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T14:00:00.000Z",
        source: [
          "From: Owner <owner@example.com>",
          "To: list@example.com",
          "Cc: Sam <sam@example.com>",
          "Subject: Copied Sam",
          "Date: Mon, 28 Sep 2026 14:00:00 +0000",
          "Message-ID: <cc-sam@example.com>",
          "",
          "Copied Sam.",
        ].join("\r\n"),
      },
    ];
    const provider = createImapProvider(imapConfig(), logger);

    await expect(provider.checkIfReplySent("sam@example.com")).resolves.toBe(
      true,
    );

    mailboxState.sentMessages = [];
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

  it("returns a message when the looked-up person is the first of two senders", async () => {
    mailboxState.inboxMessages = [
      {
        uid: 1,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T14:00:00.000Z",
        source: [
          "From: Sam <sam@example.com>, Ada <ada@example.com>",
          "To: owner@example.com",
          "Subject: Two senders",
          "Date: Mon, 28 Sep 2026 14:00:00 +0000",
          "Message-ID: <two-senders-lookup@example.com>",
          "",
          "A note from both of them.",
        ].join("\r\n"),
      },
    ];
    mailboxState.fromUids = [1];
    const provider = createImapProvider(imapConfig(), logger);

    const first = await provider.getMessagesFromSender({
      senderEmail: "sam@example.com",
      maxResults: 5,
    });
    const second = await provider.getMessagesFromSender({
      senderEmail: "ada@example.com",
      maxResults: 5,
    });
    const neither = await provider.getMessagesFromSender({
      senderEmail: "other@example.com",
      maxResults: 5,
    });

    expect(first.messages.map((message) => message.subject)).toEqual([
      "Two senders",
    ]);
    expect(second.messages.map((message) => message.subject)).toEqual([
      "Two senders",
    ]);
    expect(neither.messages).toEqual([]);
    mailboxState.inboxMessages = [];
    mailboxState.fromUids = [];
  });

  it("returns an older message from a sender when newer mail is outside the date window", async () => {
    const fromSam = (
      uid: number,
      subject: string,
      date: string,
      internalDate: string,
    ) => ({
      uid,
      flags: ["\\Seen"],
      internalDate,
      source: [
        "From: Sam <sam@example.com>",
        "To: owner@example.com",
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: <sender-${uid}@example.com>`,
        "",
        subject,
      ].join("\r\n"),
    });
    mailboxState.inboxMessages = [
      fromSam(
        1,
        "Older note",
        "Tue, 01 Sep 2026 12:00:00 +0000",
        "2026-09-01T12:00:00.000Z",
      ),
      ...Array.from({ length: 50 }, (_, index) =>
        fromSam(
          index + 2,
          "Newer note",
          "Thu, 15 Oct 2026 12:00:00 +0000",
          "2026-10-15T12:00:00.000Z",
        ),
      ),
    ];
    mailboxState.fromUids = mailboxState.inboxMessages.map(
      (message) => message.uid,
    );
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getMessagesFromSender({
      senderEmail: "sam@example.com",
      before: new Date("2026-09-30T00:00:00.000Z"),
    });

    expect(result.messages.map((message) => message.subject)).toEqual([
      "Older note",
    ]);
    mailboxState.inboxMessages = [];
    mailboxState.fromUids = [];
  });

  it("returns the next page of mail from one sender", async () => {
    const fromSam = (uid: number, subject: string, date: string) => ({
      uid,
      flags: ["\\Seen"],
      internalDate: new Date(date).toISOString(),
      source: [
        "From: Sam <sam@example.com>",
        "To: owner@example.com",
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: <sender-${uid}@example.com>`,
        "",
        subject,
      ].join("\r\n"),
    });
    mailboxState.inboxMessages = [
      fromSam(1, "Oldest note", "Tue, 01 Sep 2026 12:00:00 +0000"),
      ...Array.from({ length: 50 }, (_, index) =>
        fromSam(index + 2, "Newer note", "Thu, 15 Oct 2026 12:00:00 +0000"),
      ),
    ];
    mailboxState.fromUids = mailboxState.inboxMessages.map(
      (message) => message.uid,
    );
    const provider = createImapProvider(imapConfig(), logger);

    const first = await provider.getMessagesFromSender({
      senderEmail: "sam@example.com",
      maxResults: 50,
    });
    const second = await provider.getMessagesFromSender({
      senderEmail: "sam@example.com",
      maxResults: 50,
      pageToken: first.nextPageToken,
    });

    expect(first.messages).toHaveLength(50);
    expect(first.nextPageToken).toBe("50");
    expect(second.messages.map((message) => message.subject)).toEqual([
      "Oldest note",
    ]);
    mailboxState.inboxMessages = [];
    mailboxState.fromUids = [];
  });

  it("returns the sender mail with the newest written date when that mail arrived earlier", async () => {
    const fromSam = (
      uid: number,
      subject: string,
      date: string,
      internalDate: string,
    ) => ({
      uid,
      flags: ["\\Seen"],
      internalDate,
      source: [
        "From: Sam <sam@example.com>",
        "To: owner@example.com",
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: <sender-date-${uid}@example.com>`,
        "",
        subject,
      ].join("\r\n"),
    });
    mailboxState.inboxMessages = [
      fromSam(
        1,
        "Written later",
        "Tue, 29 Sep 2026 12:00:00 +0000",
        "2026-09-01T12:00:00.000Z",
      ),
      fromSam(
        2,
        "Earlier written",
        "Wed, 02 Sep 2026 12:00:00 +0000",
        "2026-09-20T12:00:00.000Z",
      ),
      fromSam(
        3,
        "Recent arrival",
        "Thu, 03 Sep 2026 12:00:00 +0000",
        "2026-09-21T12:00:00.000Z",
      ),
    ];
    mailboxState.fromUids = [1, 2, 3];
    const provider = createImapProvider(imapConfig(), logger);

    const page = await provider.getMessagesFromSender({
      senderEmail: "sam@example.com",
      maxResults: 1,
    });

    expect(page.messages.map((message) => message.subject)).toEqual([
      "Written later",
    ]);
    mailboxState.inboxMessages = [];
    mailboxState.fromUids = [];
  });

  it("returns unread mail from a sender when newer mail is already read", async () => {
    const fromSam = (
      uid: number,
      subject: string,
      date: string,
      flags: string[],
    ) => ({
      uid,
      flags,
      internalDate: new Date(date).toISOString(),
      source: [
        "From: Sam <sam@example.com>",
        "To: owner@example.com",
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: <sender-${uid}@example.com>`,
        "",
        subject,
      ].join("\r\n"),
    });
    mailboxState.inboxMessages = [
      fromSam(1, "Still unread", "Tue, 01 Sep 2026 12:00:00 +0000", []),
      fromSam(2, "Read middle", "Tue, 15 Sep 2026 12:00:00 +0000", ["\\Seen"]),
      fromSam(3, "Read newest", "Sun, 20 Sep 2026 12:00:00 +0000", ["\\Seen"]),
    ];
    mailboxState.fromUids = [1, 2, 3];
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      maxResults: 1,
      query: { fromEmail: "sam@example.com", isUnread: true },
    });

    expect(result.threads.map((thread) => thread.messages[0]?.subject)).toEqual(
      ["Still unread"],
    );
    mailboxState.inboxMessages = [];
    mailboxState.fromUids = [];
  });

  it("returns recent subjects from one sender", async () => {
    mailboxState.fromUids = [1];
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
    mailboxState.fromUids = [];
  });

  it("returns threads from one sender", async () => {
    mailboxState.fromUids = [1];
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
    mailboxState.fromUids = [];
  });

  it("returns an archived sender when that mail is not in the inbox page", async () => {
    mailboxState.inboxMessages = [];
    mailboxState.fromUids = [9];
    mailboxState.archiveSource = archivedAttachment();
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      query: { fromEmail: "ads@example.com", type: "all" },
      maxResults: 5,
    });

    expect(result.threads.map((thread) => thread.messages[0]?.id)).toEqual([
      "Archive/9",
    ]);
    mailboxState.fromUids = [];
    mailboxState.archiveSource = "";
  });

  it("returns a sender's mail that lives in another folder", async () => {
    mailboxState.inboxMessages = [];
    mailboxState.fromUids = [14];
    mailboxState.archiveSource = "";
    mailboxState.listed = [
      { path: "INBOX", name: "INBOX" },
      { path: "Receipts", name: "Receipts" },
    ];
    mailboxState.folderSources = {
      Receipts: [
        "From: Billing <billing@example.com>",
        "To: owner@example.com",
        "Subject: Receipt folder check",
        "Date: Mon, 28 Sep 2026 23:51:00 +0000",
        "Message-ID: <receipt-folder-a0b4@example.com>",
        "",
        "This message is in Receipts.",
      ].join("\r\n"),
    };
    const provider = createImapProvider(imapConfig(), logger);

    const result = await provider.getThreadsWithQuery({
      query: { fromEmail: "billing@example.com", type: "all" },
      maxResults: 5,
    });

    expect(result.threads.map((thread) => thread.messages[0]?.id)).toEqual([
      "Receipts/14",
    ]);
    mailboxState.fromUids = [];
    mailboxState.listed = [{ path: "INBOX", name: "INBOX" }];
    mailboxState.folderSources = {};
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

function datedInboxMessage(subject: string, messageId: string, date: string) {
  return [
    "From: Sam <sam@example.com>",
    "To: inbox.imap@example.com",
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    "",
    subject,
  ].join("\r\n");
}

function sourcesForOpenedMailbox() {
  if (mailboxState.opened === "INBOX") return inboxMessagesForSearch();
  if (
    mailboxState.opened === "Archive" &&
    mailboxState.archiveMessages.length
  ) {
    return mailboxState.archiveMessages;
  }
  if (mailboxState.opened === "Archive" && mailboxState.archiveSource) {
    return [
      {
        uid: 9,
        source: mailboxState.archiveSource,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T13:00:00.000Z",
      },
    ];
  }
  if (mailboxState.opened === "Sent" && mailboxState.sentMessages.length) {
    return mailboxState.sentMessages;
  }
  if (mailboxState.opened === "Sent" && mailboxState.sentSource) {
    return [
      {
        uid: 11,
        source: mailboxState.sentSource,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T14:00:00.000Z",
      },
    ];
  }
  if (mailboxState.opened === "Trash" && mailboxState.trashSource) {
    return [
      {
        uid: 12,
        source: mailboxState.trashSource,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T15:00:00.000Z",
      },
    ];
  }
  if (mailboxState.opened === "Drafts" && mailboxState.draftMessages.length) {
    return mailboxState.draftMessages;
  }
  if (mailboxState.opened === "Drafts" && mailboxState.draftSource) {
    return [
      {
        uid: 13,
        source: mailboxState.draftSource,
        flags: ["\\Draft", "\\Seen"],
        internalDate: "2026-09-28T16:00:00.000Z",
      },
    ];
  }
  const folderSource = mailboxState.folderSources[mailboxState.opened];
  if (folderSource) {
    const source =
      typeof folderSource === "string" ? folderSource : folderSource.source;
    const uid = typeof folderSource === "string" ? 14 : folderSource.uid;
    return [
      {
        uid,
        source,
        flags: ["\\Seen"],
        internalDate: "2026-09-28T17:00:00.000Z",
      },
    ];
  }
  return [];
}

function inboxMessagesForSearch() {
  if (mailboxState.inboxMessages.length) return mailboxState.inboxMessages;
  return [
    {
      uid: 1,
      source: mailboxState.inboxSource || rawMessage,
      flags: ["\\Seen"],
      internalDate: "2026-09-28T12:00:00.000Z",
    },
  ];
}

function imapDateMatches(
  message: { flags: string[]; internalDate: string },
  query: { since?: Date; before?: Date; seen?: boolean },
) {
  const sentAt = new Date(message.internalDate).getTime();
  if (query.since && sentAt < utcDay(query.since)) return false;
  if (query.before && sentAt >= utcDay(query.before)) return false;
  if (query.seen === false && message.flags.includes("\\Seen")) return false;
  return true;
}

function utcDay(value: Date) {
  return Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
  );
}

function nestedMimeMessage() {
  const lines = [
    "From: Bad <bad@example.com>",
    "To: owner@example.com",
    "Subject: Too deep",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=b0",
    "",
  ];
  for (let depth = 0; depth < 300; depth++) {
    lines.push(`--b${depth}`);
    lines.push(`Content-Type: multipart/mixed; boundary=b${depth + 1}`);
    lines.push("");
  }
  return lines.join("\r\n");
}

function fetchTargets(
  range: string | undefined,
  messages: { uid: number }[],
  byUid: boolean,
) {
  if (!range) return new Set(messages.map((message) => message.uid));
  if (byUid) {
    return new Set(
      range
        .split(",")
        .map((uid) => Number(uid))
        .filter((uid) => Number.isFinite(uid)),
    );
  }
  const [startRaw, endRaw] = range.split(":");
  const start = Number(startRaw);
  const end = endRaw === undefined ? start : Number(endRaw);
  const uids = messages.slice(start - 1, end).map((message) => message.uid);
  return new Set(uids);
}

function replySource(
  overrides: {
    from?: string;
    to?: string;
    labelIds?: string[];
    subject?: string;
  } = {},
) {
  return {
    id: "INBOX/22",
    threadId: "<please-keep@example.com>",
    historyId: "",
    inline: [],
    snippet: "Please keep this note.",
    subject: overrides.subject ?? "Please keep this",
    date: "Mon, 01 Sep 2026 12:05:00 +0000",
    labelIds: overrides.labelIds ?? ["INBOX"],
    textPlain: "Please keep this note.",
    headers: {
      from: overrides.from ?? "Sam <sam@example.com>",
      to: overrides.to ?? "Starttls <owner@example.com>",
      subject: overrides.subject ?? "Please keep this",
      date: "Mon, 01 Sep 2026 12:05:00 +0000",
      "message-id": "<please-keep@example.com>",
      references: "<older@example.com>",
    },
  };
}

function sentUidsWithHeader(
  messages: { uid: number; source: string }[],
  name: string,
  value: string,
) {
  return messages
    .filter((message) => headerLineIncludes(message.source, name, value))
    .map((message) => message.uid);
}

function headerLineIncludes(source: string, name: string, value: string) {
  const needle = value.toLowerCase();
  return source.split(/\r?\n/).some((line) => {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) return false;
    return (
      match[1]?.toLowerCase() === name.toLowerCase() &&
      match[2]?.toLowerCase().includes(needle)
    );
  });
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
