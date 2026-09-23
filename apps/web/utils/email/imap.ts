import { Readable } from "node:stream";
import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import nodemailer from "nodemailer";
import { SafeError } from "@/utils/error";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import type { SendEmailBody } from "@/utils/types/mail";

type ImapConfig = {
  emailAccountId: string;
  ownerEmail: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUsername: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpPassword: string;
  syncFolder: string;
};

type ParsedAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  content: Uint8Array;
};

type ParsedImapMessage = ParsedMessage & {
  _attachments: ParsedAttachment[];
  _uid: number;
};

const DEFAULT_PAGE_SIZE = 20;

export function createImapProvider(
  config: ImapConfig,
  logger: Logger,
): EmailProvider {
  const core = {
    name: "imap" as const,
    localMailSyncStrategy: "account-history" as const,
    toJSON: () => ({ name: "imap", type: "imap" }),
    getAccessToken: () => "imap",
    isReplyInThread: (message: ParsedMessage) =>
      Boolean(message.headers["in-reply-to"] || message.headers.references),
    isSentMessage: (message: ParsedMessage) =>
      message.headers.from
        .toLowerCase()
        .includes(config.ownerEmail.toLowerCase()),
    getThreads: async () => {
      const messages = await fetchMailboxMessages({ config, logger });
      return groupToThreads(messages);
    },
    getInboxMessages: async (maxResults = DEFAULT_PAGE_SIZE) => {
      const messages = await fetchMailboxMessages({
        config,
        logger,
        maxResults,
      });
      return messages;
    },
    getSentMessages: async (maxResults = DEFAULT_PAGE_SIZE) => {
      const sentFolders = ["Sent", "Sent Items", "[Gmail]/Sent Mail"];
      for (const folder of sentFolders) {
        try {
          return await fetchMailboxMessages({
            config,
            logger,
            mailbox: folder,
            maxResults,
          });
        } catch {}
      }
      return [];
    },
    getMessagesWithPagination: async ({
      maxResults = DEFAULT_PAGE_SIZE,
      pageToken,
      query,
    }: {
      query?: string;
      maxResults?: number;
      pageToken?: string;
    }) => {
      const offset = Number(pageToken || "0");
      const messages = await fetchMailboxMessages({
        config,
        logger,
        maxResults: maxResults + offset,
      });
      const filtered = query
        ? messages.filter((message) => {
            const haystack =
              `${message.subject}\n${message.snippet}\n${message.textPlain || ""}`.toLowerCase();
            return haystack.includes(query.toLowerCase());
          })
        : messages;
      const slice = filtered.slice(offset, offset + maxResults);
      const nextPageToken =
        offset + maxResults < filtered.length
          ? String(offset + maxResults)
          : undefined;
      return { messages: slice, nextPageToken };
    },
    getMessage: async (messageId: string) => {
      const message = await fetchMessageById({ config, logger, messageId });
      if (!message) throw new SafeError("Message not found");
      return message;
    },
    getMessagesBatch: async (messageIds: string[]) => {
      const messages = await Promise.all(
        messageIds.map((messageId) =>
          fetchMessageById({ config, logger, messageId }),
        ),
      );
      return messages.filter((message): message is ParsedMessage =>
        Boolean(message),
      );
    },
    getThread: async (threadId: string) => {
      const messages = await fetchMailboxMessages({
        config,
        logger,
        maxResults: 100,
      });
      const threadMessages = messages.filter(
        (message) => message.threadId === threadId,
      );
      if (threadMessages.length === 0) throw new SafeError("Thread not found");
      return toThread(threadMessages);
    },
    getThreadMessages: async (threadId: string) => {
      const thread = await core.getThread(threadId);
      return thread.messages;
    },
    getThreadMessagesInInbox: async (threadId: string) =>
      core.getThreadMessages(threadId),
    getLatestMessageInThread: async (threadId: string) => {
      const messages = await core.getThreadMessages(threadId);
      return messages.at(-1) ?? null;
    },
    getLatestMessageFromThreadSnapshot: async (thread: EmailThread) =>
      thread.messages.at(-1) ?? null,
    getMessageByRfc822MessageId: async (rfc822MessageId: string) => {
      const messages = await fetchMailboxMessages({
        config,
        logger,
        maxResults: 100,
      });
      return (
        messages.find(
          (message) => message.headers["message-id"] === rfc822MessageId,
        ) ?? null
      );
    },
    searchMessages: async ({
      query,
      maxResults = DEFAULT_PAGE_SIZE,
      pageToken,
    }) => core.getMessagesWithPagination({ query, maxResults, pageToken }),
    searchThreads: async ({
      query,
      maxResults = DEFAULT_PAGE_SIZE,
      pageToken,
    }) => {
      const { messages, nextPageToken } = await core.getMessagesWithPagination({
        query,
        maxResults: maxResults * 2,
        pageToken,
      });
      const threads = groupToThreads(messages).slice(0, maxResults);
      return { threads, nextPageToken };
    },
    getMailboxSyncPage: async ({ after, limit, cursor }) => {
      const cursorDate = cursor ? new Date(cursor) : after;
      const messages = await fetchMailboxMessages({
        config,
        logger,
        maxResults: limit || DEFAULT_PAGE_SIZE,
      });
      const upsertedMessages = cursorDate
        ? messages.filter((message) => new Date(message.date) > cursorDate)
        : messages;
      return {
        changedThreadIds: [
          ...new Set(upsertedMessages.map((message) => message.threadId)),
        ],
        cursor: new Date().toISOString(),
        deletedMessageIds: [],
        hasMore: false,
        removedMessageIds: [],
        reset: false,
        upsertedMessages,
      };
    },
    getAttachment: async (messageId: string, attachmentId: string) => {
      const message = await fetchMessageById({
        config,
        logger,
        messageId,
        includeAttachmentBodies: true,
      });
      if (!message) throw new SafeError("Message not found");
      const attachment = message._attachments.find(
        (a) => a.id === attachmentId,
      );
      if (!attachment) throw new SafeError("Attachment not found");
      return {
        data: Buffer.from(attachment.content).toString("base64"),
        size: attachment.size,
      };
    },
    getAttachmentStream: async (messageId: string, attachmentId: string) => {
      const attachment = await core.getAttachment(messageId, attachmentId);
      const buffer = Buffer.from(attachment.data, "base64");
      return Readable.toWeb(
        Readable.from([buffer]),
      ) as ReadableStream<Uint8Array>;
    },
    sendEmail: async ({ to, cc, bcc, subject, messageText, attachments }) => {
      const transport = createSmtpTransport(config);
      const result = await transport.sendMail({
        from: config.ownerEmail,
        to,
        cc,
        bcc,
        subject,
        text: messageText,
        attachments,
      });
      return { messageId: result.messageId || `smtp-${Date.now()}` };
    },
    sendEmailWithHtml: async (body: SendEmailBody) => {
      const transport = createSmtpTransport(config);
      const result = await transport.sendMail({
        from: body.from || config.ownerEmail,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        replyTo: body.replyTo,
        subject: body.subject,
        html: body.messageHtml,
        attachments: body.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          encoding: "base64",
          contentType: attachment.contentType,
        })),
      });
      return {
        messageId: result.messageId || `smtp-${Date.now()}`,
        threadId: body.replyToEmail?.threadId || `smtp-thread-${Date.now()}`,
      };
    },
    replyToEmail: async (email: ParsedMessage, content: string) => {
      const sent = await core.sendEmail({
        to: email.headers.from,
        subject: email.subject.startsWith("Re:")
          ? email.subject
          : `Re: ${email.subject}`,
        messageText: content,
      });
      return { messageId: sent.messageId };
    },
    forwardEmail: async (
      email: ParsedMessage,
      args: { to: string; cc?: string; bcc?: string; content?: string },
    ) =>
      core.sendEmail({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: email.subject.startsWith("Fwd:")
          ? email.subject
          : `Fwd: ${email.subject}`,
        messageText: `${args.content || ""}\n\n${email.textPlain || email.snippet}`,
      }),
    markReadThread: async (threadId: string, read: boolean) => {
      const messages = await core.getThreadMessages(threadId);
      await Promise.all(
        messages.map((message) => setSeenFlag({ config, message, read })),
      );
    },
    markRead: async (threadId: string) => core.markReadThread(threadId, true),
    markMessagesReadState: async (messageIds: string[], read: boolean) => {
      const messages = await core.getMessagesBatch(messageIds);
      await Promise.all(
        messages.map((message) => setSeenFlag({ config, message, read })),
      );
    },
    archiveMessage: async (messageId: string) =>
      moveMessageToMailbox({
        config,
        logger,
        messageId,
        mailbox: "Archive",
      }),
    archiveMessages: async (messageIds: string[]) =>
      Promise.all(
        messageIds.map((messageId) => core.archiveMessage(messageId)),
      ).then(() => undefined),
    trashMessages: async (messageIds: string[]) =>
      Promise.all(
        messageIds.map((messageId) =>
          moveMessageToMailbox({ config, logger, messageId, mailbox: "Trash" }),
        ),
      ).then(() => undefined),
    untrashMessages: async (messageIds: string[]) =>
      Promise.all(
        messageIds.map((messageId) =>
          moveMessageToMailbox({ config, logger, messageId, mailbox: "INBOX" }),
        ),
      ).then(() => undefined),
    unarchiveMessages: async (messageIds: string[]) =>
      core.untrashMessages(messageIds),
    getFolders: async () => {
      const client = createImapClient(config);
      await client.connect();
      try {
        const boxes = await client.list();
        return boxes.map((box) => ({
          id: box.path,
          displayName: box.name,
          childFolders: [],
          totalItemCount: 0,
          unreadItemCount: 0,
          isHidden: false,
        }));
      } finally {
        await client.logout().catch(() => undefined);
      }
    },
    getFolderCounts: async () => [],
    watchEmails: async () => null,
    unwatchEmails: async () => undefined,
    syncLocalMail: async () => ({
      cursor: null,
      page: { fetched: 0, hasMore: false, messages: [], removedIds: [] },
      reset: false,
      runtimeMs: 0,
    }),
  };

  return new Proxy(core as EmailProvider, {
    get(target, property, receiver) {
      // `then` must stay absent. An async caller adopts a thenable return
      // value, and this proxy would otherwise reject with "then".
      if (
        property === "then" ||
        property === "catch" ||
        property === "finally"
      ) {
        return undefined;
      }
      const value = Reflect.get(target, property, receiver);
      if (value !== undefined) return value;
      if (typeof property !== "string") return value;
      return async () => {
        throw new SafeError(
          `IMAP provider method not implemented yet: ${property}`,
        );
      };
    },
  });
}

