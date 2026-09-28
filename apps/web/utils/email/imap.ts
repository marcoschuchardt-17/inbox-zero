import { Readable } from "node:stream";
import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import nodemailer from "nodemailer";
import { shouldSkipAutoDraft } from "@/utils/auto-draft";
import {
  extractDomainFromEmail,
  extractEmailAddress,
  extractEmailAddresses,
  extractNameFromEmail,
  getSearchTermForSender,
} from "@/utils/email";
import { SafeError } from "@/utils/error";
import { imapFlagsToLabelIds, imapKeyword } from "@/utils/email/imap-flags";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
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
  _mailbox?: string;
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
    getSentMessages: async (maxResults = DEFAULT_PAGE_SIZE) =>
      fetchSentMessages({ config, logger, maxResults }),
    getSentMessageIds: async ({ maxResults, after, before }) => {
      const messages = await core.getSentMessages(maxResults);
      const inRange = messages.filter((message) => {
        const sentAt = new Date(message.date);
        if (Number.isNaN(sentAt.getTime())) return false;
        if (after && sentAt < after) return false;
        if (before && sentAt > before) return false;
        return true;
      });
      // The sent fetch already returns the newest page. A second page would
      // repeat that same window, so response-time stats stop after one page.
      return {
        messages: inRange.slice(0, maxResults).map((message) => ({
          id: message.id,
          threadId: message.threadId,
        })),
      };
    },
    hasPreviousCommunicationsWithSenderOrDomain: async ({
      from,
      date,
      messageId,
    }) =>
      hasEarlierImapCorrespondence({
        config,
        logger,
        from,
        date,
        messageId,
      }),
    getMessagesWithPagination: async ({
      maxResults = DEFAULT_PAGE_SIZE,
      pageToken,
      query,
    }: {
      query?: string;
      maxResults?: number;
      pageToken?: string;
    }) => {
      if (!pageToken) {
        await reconcileStoredInbox(config);
        await storeSentMailbox({ config, logger });
      }
      const offset = Number(pageToken || "0");
      const messages = await fetchMailboxMessages({
        config,
        logger,
        maxResults: maxResults + offset,
      });
      await dropStaleThreadCopies({
        emailAccountId: config.emailAccountId,
        messages,
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
      const mailboxes = [
        config.syncFolder || "INBOX",
        "Sent",
        "Archive",
        "Trash",
        "Drafts",
      ].filter(
        (mailbox, index, all) =>
          all.findIndex(
            (item) => item.toLowerCase() === mailbox.toLowerCase(),
          ) === index,
      );
      const collected: ParsedImapMessage[] = [];
      for (const [index, mailbox] of mailboxes.entries()) {
        let messages: ParsedImapMessage[] = [];
        try {
          messages = await fetchMailboxMessages({
            config,
            logger,
            mailbox,
            maxResults: 100,
          });
        } catch (error) {
          if (index === 0) throw error;
          if (isMissingImapMailbox(error)) continue;
          logger.warn("Skipped IMAP folder while opening a thread", {
            error,
            mailbox,
          });
        }
        for (const message of messages) {
          if (message.threadId !== threadId) continue;
          collected.push({ ...message, _mailbox: mailbox });
        }
      }
      const threadMessages = messagesForOpenThread(collected);
      if (!threadMessages.length) throw new SafeError("Thread not found");
      return toThread(threadMessages);
    },
    getThreadMessages: async (threadId: string) => {
      try {
        const thread = await core.getThread(threadId);
        return thread.messages;
      } catch (error) {
        if (isMissingThread(error)) return [];
        throw error;
      }
    },
    getThreadMessagesInInbox: async (threadId: string) =>
      inboxCopies(await core.getThreadMessages(threadId)),
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
    getThreadsWithQuery: async ({ query, maxResults = DEFAULT_PAGE_SIZE }) => {
      let messages: ParsedMessage[] = [];
      const mailbox =
        (query?.type ? mailboxForListType(query.type) : undefined) ||
        query?.folderId ||
        undefined;
      if (query?.type === "sent") {
        messages = await core.getSentMessages(maxResults);
      } else if (mailbox) {
        try {
          messages = await fetchMailboxMessages({
            config,
            logger,
            mailbox,
            maxResults,
          });
        } catch (error) {
          logger.warn("Skipped IMAP folder", {
            error,
            mailbox,
            emailAccountId: config.emailAccountId,
          });
        }
      } else {
        messages = await fetchMailboxMessages({
          config,
          logger,
          maxResults,
        });
      }
      const fromEmail = query?.fromEmail?.trim().toLowerCase();
      const filtered = messages.filter((message) => {
        if (
          fromEmail &&
          !message.headers.from.toLowerCase().includes(fromEmail)
        ) {
          return false;
        }
        if (query?.isUnread && !message.labelIds?.includes("UNREAD")) {
          return false;
        }
        if (query?.labelId && !message.labelIds?.includes(query.labelId)) {
          return false;
        }
        return true;
      });
      return { threads: groupToThreads(filtered).slice(0, maxResults) };
    },
    getThreadsFromSenderWithSubject: async (sender: string, limit: number) => {
      const { threads } = await core.getThreadsWithQuery({
        query: { fromEmail: sender },
        maxResults: limit,
      });
      return threads.map((thread) => ({
        id: thread.id,
        snippet: thread.snippet,
        subject: thread.messages[0]?.subject || "",
      }));
    },
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
      const messageId = `smtp-${Date.now()}`;
      const result = await transport.sendMail({
        from: config.ownerEmail,
        to,
        cc,
        bcc,
        subject,
        text: messageText,
        attachments,
        messageId,
      });
      const savedId = result.messageId || messageId;
      await saveSentCopy({
        config,
        logger,
        raw: buildOutgoingMessage({
          from: config.ownerEmail,
          to,
          cc,
          bcc,
          subject,
          messageId: savedId,
          contentType: "text/plain; charset=utf-8",
          body: messageText,
        }),
      });
      return { messageId: savedId };
    },
    sendEmailWithHtml: async (body: SendEmailBody) => {
      const transport = createSmtpTransport(config);
      const messageId = `smtp-${Date.now()}`;
      const references =
        body.replyToEmail?.references || body.replyToEmail?.headerMessageId;
      const result = await transport.sendMail({
        from: body.from || config.ownerEmail,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        replyTo: body.replyTo,
        subject: body.subject,
        html: body.messageHtml,
        messageId,
        inReplyTo: body.replyToEmail?.headerMessageId,
        references,
        attachments: body.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          encoding: "base64",
          contentType: attachment.contentType,
        })),
      });
      const savedId = result.messageId || messageId;
      await saveSentCopy({
        config,
        logger,
        raw: buildOutgoingMessage({
          from: body.from || config.ownerEmail,
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          subject: body.subject,
          messageId: savedId,
          inReplyTo: body.replyToEmail?.headerMessageId,
          references,
          contentType: "text/html; charset=utf-8",
          body: body.messageHtml,
        }),
      });
      return {
        messageId: savedId,
        threadId: body.replyToEmail?.threadId || `smtp-thread-${Date.now()}`,
      };
    },
    draftEmail: async (email, args, userEmail) => {
      if (shouldSkipAutoDraft({ logger, source: "imap" })) {
        return { draftId: "" };
      }

      const client = createImapClient(config);
      await client.connect();
      try {
        await ensureMailbox(client, "Drafts");
        const appended = await client.append(
          "Drafts",
          buildDraftMessage({ email, args, from: userEmail }),
          ["\\Draft"],
        );
        return { draftId: String(appended?.uid ?? "") };
      } catch (error) {
        logger.error("Failed saving IMAP draft", {
          error,
          emailAccountId: config.emailAccountId,
        });
        throw new SafeError("Failed to save IMAP draft");
      } finally {
        await client.logout().catch(() => undefined);
      }
    },
    sendDraft: async (draftId: string) => {
      const drafts = await findDraftMessages({ config, logger, draftId });
      const draft = drafts.at(-1);
      if (!draft?.headers.to) throw new SafeError("Draft not found");
      const transport = createSmtpTransport(config);
      const messageId = `smtp-${Date.now()}`;
      const inReplyTo = draft.headers["in-reply-to"];
      const references = draft.headers.references || inReplyTo;
      const text = draft.textPlain || draft.snippet;
      const result = await transport.sendMail({
        from: config.ownerEmail,
        to: draft.headers.to,
        cc: draft.headers.cc,
        subject: draft.subject,
        text,
        html: draft.textHtml,
        messageId,
        inReplyTo,
        references,
      });
      const savedId = result.messageId || messageId;
      await saveSentCopy({
        config,
        logger,
        raw: buildOutgoingMessage({
          from: config.ownerEmail,
          to: draft.headers.to,
          cc: draft.headers.cc,
          subject: draft.subject,
          messageId: savedId,
          inReplyTo,
          references,
          contentType: draft.textHtml
            ? "text/html; charset=utf-8"
            : "text/plain; charset=utf-8",
          body: draft.textHtml || text,
        }),
      });
      await Promise.all(
        drafts.map((message) =>
          deleteDraftMessage({ config, logger, messageId: message.id }),
        ),
      );
      return { messageId: savedId, threadId: draft.threadId };
    },
    deleteDraft: async (draftId: string) => {
      const drafts = await findDraftMessages({ config, logger, draftId });
      if (!drafts.length) throw new SafeError("Draft not found");
      await Promise.all(
        drafts.map((message) =>
          deleteDraftMessage({ config, logger, messageId: message.id }),
        ),
      );
      return true;
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
      const messages = inboxCopies(await core.getThreadMessages(threadId));
      await Promise.all(
        messages.map((message) => setSeenFlag({ config, message, read })),
      );
      await markStoredReadState({
        emailAccountId: config.emailAccountId,
        messageIds: messages.map((message) => message.id),
        read,
      });
    },
    markRead: async (threadId: string) => core.markReadThread(threadId, true),
    starMessage: async (messageId: string) => {
      await setSystemFlag({
        config,
        messageId,
        flag: "\\Flagged",
        enabled: true,
      });
    },
    markMessagesStarredState: async (
      messageIds: string[],
      starred: boolean,
    ) => {
      await Promise.all(
        messageIds.map((messageId) =>
          setSystemFlag({
            config,
            messageId,
            flag: "\\Flagged",
            enabled: starred,
          }),
        ),
      );
    },
    markSpam: async (threadId: string) => {
      const messages = inboxCopies(await core.getThreadMessages(threadId));
      if (!messages.length) throw new SafeError("Thread not found");
      const messageIds = messages.map((message) => message.id);
      await Promise.all(
        messageIds.map((messageId) =>
          moveMessageToMailbox({
            config,
            logger,
            messageId,
            mailbox: "Junk",
          }),
        ),
      );
      await markMessagesLeftInbox({
        emailAccountId: config.emailAccountId,
        messageIds,
        action: "spam",
      });
    },
    markNotSpam: async (threadId: string) => {
      const messages = await fetchMailboxMessages({
        config,
        logger,
        mailbox: "Junk",
        maxResults: 100,
      });
      const matches = messages.filter(
        (message) => message.threadId === threadId,
      );
      if (!matches.length) throw new SafeError("Thread not found");
      await Promise.all(
        matches.map((message) =>
          moveMessageToMailbox({
            config,
            logger,
            messageId: message.id,
            mailbox: config.syncFolder || "INBOX",
            sourceMailbox: "Junk",
          }),
        ),
      );
      await prisma.emailMessage.updateMany({
        where: {
          emailAccountId: config.emailAccountId,
          messageId: { in: matches.map((message) => message.id) },
        },
        data: { inbox: true },
      });
    },
    getOrCreateFolderIdByName: async (folderName: string) => {
      const name = folderName.trim();
      if (!name) throw new SafeError("Folder name is required");
      const client = createImapClient(config);
      await client.connect();
      try {
        await ensureMailbox(client, name);
        return name;
      } finally {
        await client.logout().catch(() => undefined);
      }
    },
    moveThreadToFolder: async (
      threadId: string,
      _ownerEmail: string,
      folderName: string,
    ) => {
      const messages = inboxCopies(await core.getThreadMessages(threadId));
      if (!messages.length) throw new SafeError("Thread not found");
      const messageIds = messages.map((message) => message.id);
      await Promise.all(
        messageIds.map((messageId) =>
          moveMessageToMailbox({
            config,
            logger,
            messageId,
            mailbox: folderName,
          }),
        ),
      );
      await markMessagesLeftInbox({
        emailAccountId: config.emailAccountId,
        messageIds,
        action: "archive",
      });
    },
    restoreThreadFromMailbox: async (
      threadId: string,
      sourceMailbox: string,
    ) => {
      if (sourceMailbox.toLowerCase() === "junk") {
        await core.markNotSpam(threadId);
        return;
      }
      const messages = await fetchMailboxMessages({
        config,
        logger,
        mailbox: sourceMailbox,
        maxResults: 100,
      });
      const matches = messages.filter(
        (message) => message.threadId === threadId,
      );
      if (!matches.length) throw new SafeError("Thread not found");
      const destination = config.syncFolder || "INBOX";
      await Promise.all(
        matches.map((message) =>
          moveMessageToMailbox({
            config,
            logger,
            messageId: message.id,
            mailbox: destination,
            sourceMailbox,
          }),
        ),
      );
      await prisma.emailMessage.updateMany({
        where: {
          emailAccountId: config.emailAccountId,
          messageId: { in: matches.map((message) => message.id) },
        },
        data: { inbox: true },
      });
    },
    markMessagesReadState: async (messageIds: string[], read: boolean) => {
      const messages = await core.getMessagesBatch(messageIds);
      await Promise.all(
        messages.map((message) => setSeenFlag({ config, message, read })),
      );
      await markStoredReadState({
        emailAccountId: config.emailAccountId,
        messageIds: messages.map((message) => message.id),
        read,
      });
    },
    archiveMessage: async (messageId: string) => {
      await moveMessageToMailbox({
        config,
        logger,
        messageId,
        mailbox: "Archive",
      });
      await markMessagesLeftInbox({
        emailAccountId: config.emailAccountId,
        messageIds: [messageId],
        action: "archive",
      });
    },
    archiveMessages: async (messageIds: string[]) =>
      Promise.all(
        messageIds.map((messageId) => core.archiveMessage(messageId)),
      ).then(() => undefined),
    archiveThread: async (threadId: string, _ownerEmail: string) => {
      const messages = inboxCopies(await core.getThreadMessages(threadId));
      await Promise.all(
        messages.map((message) => core.archiveMessage(message.id)),
      );
    },
    archiveThreadWithLabel: async (threadId: string, ownerEmail: string) => {
      await core.archiveThread(threadId, ownerEmail);
    },
    bulkArchiveFromSenders: async (fromEmails: string[]) => {
      await moveMessagesFromSenders({
        config,
        logger,
        fromEmails,
        mailbox: "Archive",
      });
    },
    bulkTrashFromSenders: async (fromEmails: string[]) => {
      await moveMessagesFromSenders({
        config,
        logger,
        fromEmails,
        mailbox: "Trash",
      });
    },
    bulkArchiveThreads: async (threads) => {
      const succeededThreadIds: string[] = [];
      const failedThreadIds: string[] = [];
      for (const thread of threads) {
        if (!thread.messageIds.length) {
          failedThreadIds.push(thread.threadId);
          continue;
        }
        try {
          await core.archiveMessages(thread.messageIds);
          succeededThreadIds.push(thread.threadId);
        } catch (error) {
          logger.error("Failed archiving IMAP thread", {
            error,
            threadId: thread.threadId,
          });
          failedThreadIds.push(thread.threadId);
        }
      }
      return { succeededThreadIds, failedThreadIds };
    },
    trashThread: async (threadId: string) => {
      const messages = inboxCopies(await core.getThreadMessages(threadId));
      await core.trashMessages(messages.map((message) => message.id));
    },
    removeThreadLabel: async (threadId: string, labelId: string) => {
      const messages = inboxCopies(await core.getThreadMessages(threadId));
      const keyword = imapKeyword(labelId);
      await Promise.all(
        messages.map((message) =>
          removeKeywordFlag({
            config,
            messageId: message.id,
            keyword,
          }),
        ),
      );
    },
    removeThreadLabels: async (threadId: string, labelIds: string[]) => {
      for (const labelId of labelIds) {
        await core.removeThreadLabel(threadId, labelId);
      }
    },
    getSignatures: async () => [],
    searchContacts: async () => [],
    unarchiveThread: async (threadId: string) => {
      await moveThreadBetweenMailboxes({
        config,
        logger,
        threadId,
        sourceMailbox: "Archive",
        destinationMailbox: config.syncFolder || "INBOX",
      });
    },
    untrashThread: async (threadId: string) => {
      await moveThreadBetweenMailboxes({
        config,
        logger,
        threadId,
        sourceMailbox: "Trash",
        destinationMailbox: config.syncFolder || "INBOX",
      });
    },
    trashMessages: async (messageIds: string[]) => {
      await Promise.all(
        messageIds.map((messageId) =>
          moveMessageToMailbox({ config, logger, messageId, mailbox: "Trash" }),
        ),
      );
      await markMessagesLeftInbox({
        emailAccountId: config.emailAccountId,
        messageIds,
        action: "trash",
      });
    },
    untrashMessages: async (messageIds: string[]) => {
      await moveMessagesToMailbox({
        config,
        logger,
        messageIds,
        mailbox: config.syncFolder || "INBOX",
        sourceMailbox: "Trash",
      });
    },
    unarchiveMessages: async (messageIds: string[]) => {
      await moveMessagesToMailbox({
        config,
        logger,
        messageIds,
        mailbox: config.syncFolder || "INBOX",
        sourceMailbox: "Archive",
      });
    },
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
    getFiltersList: async () => [],
    createAutoArchiveFilter: async ({ from }) => {
      await moveMessagesFromSenders({
        config,
        logger,
        fromEmails: [from],
        mailbox: "Archive",
      });
      return { status: 200 };
    },
    deleteFilter: async () => ({ status: 200 }),
    getInboxStats: () => readInboxStats(config),
    getLabels: async () => {
      const rows = await prisma.label.findMany({
        where: { emailAccountId: config.emailAccountId, enabled: true },
        select: { gmailLabelId: true, name: true },
      });
      return rows.map((row) => ({
        id: row.gmailLabelId,
        name: row.name,
        type: "user",
      }));
    },
    getLabelByName: async (name: string) => {
      const row = await prisma.label.findFirst({
        where: { emailAccountId: config.emailAccountId, name },
        select: { gmailLabelId: true, name: true },
      });
      if (!row) return null;
      return { id: row.gmailLabelId, name: row.name, type: "user" };
    },
    getLabelById: async (labelId: string) => {
      const row = await prisma.label.findFirst({
        where: {
          emailAccountId: config.emailAccountId,
          gmailLabelId: labelId,
        },
        select: { gmailLabelId: true, name: true },
      });
      if (!row) return null;
      return { id: row.gmailLabelId, name: row.name, type: "user" };
    },
    createLabel: async (name: string) => {
      const keyword = imapKeyword(name);
      const row = await prisma.label.upsert({
        where: {
          name_emailAccountId: {
            name,
            emailAccountId: config.emailAccountId,
          },
        },
        create: {
          name,
          gmailLabelId: keyword,
          emailAccountId: config.emailAccountId,
          enabled: true,
        },
        update: { enabled: true },
        select: { gmailLabelId: true, name: true },
      });
      return { id: row.gmailLabelId, name: row.name, type: "user" };
    },
    labelMessage: async ({ messageId, labelId, labelName }) => {
      const keyword = imapKeyword(labelId || labelName || "");
      await addKeywordFlag({ config, logger, messageId, keyword });
      return { actualLabelId: keyword };
    },
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
        return;
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
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
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
    connectionTimeout: 10_000,
    socketTimeout: 10_000,
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
    const selectedMailbox = mailbox || config.syncFolder || "INBOX";
    const lock = await client.getMailboxLock(selectedMailbox);
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
        const parsed = await parseImapMessage(
          message.uid,
          message.source,
          message.flags,
          message.internalDate,
        );
        if (
          isInboxMailbox(selectedMailbox, config.syncFolder || "INBOX") &&
          !parsed.labelIds?.includes("INBOX")
        ) {
          parsed.labelIds = [...(parsed.labelIds || []), "INBOX"];
        }
        messages.push(parsed);
      }
      return messages.sort(
        (a, b) => Number(a.internalDate || "0") - Number(b.internalDate || "0"),
      );
    } finally {
      lock.release();
    }
  } catch (error) {
    if (isMissingImapMailbox(error)) {
      throw new SafeError("IMAP mailbox not found");
    }
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
  const threadKey = imapThreadKey(parsed, subject, uid);

  return {
    id: String(uid),
    threadId: threadKey,
    historyId,
    date: (internalDate || new Date()).toISOString(),
    internalDate: historyId,
    subject,
    snippet: messageSnippet(textBody, htmlBody),
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
    labelIds: imapFlagsToLabelIds(flags),
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
      references: parsed.references || undefined,
      "in-reply-to": parsed.inReplyTo || undefined,
      "list-unsubscribe": headerValue(parsed.headers, "list-unsubscribe"),
      "list-unsubscribe-post": headerValue(
        parsed.headers,
        "list-unsubscribe-post",
      ),
    },
    _attachments: includeAttachmentBodies ? attachments : [],
    _uid: uid,
  };
}

function headerValue(
  headers: { key: string; value: string }[] | undefined,
  name: string,
) {
  const values = (headers || [])
    .filter((header) => header.key === name)
    .map((header) => header.value.trim())
    .filter(Boolean);
  return values.length ? values.join(", ") : undefined;
}

function messageSnippet(textBody: string, htmlBody: string) {
  const source = textBody || htmlBody.replace(/<[^>]+>/g, " ");
  return source.replace(/\s+/g, " ").trim().slice(0, 280);
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

async function reconcileStoredInbox(config: ImapConfig) {
  const client = createImapClient(config);
  await client.connect();
  let ids: string[] = [];
  try {
    const lock = await client.getMailboxLock(config.syncFolder || "INBOX");
    try {
      const found = await client.search({ all: true }, { uid: true });
      ids = Array.isArray(found) ? found.map((uid) => String(uid)) : [];
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  if (!ids.length) {
    await prisma.emailMessage.updateMany({
      where: { emailAccountId: config.emailAccountId, inbox: true },
      data: { inbox: false },
    });
    return;
  }

  await prisma.emailMessage.updateMany({
    where: {
      emailAccountId: config.emailAccountId,
      inbox: true,
      messageId: { notIn: ids },
    },
    data: { inbox: false },
  });
}

async function dropStaleThreadCopies({
  emailAccountId,
  messages,
}: {
  emailAccountId: string;
  messages: { id: string; threadId: string }[];
}) {
  const current = new Map<string, string>();
  for (const message of messages) {
    if (message.id && message.threadId)
      current.set(message.id, message.threadId);
  }
  if (!current.size) return;
  await prisma.emailMessage.deleteMany({
    where: {
      emailAccountId,
      OR: [...current].map(([messageId, threadId]) => ({
        messageId,
        threadId: { not: threadId },
      })),
    },
  });
}

async function markStoredReadState({
  emailAccountId,
  messageIds,
  read,
}: {
  emailAccountId: string;
  messageIds: string[];
  read: boolean;
}) {
  const ids = messageIds.filter(Boolean);
  if (!ids.length) return;
  await prisma.emailMessage.updateMany({
    where: { emailAccountId, messageId: { in: ids } },
    data: { read },
  });
}

async function markMessagesLeftInbox({
  emailAccountId,
  messageIds,
  action,
}: {
  emailAccountId: string;
  messageIds: string[];
  action: "archive" | "trash" | "spam";
}) {
  const ids = messageIds.filter(Boolean);
  if (!ids.length) return;
  if (action === "trash") {
    await prisma.emailMessage.deleteMany({
      where: { emailAccountId, messageId: { in: ids } },
    });
    return;
  }
  await prisma.emailMessage.updateMany({
    where: { emailAccountId, messageId: { in: ids } },
    data: { inbox: false },
  });
}

function isInboxMailbox(mailbox: string, syncFolder: string) {
  const name = mailbox.toLowerCase();
  return name === "inbox" || name === syncFolder.toLowerCase();
}

async function readInboxStats(config: ImapConfig) {
  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.syncFolder || "INBOX");
    try {
      const opened = client.mailbox;
      const total = opened ? opened.exists : 0;
      const unseen = await client.search({ seen: false }, { uid: true });
      return {
        total,
        unread: Array.isArray(unseen) ? unseen.length : 0,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function moveMessagesFromSenders({
  config,
  logger,
  fromEmails,
  mailbox,
}: {
  config: ImapConfig;
  logger: Logger;
  fromEmails: string[];
  mailbox: "Archive" | "Trash";
}) {
  const senders = fromEmails.map((email) => email.trim()).filter(Boolean);
  if (!senders.length) return;
  const client = createImapClient(config);
  await client.connect();
  try {
    await ensureMailbox(client, mailbox);
    const lock = await client.getMailboxLock(config.syncFolder || "INBOX");
    const movedIds: string[] = [];
    try {
      const uids = new Set<number>();
      for (const from of senders) {
        const found = await client.search({ from }, { uid: true });
        if (!Array.isArray(found)) continue;
        for (const uid of found) uids.add(uid);
      }
      for (const uid of uids) {
        await client.messageMove(uid, mailbox, { uid: true });
        movedIds.push(String(uid));
      }
    } finally {
      lock.release();
    }
    await markMessagesLeftInbox({
      emailAccountId: config.emailAccountId,
      messageIds: movedIds,
      action: mailbox === "Trash" ? "trash" : "archive",
    });
  } catch (error) {
    logger.error("Failed moving IMAP messages from senders", {
      error,
      mailbox,
      emailAccountId: config.emailAccountId,
    });
    throw new SafeError(`Failed to move IMAP messages to ${mailbox}`);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function removeKeywordFlag({
  config,
  messageId,
  keyword,
}: {
  config: ImapConfig;
  messageId: string;
  keyword: string;
}) {
  const uid = Number(messageId);
  if (!Number.isFinite(uid)) return;
  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.syncFolder || "INBOX");
    try {
      await client.messageFlagsRemove(uid, [keyword], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function addKeywordFlag({
  config,
  logger,
  messageId,
  keyword,
}: {
  config: ImapConfig;
  logger: Logger;
  messageId: string;
  keyword: string;
}) {
  const uid = Number(messageId);
  if (!Number.isFinite(uid)) return;
  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.syncFolder || "INBOX");
    try {
      await client.messageFlagsAdd(uid, [keyword], { uid: true });
    } finally {
      lock.release();
    }
  } catch (error) {
    logger.error("Failed labeling IMAP message", {
      error,
      keyword,
      emailAccountId: config.emailAccountId,
    });
    throw new SafeError("Failed to label IMAP message");
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function setSystemFlag({
  config,
  messageId,
  flag,
  enabled,
}: {
  config: ImapConfig;
  messageId: string;
  flag: "\\Flagged" | "\\Seen";
  enabled: boolean;
}) {
  const uid = Number(messageId);
  if (!Number.isFinite(uid)) return;
  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.syncFolder || "INBOX");
    try {
      if (enabled) await client.messageFlagsAdd(uid, [flag], { uid: true });
      else await client.messageFlagsRemove(uid, [flag], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
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
  await setSystemFlag({
    config,
    messageId: message.id,
    flag: "\\Seen",
    enabled: read,
  });
}

async function findDraftMessages({
  config,
  logger,
  draftId,
}: {
  config: ImapConfig;
  logger: Logger;
  draftId: string;
}) {
  const messages = await fetchMailboxMessages({
    config,
    logger,
    mailbox: "Drafts",
    maxResults: 100,
  });
  return messages.filter(
    (message) => message.threadId === draftId || message.id === draftId,
  );
}

async function deleteDraftMessage({
  config,
  logger,
  messageId,
}: {
  config: ImapConfig;
  logger: Logger;
  messageId: string;
}) {
  const uid = Number(messageId);
  if (!Number.isFinite(uid)) throw new SafeError("Draft not found");
  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock("Drafts");
    try {
      await client.messageDelete(uid, { uid: true });
    } finally {
      lock.release();
    }
  } catch (error) {
    logger.error("Failed deleting IMAP draft", {
      error,
      messageId,
      emailAccountId: config.emailAccountId,
    });
    throw new SafeError("Failed to delete IMAP draft");
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function mailboxForListType(type: string) {
  if (type === "archive") return "Archive";
  if (type === "trash") return "Trash";
  if (type === "drafts") return "Drafts";
  return;
}

async function moveThreadBetweenMailboxes({
  config,
  logger,
  threadId,
  sourceMailbox,
  destinationMailbox,
}: {
  config: ImapConfig;
  logger: Logger;
  threadId: string;
  sourceMailbox: string;
  destinationMailbox: string;
}) {
  const messages = await fetchMailboxMessages({
    config,
    logger,
    mailbox: sourceMailbox,
    maxResults: 100,
  });
  const matches = messages.filter((message) => message.threadId === threadId);
  if (!matches.length) throw new SafeError("Thread not found");
  await Promise.all(
    matches.map((message) =>
      moveMessageToMailbox({
        config,
        logger,
        messageId: message.id,
        mailbox: destinationMailbox,
        sourceMailbox,
      }),
    ),
  );
}

async function moveMessagesToMailbox({
  config,
  logger,
  messageIds,
  mailbox,
  sourceMailbox,
}: {
  config: ImapConfig;
  logger: Logger;
  messageIds: string[];
  mailbox: string;
  sourceMailbox: string;
}) {
  for (const messageId of messageIds) {
    await moveMessageToMailbox({
      config,
      logger,
      messageId,
      mailbox,
      sourceMailbox,
    });
  }
}

async function moveMessageToMailbox({
  config,
  logger,
  messageId,
  mailbox,
  sourceMailbox,
}: {
  config: ImapConfig;
  logger: Logger;
  messageId: string;
  mailbox: string;
  sourceMailbox?: string;
}) {
  const uid = Number(messageId);
  if (!Number.isFinite(uid)) return;
  const client = createImapClient(config);
  await client.connect();
  try {
    await ensureMailbox(client, mailbox);
    const lock = await client.getMailboxLock(
      sourceMailbox || config.syncFolder || "INBOX",
    );
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

function buildDraftMessage({
  email,
  args,
  from,
}: {
  email: ParsedMessage;
  args: {
    to?: string;
    subject?: string;
    content: string;
    cc?: string;
    bcc?: string;
  };
  from: string;
}) {
  const to = args.to || email.headers.from;
  const subject =
    args.subject ||
    (email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`);
  const messageId = email.headers["message-id"];
  return [
    `From: ${from}`,
    `To: ${to}`,
    ...(args.cc ? [`Cc: ${args.cc}`] : []),
    ...(args.bcc ? [`Bcc: ${args.bcc}`] : []),
    `Subject: ${subject}`,
    ...(messageId
      ? [`In-Reply-To: ${messageId}`, `References: ${messageId}`]
      : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    args.content,
  ].join("\r\n");
}

function buildOutgoingMessage({
  from,
  to,
  cc,
  bcc,
  subject,
  messageId,
  inReplyTo,
  references,
  contentType,
  body,
}: {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  contentType: string;
  body: string;
}) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : undefined,
    bcc ? `Bcc: ${bcc}` : undefined,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : undefined,
    references ? `References: ${references}` : undefined,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: ${contentType}`,
  ].filter((line): line is string => Boolean(line));
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

async function storeSentMailbox({
  config,
  logger,
}: {
  config: ImapConfig;
  logger: Logger;
}) {
  try {
    const messages = await fetchSentMessages({
      config,
      logger,
      maxResults: 100,
    });
    await storeSentMessages({ config, messages });
  } catch (error) {
    logger.warn("Skipped storing sent IMAP mail", {
      error,
      emailAccountId: config.emailAccountId,
    });
  }
}

async function storeSentMessages({
  config,
  messages,
}: {
  config: ImapConfig;
  messages: ParsedImapMessage[];
}) {
  for (const message of messages) {
    const from = extractEmailAddress(message.headers.from || "");
    const date = new Date(message.date);
    if (!from || Number.isNaN(date.getTime())) continue;
    const to = extractEmailAddress(message.headers.to || "") || "Missing";
    await prisma.emailMessage.upsert({
      where: {
        emailAccountId_threadId_messageId: {
          emailAccountId: config.emailAccountId,
          threadId: message.threadId,
          messageId: `sent:${message.id}`,
        },
      },
      create: {
        emailAccountId: config.emailAccountId,
        threadId: message.threadId,
        messageId: `sent:${message.id}`,
        date,
        from,
        fromName: extractNameFromEmail(message.headers.from || "") || null,
        fromDomain: extractDomainFromEmail(from),
        to,
        read: true,
        sent: true,
        draft: false,
        inbox: false,
      },
      update: {
        date,
        from,
        to,
        read: true,
        sent: true,
        inbox: false,
      },
    });
  }
}

async function saveSentCopy({
  config,
  logger,
  raw,
}: {
  config: ImapConfig;
  logger: Logger;
  raw: string;
}) {
  const client = createImapClient(config);
  try {
    await client.connect();
    await ensureMailbox(client, "Sent");
    const appended = await client.append("Sent", raw, ["\\Seen"]);
    if (appended?.uid) {
      const message = await parseImapMessage(
        appended.uid,
        Buffer.from(raw),
        new Set(["\\Seen"]),
      );
      await storeSentMessages({ config, messages: [message] });
    }
  } catch (error) {
    logger.error("Failed saving IMAP sent copy", {
      error,
      emailAccountId: config.emailAccountId,
    });
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function ensureMailbox(client: ImapFlow, mailbox: string) {
  const boxes = await client.list();
  const exists = boxes.some(
    (box) => box.path === mailbox || box.name === mailbox,
  );
  if (!exists) await client.mailboxCreate(mailbox);
}

function imapThreadKey(
  parsed: { references?: string; inReplyTo?: string; messageId?: string },
  subject: string,
  uid: number,
) {
  const referenced = messageIdsIn(parsed.references);
  const root = referenced[0] || parsed.inReplyTo || parsed.messageId;
  if (root) return root;
  const normalizedSubject = subject.toLowerCase().replace(/^(re|fwd):\s*/g, "");
  return normalizedSubject || String(uid);
}

function messageIdsIn(value?: string) {
  if (!value) return [];
  const wrapped = value.match(/<[^>]+>/g);
  if (wrapped?.length) return wrapped;
  return value.split(/\s+/).filter(Boolean);
}

function messagesForOpenThread(messages: ParsedImapMessage[]) {
  const hidden = new Set(["trash", "drafts"]);
  const active = messages.filter(
    (message) => !hidden.has((message._mailbox || "").toLowerCase()),
  );
  const chosen = active.length ? active : messages;
  const seen = new Set<string>();
  const unique: ParsedImapMessage[] = [];
  for (const message of chosen) {
    const key =
      message.headers["message-id"] || `${message._mailbox}:${message.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(message);
  }
  return unique.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
}

function inboxCopies<T extends { labelIds?: string[] | null }>(messages: T[]) {
  return messages.filter((message) => message.labelIds?.includes("INBOX"));
}

function isMissingThread(error: unknown) {
  return error instanceof SafeError && error.message === "Thread not found";
}

const SENT_MAILBOXES = ["Sent", "Sent Items", "[Gmail]/Sent Mail"];

async function fetchSentMessages({
  config,
  logger,
  maxResults,
}: {
  config: ImapConfig;
  logger: Logger;
  maxResults: number;
}) {
  for (const mailbox of SENT_MAILBOXES) {
    try {
      return await fetchMailboxMessages({
        config,
        logger,
        mailbox,
        maxResults,
      });
    } catch (error) {
      if (isMissingImapMailbox(error)) continue;
      throw error;
    }
  }
  return [];
}

function isMissingImapMailbox(error: unknown) {
  if (
    error instanceof SafeError &&
    error.message === "IMAP mailbox not found"
  ) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "mailboxMissing" in error &&
    error.mailboxMissing === true
  );
}

async function hasEarlierImapCorrespondence({
  config,
  logger,
  from,
  date,
  messageId,
}: {
  config: ImapConfig;
  logger: Logger;
  from: string;
  date: Date;
  messageId: string;
}): Promise<boolean> {
  const searchTerm = getSearchTermForSender(from).trim();
  if (!searchTerm) return false;

  const client = createImapClient(config);
  await client.connect();
  try {
    const boxes = await client.list();
    const syncFolder = config.syncFolder || "INBOX";
    for (const folder of correspondenceFolders(boxes, syncFolder)) {
      const lock = await client.getMailboxLock(folder).catch(() => null);
      if (!lock) continue;
      try {
        const found = await client.search(
          { or: [{ from: searchTerm }, { to: searchTerm }] },
          { uid: true },
        );
        const candidates = uidsToCheck(
          Array.isArray(found) ? found : [],
          folder === syncFolder ? messageId : undefined,
        );
        if (!candidates.length) continue;
        const wanted = new Set(candidates.map(String));
        for await (const message of client.fetch(
          candidates.join(","),
          {
            uid: true,
            source: true,
            flags: true,
            internalDate: true,
          },
          { uid: true },
        )) {
          if (!wanted.has(String(message.uid)) || !message.source) continue;
          if (folder === syncFolder && String(message.uid) === messageId) {
            continue;
          }
          const parsed = await parseImapMessage(
            message.uid,
            message.source,
            message.flags ?? new Set(),
            messageInternalDate(message.internalDate),
          );
          const sentAt = new Date(parsed.date);
          if (Number.isNaN(sentAt.getTime()) || sentAt >= date) continue;
          if (
            addressesMatchSearchTerm(
              [parsed.headers.from, parsed.headers.to],
              searchTerm,
            )
          ) {
            return true;
          }
        }
      } finally {
        lock.release();
      }
    }
    return false;
  } catch (error) {
    logger.error("Failed checking IMAP prior contact", {
      error,
      emailAccountId: config.emailAccountId,
    });
    throw new SafeError("Failed to read IMAP mailbox");
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function correspondenceFolders(
  boxes: { path?: string | null; name?: string | null }[],
  syncFolder: string,
) {
  const folders = new Set<string>();
  if (syncFolder) folders.add(syncFolder);
  for (const box of boxes) {
    const path = box.path || "";
    if (path && isSentFolder(box.name || "", path)) folders.add(path);
  }
  return [...folders];
}

function isSentFolder(name: string, path: string) {
  const normalizedName = name.toLowerCase();
  const normalizedPath = path.toLowerCase();
  return (
    normalizedName === "sent" ||
    normalizedName === "sent items" ||
    normalizedPath === "sent" ||
    normalizedPath === "sent items" ||
    normalizedPath === "[gmail]/sent mail" ||
    normalizedPath.endsWith("/sent")
  );
}

// Search hits can be old mail with low UIDs or mail that was moved and got a new UID.
function uidsToCheck(uids: number[], currentMessageId?: string) {
  const remaining = uids.filter(
    (uid) => Number.isFinite(uid) && String(uid) !== currentMessageId,
  );
  if (remaining.length <= 8) return remaining;
  const sorted = [...remaining].sort((a, b) => a - b);
  return [...new Set([...sorted.slice(0, 4), ...sorted.slice(-4)])];
}

function messageInternalDate(value: Date | string | undefined) {
  if (value instanceof Date) return value;
  if (value) return new Date(value);
  return;
}

function addressesMatchSearchTerm(headers: string[], searchTerm: string) {
  const term = searchTerm.toLowerCase();
  const matchFullAddress = term.includes("@");
  return headers.some((header) =>
    extractEmailAddresses(header).some((address) => {
      const normalized = address.toLowerCase();
      if (matchFullAddress) return normalized === term;
      return extractDomainFromEmail(normalized).toLowerCase() === term;
    }),
  );
}