function createImapClient(config: ImapConfig) {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: {
      user: config.imapUsername,
      pass: config.imapPassword,
    },
    logger: false,
  });
}

function createSmtpTransport(config: ImapConfig) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUsername,
      pass: config.smtpPassword,
    },
  });
}

async function fetchMailboxMessages({
  config,
  logger,
  mailbox,
  maxResults = DEFAULT_PAGE_SIZE,
}: {
  config: ImapConfig;
  logger: Logger;
  mailbox?: string;
  maxResults?: number;
}): Promise<ParsedImapMessage[]> {
  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(
      mailbox || config.syncFolder || "INBOX",
    );
    try {
      // ImapFlow stores the selected mailbox on the client. The lock has no mailbox field.
      const openedMailbox = client.mailbox;
      if (!openedMailbox) return [];
      const messageCount = openedMailbox.exists;
      if (!messageCount) return [];
      const start = Math.max(1, messageCount - maxResults + 1);
      const messages: ParsedImapMessage[] = [];
      for await (const message of client.fetch(`${start}:${messageCount}`, {
        uid: true,
        envelope: true,
        source: true,
        flags: true,
        internalDate: true,
      })) {
        if (!message.source) continue;
        messages.push(
          await parseImapMessage(
            message.uid,
            message.source,
            message.flags,
            message.internalDate,
          ),
        );
      }
      return messages.sort(
        (a, b) => Number(a.internalDate || "0") - Number(b.internalDate || "0"),
      );
    } finally {
      lock.release();
    }
  } catch (error) {
    logger.error("Failed fetching IMAP messages", {
      error,
      emailAccountId: config.emailAccountId,
    });
    throw new SafeError("Failed to read IMAP mailbox");
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function fetchMessageById({
  config,
  logger,
  messageId,
  includeAttachmentBodies = false,
}: {
  config: ImapConfig;
  logger: Logger;
  messageId: string;
  includeAttachmentBodies?: boolean;
}): Promise<ParsedImapMessage | null> {
  const uid = Number(messageId);
  if (!Number.isFinite(uid)) return null;
  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.syncFolder || "INBOX");
    try {
      const message = await client.fetchOne(
        uid,
        { uid: true, source: true, flags: true, internalDate: true },
        { uid: true },
      );
      if (!message?.source) return null;
      return parseImapMessage(
        message.uid,
        message.source,
        message.flags,
        message.internalDate,
        includeAttachmentBodies,
      );
    } finally {
      lock.release();
    }
  } catch (error) {
    logger.error("Failed fetching IMAP message", {
      error,
      uid,
      emailAccountId: config.emailAccountId,
    });
    return null;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function parseImapMessage(
  uid: number,
  source: Buffer,
  flags: Set<string>,
  internalDate?: Date,
  includeAttachmentBodies = false,
): Promise<ParsedImapMessage> {
  const parsed = await new PostalMime().parse(source);
  const subject = (parsed.subject || "").trim();
  const htmlBody =
    typeof parsed.html === "string"
      ? parsed.html
      : Buffer.isBuffer(parsed.html)
        ? parsed.html.toString("utf8")
        : "";
  const textBody =
    typeof parsed.text === "string"
      ? parsed.text
      : Buffer.isBuffer(parsed.text)
        ? parsed.text.toString("utf8")
        : "";
  const from = parsed.from?.address
    ? `${parsed.from.name ? `${parsed.from.name} ` : ""}<${parsed.from.address}>`
    : "";
  const to = (parsed.to || [])
    .map((entry) => entry.address)
    .filter(Boolean)
    .join(", ");
  const cc = (parsed.cc || [])
    .map((entry) => entry.address)
    .filter(Boolean)
    .join(", ");
  const attachments = (parsed.attachments || []).map((attachment, index) => {
    const content = attachment.content
      ? new Uint8Array(attachment.content)
      : new Uint8Array();
    return {
      id: `${uid}:${index}`,
      filename: attachment.filename || `attachment-${index + 1}`,
      mimeType: attachment.mimeType || "application/octet-stream",
      size: content.byteLength,
      content,
    };
  });
  const historyId = String((internalDate || new Date()).getTime());
  const normalizedSubject = subject.toLowerCase().replace(/^(re|fwd):\s*/g, "");
  const threadKey =
    parsed.headers.get("references") ||
    parsed.headers.get("in-reply-to") ||
    normalizedSubject ||
    String(uid);

  return {
    id: String(uid),
    threadId: threadKey,
    historyId,
    date: (internalDate || new Date()).toISOString(),
    internalDate: historyId,
    subject,
    snippet: (textBody || htmlBody || "").slice(0, 280),
    textPlain: textBody || undefined,
    textHtml: htmlBody || undefined,
    bodyContentType: htmlBody ? "html" : "text",
    hasAttachment: attachments.length > 0,
    attachments: attachments.map((attachment) => ({
      attachmentId: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      headers: {
        "content-description": attachment.filename,
        "content-id": attachment.id,
        "content-transfer-encoding": "base64",
        "content-type": attachment.mimeType,
      },
    })),
    inline: [],
    labelIds: [...flags],
    headers: {
      from,
      to,
      cc: cc || undefined,
      bcc: undefined,
      date: parsed.date
        ? new Date(parsed.date).toISOString()
        : new Date().toISOString(),
      subject,
      "reply-to": parsed.replyTo?.[0]?.address || undefined,
      "message-id": parsed.messageId || undefined,
      references: parsed.headers.get("references") || undefined,
      "in-reply-to": parsed.headers.get("in-reply-to") || undefined,
    },
    _attachments: includeAttachmentBodies ? attachments : [],
    _uid: uid,
  };
}

function groupToThreads(messages: ParsedMessage[]): EmailThread[] {
  const map = new Map<string, ParsedMessage[]>();
  for (const message of messages) {
    const existing = map.get(message.threadId) || [];
    existing.push(message);
    map.set(message.threadId, existing);
  }
  return [...map.values()]
    .map((threadMessages) =>
      toThread(
        threadMessages.sort(
          (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
        ),
      ),
    )
    .sort(
      (a, b) =>
        new Date(b.messages.at(-1)?.date || 0).getTime() -
        new Date(a.messages.at(-1)?.date || 0).getTime(),
    );
}

function toThread(messages: ParsedMessage[]): EmailThread {
  const latest = messages.at(-1);
  return {
    id: latest?.threadId || "",
    historyId: latest?.historyId,
    messages,
    snippet: latest?.snippet || "",
    participantMessages: messages.map((message) => ({
      headers: {
        from: message.headers.from,
        to: message.headers.to,
      },
    })),
  };
}

async function setSeenFlag({
  config,
  message,
  read,
}: {
  config: ImapConfig;
  message: ParsedMessage;
  read: boolean;
}) {
  const uid = Number(message.id);
  if (!Number.isFinite(uid)) return;
  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.syncFolder || "INBOX");
    try {
      if (read) await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      else await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function moveMessageToMailbox({
  config,
  logger,
  messageId,
  mailbox,
}: {
  config: ImapConfig;
  logger: Logger;
  messageId: string;
  mailbox: string;
}) {
  const uid = Number(messageId);
  if (!Number.isFinite(uid)) return;
  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.syncFolder || "INBOX");
    try {
      await client.messageMove(uid, mailbox, { uid: true });
    } finally {
      lock.release();
    }
  } catch (error) {
    logger.error("Failed moving IMAP message", {
      error,
      messageId,
      mailbox,
      emailAccountId: config.emailAccountId,
    });
    throw new SafeError(`Failed to move message to ${mailbox}`);
  } finally {
    await client.logout().catch(() => undefined);
  }
}
