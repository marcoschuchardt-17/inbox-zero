import { Readable } from "node:stream";
import { ImapFlow } from "imapflow";
import he from "he";
import PostalMime from "postal-mime";
import nodemailer from "nodemailer";
import { ActionType } from "@/generated/prisma/enums";
import { shouldSkipAutoDraft } from "@/utils/auto-draft";
import {
  extractDomainFromEmail,
  extractEmailAddress,
  extractEmailAddresses,
  extractNameFromEmail,
  formatEmailWithName,
  getSearchTermForSender,
  legacySubjectThreadKey,
} from "@/utils/email";
import { SafeError } from "@/utils/error";
import { imapFlagsToLabelIds, imapKeyword } from "@/utils/email/imap-flags";
import { formatReplySubject } from "@/utils/email/subject";
import { forwardEmailHtml, forwardEmailSubject } from "@/utils/gmail/forward";
import { createReplyContent } from "@/utils/gmail/reply";
import type {
  EmailProvider,
  EmailThread,
  GetThreadOptions,
} from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { ParsedMessage } from "@/utils/types";
import type { SendEmailBody } from "@/utils/types/mail";

type ImapConfig = {
  emailAccountId: string;
  ownerEmail: string;
  displayName?: string | null;
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
const SEARCH_MATCH_LIMIT = 200;
// A filing preview only needs recent files, so each folder is scanned this far
// instead of downloading the whole mailbox.
const ATTACHMENT_SCAN_LIMIT = 100;

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
      before,
      after,
    }: {
      query?: string;
      maxResults?: number;
      pageToken?: string;
      before?: Date;
      after?: Date;
    }) => {
      if (!pageToken) {
        await reconcileStoredInbox(config);
        await storeSentMailbox({ config, logger });
      }
      const needle = query?.trim();
      if (needle) {
        const page = await searchImapMessages({
          config,
          logger,
          needle,
          maxResults,
          pageToken,
        });
        await dropStaleThreadCopies({
          emailAccountId: config.emailAccountId,
          messages: page.messages,
        });
        return page;
      }
      if (before || after) {
        const page = await fetchDatedMessagesAcrossMailboxes({
          config,
          logger,
          maxResults,
          pageToken,
          after,
          before,
        });
        await dropStaleThreadCopies({
          emailAccountId: config.emailAccountId,
          messages: page.messages,
        });
        return page;
      }
      const offset = Number(pageToken || "0");
      const fetchLimit = maxResults + offset;
      // An empty query still means "previous mail", including mail that left
      // the inbox. Omitting query keeps the inbox read used by stats.
      const messages =
        query !== undefined
          ? await fetchSearchableMailboxMessages({
              config,
              logger,
              maxResults: fetchLimit,
            })
          : await fetchMailboxMessages({
              config,
              logger,
              maxResults: fetchLimit,
            });
      await dropStaleThreadCopies({
        emailAccountId: config.emailAccountId,
        messages,
      });
      const slice = messages.slice(offset, offset + maxResults);
      const nextPageToken =
        offset + maxResults < messages.length
          ? String(offset + maxResults)
          : undefined;
      return { messages: slice, nextPageToken };
    },
    getMessage: async (messageId: string) => {
      const message = await fetchMessageById({ config, logger, messageId });
      if (!message) throw new SafeError("Message not found");
      return message;
    },
    getMessagesBatch: async (messageIds: string[]) =>
      fetchMessagesByIds({ config, logger, messageIds }),
    getPreviousConversationMessages: async (messageIds: string[]) =>
      fetchMessagesByIds({ config, logger, messageIds }),
    getThreadsWithParticipant: async ({ participantEmail, maxThreads = 8 }) => {
      const messages = await findImapMessagesWithParticipant({
        config,
        logger,
        participantEmail,
      });
      return groupToThreads(messages).slice(0, Math.max(maxThreads, 0));
    },
    getMessagesWithAttachments: async ({ maxResults = 20, pageToken }) =>
      findImapMessagesWithAttachments({
        config,
        logger,
        maxResults,
        pageToken,
      }),
    getThread: async (threadId: string, options?: GetThreadOptions) => {
      const collected = await collectThreadCopies({
        config,
        logger,
        threadId,
      });
      const threadMessages = messagesForOpenThread(collected, options);
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
    getMessageByRfc822MessageId: async (rfc822MessageId: string) =>
      findImapMessageByRfc822Id({
        config,
        logger,
        rfc822MessageId,
      }),
    searchMessages: async ({
      query,
      maxResults = DEFAULT_PAGE_SIZE,
      pageToken,
    }) => core.getMessagesWithPagination({ query, maxResults, pageToken }),
    getThreadsWithQuery: async ({
      query,
      maxResults = DEFAULT_PAGE_SIZE,
      pageToken,
    }) => {
      let messages: ParsedMessage[] = [];
      let nextPageToken: string | undefined;
      const mailbox =
        (query?.type ? mailboxForListType(query.type) : undefined) ||
        query?.folderId ||
        undefined;
      const fromEmail = query?.fromEmail?.trim();
      if (fromEmail && !mailbox && query?.type !== "sent") {
        const fromSender = await findImapMessagesFromSender({
          config,
          logger,
          senderEmail: fromEmail,
          before: query?.before,
          after: query?.after,
        });
        const matched = fromSender.filter((message) => {
          if (query?.isUnread && !message.labelIds?.includes("UNREAD")) {
            return false;
          }
          if (query?.labelId && !message.labelIds?.includes(query.labelId)) {
            return false;
          }
          return true;
        });
        const offset = pageOffset(pageToken);
        return {
          threads: groupToThreads(matched.slice(offset, offset + maxResults)),
          nextPageToken:
            offset + maxResults < matched.length
              ? String(offset + maxResults)
              : undefined,
        };
      }
      const loadMailbox = async () => {
        if (query?.after || query?.before) {
          return fetchMailboxMessagesByDate({
            config,
            logger,
            mailbox,
            maxResults,
            pageToken,
            after: query.after,
            before: query.before,
            isUnread: query.isUnread,
          });
        }
        return fetchMailboxMessagePage({
          config,
          logger,
          mailbox,
          maxResults,
          beforeSequence: pageOffset(pageToken) || undefined,
        });
      };
      if (query?.type === "sent") {
        const page = await fetchSentMessagePage({
          config,
          logger,
          maxResults,
          beforeSequence: pageOffset(pageToken) || undefined,
        });
        messages = page.messages;
        nextPageToken = page.nextPageToken;
      } else if (mailbox) {
        try {
          const page = await loadMailbox();
          messages = page.messages;
          nextPageToken = page.nextPageToken;
        } catch (error) {
          logger.warn("Skipped IMAP folder", {
            error,
            mailbox,
            emailAccountId: config.emailAccountId,
          });
        }
      } else {
        const page = await loadMailbox();
        messages = page.messages;
        nextPageToken = page.nextPageToken;
      }
      const senderFilter = fromEmail?.toLowerCase();
      const filtered = messages.filter((message) => {
        if (
          senderFilter &&
          !message.headers.from.toLowerCase().includes(senderFilter)
        ) {
          return false;
        }
        if (query?.isUnread && !message.labelIds?.includes("UNREAD")) {
          return false;
        }
        if (query?.labelId && !message.labelIds?.includes(query.labelId)) {
          return false;
        }
        const sentAt = new Date(message.date).getTime();
        if (query?.after && sentAt < new Date(query.after).getTime()) {
          return false;
        }
        if (query?.before && sentAt >= new Date(query.before).getTime()) {
          return false;
        }
        return true;
      });
      return {
        threads: groupToThreads(filtered).slice(0, maxResults),
        nextPageToken,
      };
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
    getMessagesFromSender: async ({
      senderEmail,
      maxResults = DEFAULT_PAGE_SIZE,
      pageToken,
      before,
      after,
    }) => {
      const messages = await findImapMessagesFromSender({
        config,
        logger,
        senderEmail,
        before,
        after,
      });
      const offset = Number(pageToken || "0") || 0;
      const page = messages.slice(offset, offset + maxResults);
      return {
        messages: page,
        nextPageToken:
          offset + maxResults < messages.length
            ? String(offset + maxResults)
            : undefined,
      };
    },
    checkIfReplySent: async (senderEmail: string) => {
      try {
        return await hasSentMailTo({ config, senderEmail });
      } catch (error) {
        logger.warn("Error checking if an IMAP reply was sent", {
          error,
          emailAccountId: config.emailAccountId,
        });
        return true;
      }
    },
    countReceivedMessages: async (senderEmail: string, threshold: number) => {
      try {
        const messages = await findImapMessagesFromSender({
          config,
          logger,
          senderEmail,
        });
        return Math.min(messages.length, Math.max(0, threshold));
      } catch (error) {
        logger.warn("Error counting received IMAP messages", {
          error,
          emailAccountId: config.emailAccountId,
        });
        return 0;
      }
    },
    searchThreads: async ({
      query,
      maxResults = DEFAULT_PAGE_SIZE,
      pageToken,
    }) => {
      const { messages, nextPageToken } = await core.getMessagesWithPagination({
        query,
        maxResults,
        pageToken,
      });
      return { threads: groupToThreads(messages), nextPageToken };
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
      const files = mimeAttachments(attachments);
      const result = await transport.sendMail({
        from: mailboxFrom(config),
        to,
        cc,
        bcc,
        subject,
        text: messageText,
        attachments: files.length
          ? files.map((file) => ({
              filename: file.filename,
              content: file.content,
              encoding: "base64" as const,
              contentType: file.contentType,
            }))
          : undefined,
        messageId,
      });
      const savedId = result.messageId || messageId;
      await saveSentCopy({
        config,
        logger,
        raw: buildOutgoingMessage({
          from: mailboxFrom(config),
          to,
          cc,
          bcc,
          subject,
          messageId: savedId,
          contentType: "text/plain; charset=utf-8",
          body: messageText,
          attachments: files,
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
        from: body.from || mailboxFrom(config),
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
          from: body.from || mailboxFrom(config),
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          subject: body.subject,
          messageId: savedId,
          inReplyTo: body.replyToEmail?.headerMessageId,
          references,
          contentType: "text/html; charset=utf-8",
          body: body.messageHtml,
          attachments: body.attachments,
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
      await connectImapClient(client);
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
    createDraft: async ({ to, subject, messageHtml, replyToMessageId }) => {
      const domain = config.ownerEmail.split("@")[1] || "localhost";
      const messageId = `<imap-draft-${crypto.randomUUID()}@${domain}>`;
      const original = replyToMessageId
        ? await fetchMessageById({
            config,
            logger,
            messageId: replyToMessageId,
          })
        : null;
      const parentId = original?.headers["message-id"];
      await appendDraftRaw({
        config,
        logger,
        raw: buildOutgoingMessage({
          from: mailboxFrom(config),
          to,
          subject,
          messageId,
          inReplyTo: parentId,
          references: parentId
            ? [original?.headers.references, parentId].filter(Boolean).join(" ")
            : undefined,
          contentType: "text/html; charset=utf-8",
          body: messageHtml,
        }),
      });
      return { id: messageId };
    },
    updateDraft: async (draftId, params) => {
      const drafts = await findDraftMessages({ config, logger, draftId });
      const current = drafts.at(-1);
      if (!current) throw new SafeError("Draft not found");
      const messageId = current.headers["message-id"] || draftId;
      const appended = await appendDraftRaw({
        config,
        logger,
        raw: buildOutgoingMessage({
          from: mailboxFrom(config),
          to: params.to ?? current.headers.to,
          cc: params.cc ?? current.headers.cc,
          bcc: params.bcc,
          subject: params.subject ?? current.subject,
          messageId,
          inReplyTo: current.headers["in-reply-to"],
          references: current.headers.references,
          contentType: "text/html; charset=utf-8",
          body:
            params.messageHtml ?? current.textHtml ?? current.textPlain ?? "",
          attachments: params.attachments,
        }),
      });
      await Promise.all(
        drafts
          .filter(
            (message) => parseImapMessageRef(message.id)?.uid !== appended?.uid,
          )
          .map((message) =>
            deleteDraftMessage({
              config,
              logger,
              messageId: message.id,
            }),
          ),
      );
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
      const withFiles = await fetchMessageById({
        config,
        logger,
        messageId: draft.id,
        includeAttachmentBodies: true,
      });
      const attachments = (withFiles?._attachments ?? []).map((attachment) => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.content).toString("base64"),
        contentType: attachment.mimeType,
      }));
      const result = await transport.sendMail({
        from: mailboxFrom(config),
        to: draft.headers.to,
        cc: draft.headers.cc,
        subject: draft.subject,
        text,
        html: draft.textHtml,
        messageId,
        inReplyTo,
        references,
        attachments: attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          encoding: "base64" as const,
          contentType: attachment.contentType,
        })),
      });
      const savedId = result.messageId || messageId;
      await saveSentCopy({
        config,
        logger,
        raw: buildOutgoingMessage({
          from: mailboxFrom(config),
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
          attachments,
        }),
      });
      await Promise.all(
        drafts.map((message) =>
          deleteDraftMessage({ config, logger, messageId: message.id }),
        ),
      );
      return { messageId: savedId, threadId: draft.threadId };
    },
    getDraft: async (draftId: string) => {
      const drafts = await listDrafts({ config, logger, draftId });
      return drafts.at(-1) ?? null;
    },
    getDraftReferenceForMessage: async (messageId: string) => {
      const drafts = await listDrafts({ config, logger, draftId: messageId });
      const draft = drafts.at(-1);
      return draft ? { id: draft.id } : null;
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
    replyToEmail: async (email, content, options) => {
      const sentFromUser = email.labelIds?.includes("SENT");
      const headerMessageId = email.headers["message-id"] || "";
      const references = [email.headers.references, headerMessageId]
        .filter(Boolean)
        .join(" ");
      const { html } = createReplyContent({
        textContent: content,
        message: email,
      });
      const sent = await core.sendEmailWithHtml({
        to: sentFromUser
          ? email.headers.to
          : email.headers["reply-to"] || email.headers.from,
        subject: sentFromUser
          ? email.subject
          : formatReplySubject(email.subject),
        messageHtml: html,
        replyTo: options?.replyTo,
        from: options?.from,
        attachments: options?.attachments,
        replyToEmail: {
          threadId: email.threadId,
          headerMessageId,
          references,
        },
      });
      return { messageId: sent.messageId };
    },
    forwardEmail: async (email, args) => {
      const stored = await fetchMessageById({
        config,
        logger,
        messageId: email.id,
        includeAttachmentBodies: true,
      });
      const source = stored ?? email;
      const sent = await core.sendEmailWithHtml({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        from: args.from,
        subject: forwardEmailSubject(source.subject || email.subject),
        messageHtml: forwardEmailHtml({
          content: args.content ?? "",
          message: source,
        }),
        attachments: (stored?._attachments ?? []).map((attachment) => ({
          filename: attachment.filename,
          content: Buffer.from(attachment.content).toString("base64"),
          contentType: attachment.mimeType,
        })),
      });
      return { messageId: sent.messageId };
    },
    markReadThread: async (threadId: string, read: boolean) => {
      const messages = readStateTargets(await core.getThreadMessages(threadId));
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
      const matches = await messagesMatchingThread({
        config,
        logger,
        mailbox: "Junk",
        threadId,
      });
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
      await connectImapClient(client);
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
      const matches = await messagesMatchingThread({
        config,
        logger,
        mailbox: sourceMailbox,
        threadId,
      });
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
      // A label stays on the message after it leaves the inbox.
      const messages = await collectThreadCopies({ config, logger, threadId });
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
      await connectImapClient(client);
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
    getFiltersList: async () => listSenderLabelFilters(config.emailAccountId),
    createFilter: async ({ from, addLabelIds }) => {
      await saveSenderLabelFilters({
        emailAccountId: config.emailAccountId,
        from,
        labelIds: addLabelIds,
      });
      return { status: 200 };
    },
    createAutoArchiveFilter: async ({ from }) => {
      await moveMessagesFromSenders({
        config,
        logger,
        fromEmails: [from],
        mailbox: "Archive",
      });
      return { status: 200 };
    },
    deleteFilter: async (id: string) => {
      await deleteSenderLabelFilter({
        emailAccountId: config.emailAccountId,
        id,
      });
      return { status: 200 };
    },
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
  const page = await fetchMailboxMessagePage({
    config,
    logger,
    mailbox,
    maxResults,
  });
  return page.messages;
}

async function fetchMailboxMessagePage({
  config,
  logger,
  mailbox,
  maxResults = DEFAULT_PAGE_SIZE,
  beforeSequence,
}: {
  config: ImapConfig;
  logger: Logger;
  mailbox?: string;
  maxResults?: number;
  beforeSequence?: number;
}): Promise<{ messages: ParsedImapMessage[]; nextPageToken?: string }> {
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    const selectedMailbox = mailbox || config.syncFolder || "INBOX";
    const lock = await client.getMailboxLock(selectedMailbox);
    try {
      // ImapFlow stores the selected mailbox on the client. The lock has no mailbox field.
      const openedMailbox = client.mailbox;
      if (!openedMailbox) return { messages: [] };
      const messageCount = openedMailbox.exists;
      if (!messageCount) return { messages: [] };
      const end = beforeSequence ? beforeSequence - 1 : messageCount;
      if (end < 1) return { messages: [] };
      const start = Math.max(1, end - maxResults + 1);
      const messages: ParsedImapMessage[] = [];
      for await (const message of client.fetch(`${start}:${end}`, {
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
          selectedMailbox,
        );
        if (
          isInboxMailbox(selectedMailbox, config.syncFolder || "INBOX") &&
          !parsed.labelIds?.includes("INBOX")
        ) {
          parsed.labelIds = [...(parsed.labelIds || []), "INBOX"];
        }
        messages.push(parsed);
      }
      return {
        messages: messages.sort(
          (a, b) =>
            Number(a.internalDate || "0") - Number(b.internalDate || "0"),
        ),
        nextPageToken: start > 1 ? String(start) : undefined,
      };
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

async function fetchDatedMessagesAcrossMailboxes({
  config,
  logger,
  maxResults,
  pageToken,
  after,
  before,
}: {
  config: ImapConfig;
  logger: Logger;
  maxResults: number;
  pageToken?: string;
  after?: Date;
  before?: Date;
}): Promise<{ messages: ParsedImapMessage[]; nextPageToken?: string }> {
  const mailboxes = (await mailboxNamesForRead({ config, logger })).filter(
    (mailbox) =>
      isSearchableMailbox(mailbox) && !isSentFolder(mailbox, mailbox),
  );
  const start = parseDatedPageToken(pageToken);
  const collected: ParsedImapMessage[] = [];
  for (let index = start.mailboxIndex; index < mailboxes.length; index++) {
    const remaining = maxResults - collected.length;
    if (remaining <= 0) {
      return {
        messages: collected,
        nextPageToken: datedPageToken(index, 0),
      };
    }
    let page: { messages: ParsedImapMessage[]; nextPageToken?: string };
    try {
      const mailbox = mailboxes[index];
      const syncFolder = config.syncFolder || "INBOX";
      page = await fetchMailboxMessagesByDate({
        config,
        logger,
        mailbox,
        maxResults: remaining,
        pageToken:
          index === start.mailboxIndex && start.uidIndex > 0
            ? String(start.uidIndex)
            : undefined,
        after: dateFloorForMailbox({
          mailbox,
          syncFolder,
          after,
          before,
        }),
        before,
      });
    } catch (error) {
      if (isMissingImapMailbox(error)) continue;
      if (index === start.mailboxIndex && collected.length === 0) throw error;
      logger.warn("Skipped IMAP folder while reading mail by date", {
        error,
        mailbox: mailboxes[index],
      });
      continue;
    }
    collected.push(...page.messages);
    if (page.nextPageToken) {
      return {
        messages: collected,
        nextPageToken: datedPageToken(index, Number(page.nextPageToken)),
      };
    }
  }
  return { messages: collected };
}

function parseDatedPageToken(pageToken?: string) {
  if (!pageToken) return { mailboxIndex: 0, uidIndex: 0 };
  const [mailboxPart, uidPart] = pageToken.split(":");
  if (uidPart === undefined) {
    return { mailboxIndex: 0, uidIndex: pageOffset(pageToken) };
  }
  const mailboxIndex = Number(mailboxPart);
  const uidIndex = Number(uidPart);
  return {
    mailboxIndex:
      Number.isFinite(mailboxIndex) && mailboxIndex > 0
        ? Math.floor(mailboxIndex)
        : 0,
    uidIndex:
      Number.isFinite(uidIndex) && uidIndex > 0 ? Math.floor(uidIndex) : 0,
  };
}

function datedPageToken(mailboxIndex: number, uidIndex: number) {
  return `${mailboxIndex}:${uidIndex}`;
}

function dateFloorForMailbox({
  mailbox,
  syncFolder,
  after,
  before,
}: {
  mailbox: string;
  syncFolder: string;
  after?: Date;
  before?: Date;
}) {
  if (isInboxMailbox(mailbox, syncFolder) || before) return after;
  return;
}

async function fetchMailboxMessagesByDate({
  config,
  logger,
  mailbox,
  maxResults,
  pageToken,
  after,
  before,
  isUnread,
}: {
  config: ImapConfig;
  logger: Logger;
  mailbox?: string;
  maxResults: number;
  pageToken?: string;
  after?: Date;
  before?: Date;
  isUnread?: boolean;
}): Promise<{ messages: ParsedImapMessage[]; nextPageToken?: string }> {
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    const selectedMailbox = mailbox || config.syncFolder || "INBOX";
    const lock = await client.getMailboxLock(selectedMailbox);
    try {
      const window = imapSearchWindow(after, before);
      const criteria = {
        ...(window.since ? { since: window.since } : {}),
        ...(window.before ? { before: window.before } : {}),
        ...(isUnread ? { seen: false } : {}),
      };
      const searched = await client.search(
        Object.keys(criteria).length > 0 ? criteria : { all: true },
        { uid: true },
      );
      const uids = (Array.isArray(searched) ? searched : [])
        .filter((uid): uid is number => typeof uid === "number")
        .sort((left, right) => right - left);
      const messages: ParsedImapMessage[] = [];
      let index = pageOffset(pageToken);
      // SEARCH dates are whole days, so the first UIDs can sit outside the
      // exact cutoff. Keep reading until the page is full or the window ends.
      while (messages.length < maxResults && index < uids.length) {
        const batch = uids.slice(index, index + maxResults);
        const wanted = new Set(batch.map(String));
        const fetched = new Map<number, ParsedImapMessage>();
        for await (const message of client.fetch(
          batch.join(","),
          {
            uid: true,
            envelope: true,
            source: true,
            flags: true,
            internalDate: true,
          },
          { uid: true },
        )) {
          if (!wanted.has(String(message.uid)) || !message.source) continue;
          const parsed = await parseImapMessage(
            message.uid,
            message.source,
            message.flags,
            message.internalDate,
            selectedMailbox,
          );
          if (
            isInboxMailbox(selectedMailbox, config.syncFolder || "INBOX") &&
            !parsed.labelIds?.includes("INBOX")
          ) {
            parsed.labelIds = [...(parsed.labelIds || []), "INBOX"];
          }
          fetched.set(message.uid, parsed);
        }
        for (const uid of batch) {
          index += 1;
          const message = fetched.get(uid);
          if (!message || !messageInsideDateWindow(message, after, before)) {
            continue;
          }
          messages.push(message);
          if (messages.length >= maxResults) break;
        }
      }
      return {
        messages: messages.sort(
          (left, right) =>
            Number(left.internalDate || "0") -
            Number(right.internalDate || "0"),
        ),
        nextPageToken: index < uids.length ? String(index) : undefined,
      };
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

async function fetchMessagesByIds({
  config,
  logger,
  messageIds,
}: {
  config: ImapConfig;
  logger: Logger;
  messageIds: string[];
}) {
  const messages = await Promise.all(
    messageIds.map((messageId) =>
      fetchMessageById({ config, logger, messageId }),
    ),
  );
  return messages.filter((message): message is ParsedImapMessage =>
    Boolean(message),
  );
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
  const ref = parseImapMessageRef(messageId);
  if (!ref) return null;
  const mailboxes = ref.mailbox
    ? [ref.mailbox]
    : await mailboxNamesForRead({ config, logger });
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    for (const mailbox of mailboxes) {
      try {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const message = await client.fetchOne(
            ref.uid,
            { uid: true, source: true, flags: true, internalDate: true },
            { uid: true },
          );
          if (!message?.source) continue;
          return parseImapMessage(
            message.uid,
            message.source,
            message.flags,
            message.internalDate,
            mailbox,
            includeAttachmentBodies,
          );
        } finally {
          lock.release();
        }
      } catch (error) {
        if (isMissingImapMailbox(error)) continue;
        logger.warn("Skipped IMAP folder while reading a message", {
          error,
          mailbox,
          emailAccountId: config.emailAccountId,
        });
      }
    }
    return null;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function parseImapMessage(
  uid: number,
  source: Buffer,
  flags: Set<string>,
  internalDate: Date | undefined,
  mailbox: string,
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
    id: imapMessageId(mailbox, uid),
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
    labelIds: withMailboxRole(imapFlagsToLabelIds(flags), mailbox),
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

function mailboxFrom(config: ImapConfig) {
  return formatEmailWithName(config.displayName, config.ownerEmail);
}

function messageSnippet(textBody: string, htmlBody: string) {
  const source = textBody || htmlSnippet(htmlBody);
  return source.replace(/\s+/g, " ").trim().slice(0, 280);
}

function htmlSnippet(htmlBody: string) {
  return he
    .decode(htmlBody.replace(/<[^>]+>/g, " "))
    .replace(/\u200C|\u200D|\uFEFF/g, "");
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
  await connectImapClient(client);
  let ids: string[] = [];
  try {
    const lock = await client.getMailboxLock(config.syncFolder || "INBOX");
    try {
      const found = await client.search({ all: true }, { uid: true });
      const mailbox = config.syncFolder || "INBOX";
      ids = Array.isArray(found)
        ? found.map((uid) => imapMessageId(mailbox, uid))
        : [];
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
  await connectImapClient(client);
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
  await connectImapClient(client);
  try {
    await ensureMailbox(client, mailbox);
    const sourceMailbox = config.syncFolder || "INBOX";
    const lock = await client.getMailboxLock(sourceMailbox);
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
        movedIds.push(imapMessageId(sourceMailbox, uid));
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
  const ref = parseImapMessageRef(messageId);
  if (!ref) return;
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    const lock = await client.getMailboxLock(
      ref.mailbox || config.syncFolder || "INBOX",
    );
    try {
      await client.messageFlagsRemove(ref.uid, [keyword], { uid: true });
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
  const ref = parseImapMessageRef(messageId);
  if (!ref) return;
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    const lock = await client.getMailboxLock(
      ref.mailbox || config.syncFolder || "INBOX",
    );
    try {
      await client.messageFlagsAdd(ref.uid, [keyword], { uid: true });
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
  const ref = parseImapMessageRef(messageId);
  if (!ref) return;
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    const lock = await client.getMailboxLock(
      ref.mailbox || config.syncFolder || "INBOX",
    );
    try {
      if (enabled) await client.messageFlagsAdd(ref.uid, [flag], { uid: true });
      else await client.messageFlagsRemove(ref.uid, [flag], { uid: true });
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

async function listDrafts({
  config,
  logger,
  draftId,
}: {
  config: ImapConfig;
  logger: Logger;
  draftId: string;
}) {
  try {
    return await findDraftMessages({ config, logger, draftId });
  } catch (error) {
    if (isMissingImapMailbox(error)) return [];
    throw error;
  }
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
  const direct = parseImapMessageRef(draftId)
    ? await fetchMessageById({ config, logger, messageId: draftId })
    : null;
  const needle = messageIdNeedle(draftId);
  const messages = needle
    ? await fetchMailboxThreadMatches({
        config,
        logger,
        mailbox: "Drafts",
        needle,
      })
    : await fetchMailboxMessages({
        config,
        logger,
        mailbox: "Drafts",
        maxResults: 100,
      });
  const seen = new Set<string>();
  return [...(direct ? [direct] : []), ...messages].filter((message) => {
    if (seen.has(message.id)) return false;
    const matches =
      message.threadId === draftId ||
      message.id === draftId ||
      message.headers["message-id"] === draftId ||
      messageMatchesThreadId(message, draftId);
    if (!matches) return false;
    seen.add(message.id);
    return true;
  });
}

async function appendDraftRaw({
  config,
  logger,
  raw,
}: {
  config: ImapConfig;
  logger: Logger;
  raw: string;
}) {
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    await ensureMailbox(client, "Drafts");
    return await client.append("Drafts", raw, ["\\Draft"]);
  } catch (error) {
    logger.error("Failed saving IMAP draft", {
      error,
      emailAccountId: config.emailAccountId,
    });
    throw new SafeError("Failed to save IMAP draft");
  } finally {
    await client.logout().catch(() => undefined);
  }
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
  const ref = parseImapMessageRef(messageId);
  if (!ref) throw new SafeError("Draft not found");
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    const lock = await client.getMailboxLock(ref.mailbox || "Drafts");
    try {
      await client.messageDelete(ref.uid, { uid: true });
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
  const matches = await messagesMatchingThread({
    config,
    logger,
    mailbox: sourceMailbox,
    threadId,
  });
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
  const ref = parseImapMessageRef(messageId);
  if (!ref) return;
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    await ensureMailbox(client, mailbox);
    const lock = await client.getMailboxLock(
      sourceMailbox || ref.mailbox || config.syncFolder || "INBOX",
    );
    try {
      await client.messageMove(ref.uid, mailbox, { uid: true });
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
    attachments?: Parameters<typeof mimeAttachments>[0];
  };
  from: string;
}) {
  const to = args.to || email.headers.from;
  const subject =
    args.subject ||
    (email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`);
  const messageId = email.headers["message-id"];
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(args.cc ? [`Cc: ${args.cc}`] : []),
    ...(args.bcc ? [`Bcc: ${args.bcc}`] : []),
    `Subject: ${subject}`,
    ...(messageId
      ? [`In-Reply-To: ${messageId}`, `References: ${messageId}`]
      : []),
    "MIME-Version: 1.0",
  ];
  const files = mimeAttachments(args.attachments);
  if (!files.length) {
    headers.push("Content-Type: text/plain; charset=utf-8");
    return `${headers.join("\r\n")}\r\n\r\n${args.content}`;
  }
  const boundary = `inboxzero-${crypto.randomUUID()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    [
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      args.content,
    ].join("\r\n"),
    ...files.map((file) => attachmentMimePart(file)),
  ];
  return `${headers.join("\r\n")}\r\n\r\n${parts
    .map((part) => `--${boundary}\r\n${part}`)
    .join("\r\n")}\r\n--${boundary}--`;
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
  attachments,
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
  attachments?: SendEmailBody["attachments"];
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
  ].filter((line): line is string => Boolean(line));
  const files = attachments ?? [];
  if (!files.length) {
    headers.push(`Content-Type: ${contentType}`);
    return `${headers.join("\r\n")}\r\n\r\n${body}`;
  }
  const boundary = `inboxzero-${crypto.randomUUID()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    [
      `Content-Type: ${contentType}`,
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
    ].join("\r\n"),
    ...files.map((attachment) => attachmentMimePart(attachment)),
  ];
  return `${headers.join("\r\n")}\r\n\r\n${parts
    .map((part) => `--${boundary}\r\n${part}`)
    .join("\r\n")}\r\n--${boundary}--`;
}

function mimeAttachments(
  attachments:
    | {
        filename?: string | false | null;
        content?: unknown;
        encoding?: string | false | null;
        contentType?: string | false | null;
      }[]
    | undefined,
) {
  return (attachments ?? []).flatMap((attachment) => {
    if (typeof attachment.filename !== "string" || !attachment.filename) {
      return [];
    }
    const content = attachmentContentBase64(
      attachment.content,
      attachment.encoding,
    );
    if (!content) return [];
    return [
      {
        filename: attachment.filename,
        content,
        contentType:
          typeof attachment.contentType === "string"
            ? attachment.contentType
            : undefined,
      },
    ];
  });
}

function attachmentContentBase64(
  content: unknown,
  encoding: string | false | null | undefined,
) {
  if (typeof content === "string") {
    if (encoding === "base64") return content;
    return Buffer.from(content).toString("base64");
  }
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    return Buffer.from(content).toString("base64");
  }
  return null;
}

function attachmentMimePart(
  attachment: NonNullable<SendEmailBody["attachments"]>[number],
) {
  const filename = attachment.filename.replace(/[\r\n"]/g, "");
  const contentType = attachment.contentType || "application/octet-stream";
  const inline = attachment.disposition === "inline" && attachment.contentId;
  const lines = [
    `Content-Type: ${contentType}; name="${filename}"`,
    `Content-Disposition: ${inline ? "inline" : "attachment"}; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
  ];
  if (inline && attachment.contentId) {
    lines.push(
      `Content-ID: <${attachment.contentId.replace(/[<>\r\n]/g, "")}>`,
    );
  }
  lines.push("", wrapBase64(attachment.content));
  return lines.join("\r\n");
}

function wrapBase64(value: string) {
  return value
    .replace(/\s/g, "")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
}

async function storeSentMailbox({
  config,
  logger,
}: {
  config: ImapConfig;
  logger: Logger;
}) {
  try {
    const page = await fetchSentMessagePage({
      config,
      logger,
      maxResults: 100,
    });
    await storeSentMessages({ config, messages: page.messages });
    // A partial page cannot tell a deleted uid from mail that is simply older.
    if (page.foundMailbox && !page.nextPageToken) {
      await dropSentMessagesMissingFromMailbox({
        config,
        messages: page.messages,
      });
    }
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
          messageId: sentMessageId(message.id),
        },
      },
      create: {
        emailAccountId: config.emailAccountId,
        threadId: message.threadId,
        messageId: sentMessageId(message.id),
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
    await connectImapClient(client);
    await ensureMailbox(client, "Sent");
    const appended = await client.append("Sent", raw, ["\\Seen"]);
    if (appended?.uid) {
      const message = await parseImapMessage(
        appended.uid,
        Buffer.from(raw),
        new Set(["\\Seen"]),
        undefined,
        "Sent",
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
  return legacySubjectThreadKey(subject) || String(uid);
}

function messageMatchesThreadId(
  message: { threadId: string; subject: string },
  threadId: string,
) {
  if (message.threadId === threadId) return true;
  // Older rule history stored the subject when the message had no id yet.
  if (threadId.includes("<")) return false;
  return legacySubjectThreadKey(message.subject) === threadId;
}

function messageIdsIn(value?: string) {
  if (!value) return [];
  const wrapped = value.match(/<[^>]+>/g);
  if (wrapped?.length) return wrapped;
  return value.split(/\s+/).filter(Boolean);
}

async function messagesMatchingThread({
  config,
  logger,
  mailbox,
  threadId,
}: {
  config: ImapConfig;
  logger: Logger;
  mailbox: string;
  threadId: string;
}) {
  const needle = messageIdNeedle(threadId);
  const messages = needle
    ? await fetchMailboxThreadMatches({
        config,
        logger,
        mailbox,
        needle,
      })
    : await fetchMailboxMessages({
        config,
        logger,
        mailbox,
        maxResults: 100,
      });
  return messages.filter((message) =>
    messageMatchesThreadId(message, threadId),
  );
}

async function fetchMailboxThreadMatches({
  config,
  logger,
  mailbox,
  needle,
}: {
  config: ImapConfig;
  logger: Logger;
  mailbox: string;
  needle: string;
}): Promise<ParsedImapMessage[]> {
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const uids = new Set<number>();
      for (const header of ["Message-ID", "References", "In-Reply-To"]) {
        const searched = await client.search(
          { header: { [header]: needle } },
          { uid: true },
        );
        for (const uid of Array.isArray(searched) ? searched : []) {
          if (typeof uid === "number") uids.add(uid);
        }
      }
      const pageUids = [...uids];
      if (!pageUids.length) return [];
      const wanted = new Set(pageUids.map(String));
      const messages: ParsedImapMessage[] = [];
      for await (const message of client.fetch(
        pageUids.join(","),
        {
          uid: true,
          source: true,
          flags: true,
          internalDate: true,
        },
        { uid: true },
      )) {
        if (!wanted.has(String(message.uid)) || !message.source) continue;
        const parsed = await parseImapMessage(
          message.uid,
          message.source,
          message.flags,
          message.internalDate,
          mailbox,
        );
        if (
          isInboxMailbox(mailbox, config.syncFolder || "INBOX") &&
          !parsed.labelIds?.includes("INBOX")
        ) {
          parsed.labelIds = [...(parsed.labelIds || []), "INBOX"];
        }
        messages.push(parsed);
      }
      return messages;
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

function messageIdNeedle(threadId: string) {
  if (!threadId.includes("@")) return "";
  return threadId.trim().replace(/^<|>$/g, "");
}

async function collectThreadCopies({
  config,
  logger,
  threadId,
}: {
  config: ImapConfig;
  logger: Logger;
  threadId: string;
}): Promise<ParsedImapMessage[]> {
  const mailboxes = await mailboxNamesForRead({ config, logger });
  const collected: ParsedImapMessage[] = [];
  for (const [index, mailbox] of mailboxes.entries()) {
    let messages: ParsedImapMessage[] = [];
    try {
      messages = await messagesMatchingThread({
        config,
        logger,
        mailbox,
        threadId,
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
      collected.push({ ...message, _mailbox: mailbox });
    }
  }
  return collected;
}

function messagesForOpenThread(
  messages: ParsedImapMessage[],
  options?: GetThreadOptions,
) {
  const hidden = new Set(["trash"]);
  if (!options?.includeDrafts) hidden.add("drafts");
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

function readStateTargets<T extends { labelIds?: string[] | null }>(
  messages: T[],
) {
  const inbox = inboxCopies(messages);
  if (inbox.length) return inbox;
  return messages.filter((message) => {
    const labels = message.labelIds ?? [];
    return !labels.includes("SENT") && !labels.includes("DRAFT");
  });
}

const IMAP_CONNECTION_ERROR =
  "IMAP connection failed. Check host, port, TLS, and credentials.";

async function connectImapClient(client: ImapFlow) {
  try {
    await client.connect();
  } catch (error) {
    if (error instanceof SafeError) throw error;
    const wrapped = new SafeError(IMAP_CONNECTION_ERROR);
    wrapped.cause = error;
    throw wrapped;
  }
}

function isMissingThread(error: unknown) {
  return error instanceof SafeError && error.message === "Thread not found";
}

const SENT_MAILBOXES = ["Sent", "Sent Items", "[Gmail]/Sent Mail"];

async function hasSentMailTo({
  config,
  senderEmail,
}: {
  config: ImapConfig;
  senderEmail: string;
}) {
  const sender = extractEmailAddress(senderEmail).toLowerCase();
  if (!sender) return true;

  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    for (const mailbox of SENT_MAILBOXES) {
      const lock = await client
        .getMailboxLock(mailbox)
        .catch((error: unknown) => {
          if (isMissingImapMailbox(error)) return null;
          throw error;
        });
      if (!lock) continue;
      try {
        const searched = await client.search(
          { to: senderEmail },
          { uid: true },
        );
        const uids = Array.isArray(searched) ? searched : [];
        const newest = [...uids].sort((a, b) => b - a).slice(0, 8);
        if (!newest.length) continue;
        const wanted = new Set(newest.map(String));
        for await (const message of client.fetch(
          newest.join(","),
          {
            uid: true,
            source: true,
            flags: true,
            internalDate: true,
          },
          { uid: true },
        )) {
          if (!wanted.has(String(message.uid)) || !message.source) continue;
          const parsed = await parseImapMessage(
            message.uid,
            message.source,
            message.flags ?? new Set(),
            messageInternalDate(message.internalDate),
            mailbox,
          );
          const recipients = extractEmailAddresses(parsed.headers.to);
          if (recipients.some((address) => address.toLowerCase() === sender)) {
            return true;
          }
        }
      } finally {
        lock.release();
      }
    }
    return false;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function fetchSentMessages({
  config,
  logger,
  maxResults,
}: {
  config: ImapConfig;
  logger: Logger;
  maxResults: number;
}) {
  const page = await fetchSentMessagePage({ config, logger, maxResults });
  return page.messages;
}

async function fetchSentMessagePage({
  config,
  logger,
  maxResults,
  beforeSequence,
}: {
  config: ImapConfig;
  logger: Logger;
  maxResults: number;
  beforeSequence?: number;
}) {
  for (const mailbox of SENT_MAILBOXES) {
    try {
      const page = await fetchMailboxMessagePage({
        config,
        logger,
        mailbox,
        maxResults,
        beforeSequence,
      });
      return { ...page, foundMailbox: true };
    } catch (error) {
      if (isMissingImapMailbox(error)) continue;
      throw error;
    }
  }
  return { messages: [], nextPageToken: undefined, foundMailbox: false };
}

async function dropSentMessagesMissingFromMailbox({
  config,
  messages,
}: {
  config: ImapConfig;
  messages: ParsedImapMessage[];
}) {
  const ids = messages.map((message) => sentMessageId(message.id));
  await prisma.emailMessage.deleteMany({
    where: {
      emailAccountId: config.emailAccountId,
      sent: true,
      messageId: {
        startsWith: "sent:",
        ...(ids.length ? { notIn: ids } : {}),
      },
    },
  });
}

async function findImapMessagesFromSender({
  config,
  logger,
  senderEmail,
  before,
  after,
}: {
  config: ImapConfig;
  logger: Logger;
  senderEmail: string;
  before?: Date;
  after?: Date;
}) {
  const sender = extractEmailAddress(senderEmail).toLowerCase();
  if (!sender) return [];

  const client = createImapClient(config);
  await connectImapClient(client);
  const found: ParsedImapMessage[] = [];
  try {
    const syncFolder = config.syncFolder || "INBOX";
    const folderNames = [
      syncFolder,
      "Sent",
      "Archive",
      "Trash",
      "Drafts",
      "Junk",
    ];
    try {
      const boxes = await client.list();
      for (const box of boxes) {
        if (box.path) folderNames.push(box.path);
      }
    } catch (error) {
      logger.warn("Skipped IMAP folder list while reading a sender", {
        error,
        emailAccountId: config.emailAccountId,
      });
    }
    const folders = folderNames.filter(
      (mailbox, index, all) =>
        all.findIndex(
          (item) => item.toLowerCase() === mailbox.toLowerCase(),
        ) === index && isSearchableMailbox(mailbox),
    );
    for (const folder of folders) {
      const lock = await client
        .getMailboxLock(folder)
        .catch((error: unknown) => {
          if (isMissingImapMailbox(error)) return null;
          throw error;
        });
      if (!lock) continue;
      try {
        const searched = await client.search(
          { from: senderEmail },
          { uid: true },
        );
        const uids = Array.isArray(searched) ? searched : [];
        // Newest UIDs are enough for unsubscribe and sender history lookups.
        const newest = [...uids].sort((a, b) => b - a).slice(0, 50);
        if (!newest.length) continue;
        const wanted = new Set(newest.map(String));
        for await (const message of client.fetch(
          newest.join(","),
          {
            uid: true,
            source: true,
            flags: true,
            internalDate: true,
          },
          { uid: true },
        )) {
          if (!wanted.has(String(message.uid)) || !message.source) continue;
          const parsed = await parseImapMessage(
            message.uid,
            message.source,
            message.flags ?? new Set(),
            messageInternalDate(message.internalDate),
            folder,
          );
          if (
            extractEmailAddress(parsed.headers.from).toLowerCase() !== sender
          ) {
            continue;
          }
          const sentAt = new Date(parsed.date);
          if (Number.isNaN(sentAt.getTime())) continue;
          if (before && sentAt >= before) continue;
          if (after && sentAt <= after) continue;
          if (
            isInboxMailbox(folder, syncFolder) &&
            !parsed.labelIds?.includes("INBOX")
          ) {
            parsed.labelIds = [...(parsed.labelIds || []), "INBOX"];
          }
          found.push(parsed);
        }
      } finally {
        lock.release();
      }
    }
    return found.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
  } catch (error) {
    logger.error("Failed reading IMAP messages from a sender", {
      error,
      emailAccountId: config.emailAccountId,
    });
    throw new SafeError("Failed to read IMAP mailbox");
  } finally {
    await client.logout().catch(() => undefined);
  }
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
  await connectImapClient(client);
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
          if (
            folder === syncFolder &&
            message.uid === parseImapMessageRef(messageId)?.uid
          ) {
            continue;
          }
          const parsed = await parseImapMessage(
            message.uid,
            message.source,
            message.flags ?? new Set(),
            messageInternalDate(message.internalDate),
            folder,
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
  const currentUid = currentMessageId
    ? parseImapMessageRef(currentMessageId)?.uid
    : undefined;
  const remaining = uids.filter(
    (uid) => Number.isFinite(uid) && uid !== currentUid,
  );
  if (remaining.length <= 8) return remaining;
  const sorted = [...remaining].sort((a, b) => a - b);
  return [...new Set([...sorted.slice(0, 4), ...sorted.slice(-4)])];
}

function pageOffset(pageToken: string | undefined) {
  const offset = Number(pageToken);
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  return Math.floor(offset);
}

function messageInsideDateWindow(
  message: { date: string },
  after?: Date,
  before?: Date,
) {
  const sentAt = new Date(message.date).getTime();
  if (Number.isNaN(sentAt)) return false;
  if (after && sentAt < after.getTime()) return false;
  if (before && sentAt >= before.getTime()) return false;
  return true;
}

function imapSearchWindow(after?: Date, before?: Date) {
  // SEARCH dates are whole UTC days. One extra day on each side keeps a
  // message the server dates differently from the selected range; the exact
  // timestamps are still applied after the fetch.
  const day = 24 * 60 * 60 * 1000;
  return {
    since: after ? new Date(utcDay(after) - day) : undefined,
    before: before ? new Date(utcDay(before) + day) : undefined,
  };
}

function utcDay(value: Date) {
  return Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
  );
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

const SENDER_LABEL_RULE_PREFIX = "Sender label:";

async function listSenderLabelFilters(emailAccountId: string) {
  const rules = await prisma.rule.findMany({
    where: {
      emailAccountId,
      enabled: true,
      name: { startsWith: SENDER_LABEL_RULE_PREFIX },
    },
    select: {
      id: true,
      from: true,
      actions: {
        where: { type: ActionType.LABEL },
        select: { labelId: true },
      },
    },
  });
  return rules.flatMap((rule) => {
    const labelIds = rule.actions.flatMap((action) =>
      action.labelId ? [action.labelId] : [],
    );
    if (!rule.from || !labelIds.length) return [];
    return [
      {
        id: rule.id,
        criteria: { from: rule.from },
        action: { addLabelIds: labelIds },
      },
    ];
  });
}

async function saveSenderLabelFilters({
  emailAccountId,
  from,
  labelIds,
}: {
  emailAccountId: string;
  from: string;
  labelIds?: string[];
}) {
  const sender = extractEmailAddress(from) || from.trim();
  if (!sender || !labelIds?.length) return;

  for (const labelId of labelIds) {
    const keyword = senderLabelKeyword(labelId);
    const name = `${SENDER_LABEL_RULE_PREFIX} ${sender} ${keyword}`;
    await prisma.rule.upsert({
      where: {
        name_emailAccountId: { name, emailAccountId },
      },
      create: {
        name,
        emailAccountId,
        enabled: true,
        from: sender,
        actions: {
          create: {
            type: ActionType.LABEL,
            label: keyword,
            labelId: keyword,
          },
        },
      },
      update: { enabled: true, from: sender },
    });
  }
}

async function deleteSenderLabelFilter({
  emailAccountId,
  id,
}: {
  emailAccountId: string;
  id: string;
}) {
  const rule = await prisma.rule.findFirst({
    where: {
      id,
      emailAccountId,
      name: { startsWith: SENDER_LABEL_RULE_PREFIX },
    },
    select: { id: true },
  });
  if (!rule) return;
  await prisma.rule.delete({ where: { id: rule.id } });
}

function senderLabelKeyword(labelId: string) {
  try {
    return imapKeyword(labelId);
  } catch {
    throw new SafeError("Invalid label");
  }
}

function sentMessageId(messageId: string) {
  const uid = parseImapMessageRef(messageId)?.uid;
  return `sent:${uid ?? messageId}`;
}

function imapMessageId(mailbox: string, uid: number) {
  return `${mailbox}/${uid}`;
}

function parseImapMessageRef(messageId: string) {
  const separator = messageId.lastIndexOf("/");
  if (separator > 0) {
    const uid = Number(messageId.slice(separator + 1));
    const mailbox = messageId.slice(0, separator);
    if (mailbox && Number.isInteger(uid) && uid > 0) return { mailbox, uid };
  }
  const uid = Number(messageId);
  if (Number.isInteger(uid) && uid > 0) return { uid };
  return null;
}

async function findImapMessageByRfc822Id({
  config,
  logger,
  rfc822MessageId,
}: {
  config: ImapConfig;
  logger: Logger;
  rfc822MessageId: string;
}): Promise<ParsedImapMessage | null> {
  const needle = rfc822MessageId.trim().replace(/^<|>$/g, "");
  if (!needle) return null;
  const mailboxes = await mailboxNamesForRead({ config, logger });
  for (const [index, mailbox] of mailboxes.entries()) {
    if (!isSearchableMailbox(mailbox)) continue;
    try {
      const message = await fetchMailboxHeaderMatch({
        config,
        logger,
        mailbox,
        header: "Message-ID",
        value: needle,
      });
      if (
        message &&
        normalizeMessageId(message.headers["message-id"]) ===
          needle.toLowerCase()
      ) {
        return message;
      }
    } catch (error) {
      if (index === 0) throw error;
      if (isMissingImapMailbox(error)) continue;
      logger.warn("Skipped IMAP folder while looking up a message", {
        error,
        mailbox,
      });
    }
  }
  return null;
}

async function fetchMailboxHeaderMatch({
  config,
  logger,
  mailbox,
  header,
  value,
}: {
  config: ImapConfig;
  logger: Logger;
  mailbox: string;
  header: string;
  value: string;
}): Promise<ParsedImapMessage | null> {
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const searched = await client.search(
        { header: { [header]: value } },
        { uid: true },
      );
      const uid = (Array.isArray(searched) ? searched : [])
        .filter((item): item is number => typeof item === "number")
        .sort((left, right) => right - left)[0];
      if (!uid) return null;
      const message = await client.fetchOne(
        uid,
        { uid: true, source: true, flags: true, internalDate: true },
        { uid: true },
      );
      if (!message?.source) return null;
      const parsed = await parseImapMessage(
        message.uid,
        message.source,
        message.flags,
        message.internalDate,
        mailbox,
      );
      if (
        isInboxMailbox(mailbox, config.syncFolder || "INBOX") &&
        !parsed.labelIds?.includes("INBOX")
      ) {
        parsed.labelIds = [...(parsed.labelIds || []), "INBOX"];
      }
      return parsed;
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

function normalizeMessageId(value: string | undefined) {
  return (value || "").trim().replace(/^<|>$/g, "").toLowerCase();
}

const SEARCH_SKIPPED_MAILBOXES = new Set(["trash", "drafts", "junk", "spam"]);

function isSearchableMailbox(mailbox: string) {
  return !SEARCH_SKIPPED_MAILBOXES.has(mailbox.toLowerCase());
}

async function findImapMessagesWithAttachments({
  config,
  logger,
  maxResults,
  pageToken,
}: {
  config: ImapConfig;
  logger: Logger;
  maxResults: number;
  pageToken?: string;
}): Promise<{ messages: ParsedImapMessage[]; nextPageToken?: string }> {
  const limit = Math.max(maxResults, 0);
  const offset = pageOffset(pageToken);
  if (limit === 0) return { messages: [] };

  const mailboxes = (await mailboxNamesForRead({ config, logger })).filter(
    isSearchableMailbox,
  );
  const found: ParsedImapMessage[] = [];
  const seen = new Set<string>();
  const scanLimit = Math.max(offset + limit, ATTACHMENT_SCAN_LIMIT);
  for (const [index, mailbox] of mailboxes.entries()) {
    try {
      const messages = await fetchMailboxMessages({
        config,
        logger,
        mailbox,
        maxResults: scanLimit,
      });
      for (const message of messages) {
        if (!message.hasAttachment || seen.has(message.id)) continue;
        seen.add(message.id);
        found.push(message);
      }
    } catch (error) {
      if (index === 0) throw error;
      if (isMissingImapMailbox(error)) continue;
      logger.warn("Skipped IMAP folder while reading attachments", {
        error,
        mailbox,
      });
    }
  }

  found.sort(
    (left, right) =>
      Number(right.internalDate || "0") - Number(left.internalDate || "0"),
  );
  return {
    messages: found.slice(offset, offset + limit),
    nextPageToken:
      offset + limit < found.length ? String(offset + limit) : undefined,
  };
}

async function findImapMessagesWithParticipant({
  config,
  logger,
  participantEmail,
}: {
  config: ImapConfig;
  logger: Logger;
  participantEmail: string;
}): Promise<ParsedImapMessage[]> {
  const participant = extractEmailAddress(participantEmail).toLowerCase();
  if (!participant) return [];

  const mailboxes = (await mailboxNamesForRead({ config, logger })).filter(
    isSearchableMailbox,
  );
  const found: ParsedImapMessage[] = [];
  const seen = new Set<string>();
  for (const [index, mailbox] of mailboxes.entries()) {
    try {
      const messages = await fetchMailboxParticipantMatches({
        config,
        mailbox,
        participant,
      });
      for (const message of messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        found.push(message);
      }
    } catch (error) {
      if (index === 0) throw error;
      if (isMissingImapMailbox(error)) continue;
      logger.warn("Skipped IMAP folder while reading a participant", {
        error,
        mailbox,
      });
    }
  }
  return found;
}

async function fetchMailboxParticipantMatches({
  config,
  mailbox,
  participant,
}: {
  config: ImapConfig;
  mailbox: string;
  participant: string;
}): Promise<ParsedImapMessage[]> {
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const searched = await client.search(
        {
          or: [{ from: participant }, { to: participant }, { cc: participant }],
        },
        { uid: true },
      );
      const uids = (Array.isArray(searched) ? searched : [])
        .filter((uid): uid is number => typeof uid === "number")
        .sort((left, right) => right - left)
        .slice(0, 40);
      if (!uids.length) return [];
      const wanted = new Set(uids.map(String));
      const messages: ParsedImapMessage[] = [];
      for await (const message of client.fetch(
        uids.join(","),
        {
          uid: true,
          source: true,
          flags: true,
          internalDate: true,
        },
        { uid: true },
      )) {
        if (!wanted.has(String(message.uid)) || !message.source) continue;
        const parsed = await parseImapMessage(
          message.uid,
          message.source,
          message.flags,
          messageInternalDate(message.internalDate),
          mailbox,
        );
        if (!messageIncludesParticipant(parsed, participant)) continue;
        if (
          isInboxMailbox(mailbox, config.syncFolder || "INBOX") &&
          !parsed.labelIds?.includes("INBOX")
        ) {
          parsed.labelIds = [...(parsed.labelIds || []), "INBOX"];
        }
        messages.push(parsed);
      }
      return messages;
    } finally {
      lock.release();
    }
  } catch (error) {
    if (isMissingImapMailbox(error)) {
      throw new SafeError("IMAP mailbox not found");
    }
    throw error;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function messageIncludesParticipant(
  message: ParsedMessage,
  participant: string,
) {
  return [
    message.headers.from,
    message.headers.to,
    message.headers.cc,
    message.headers.bcc,
  ]
    .flatMap((header) => extractEmailAddresses(header || ""))
    .some((address) => address.toLowerCase() === participant);
}

async function searchImapMessages({
  config,
  logger,
  needle,
  maxResults,
  pageToken,
}: {
  config: ImapConfig;
  logger: Logger;
  needle: string;
  maxResults: number;
  pageToken?: string;
}): Promise<{ messages: ParsedImapMessage[]; nextPageToken?: string }> {
  const mailboxes = await mailboxNamesForRead({ config, logger });
  const collected: ParsedImapMessage[] = [];
  for (const [index, mailbox] of mailboxes.entries()) {
    if (!isSearchableMailbox(mailbox)) continue;
    try {
      const messages = await fetchMailboxTextMatches({
        config,
        logger,
        mailbox,
        needle,
      });
      collected.push(...messages);
    } catch (error) {
      if (index === 0) throw error;
      if (isMissingImapMailbox(error)) continue;
      logger.warn("Skipped IMAP folder while searching mail", {
        error,
        mailbox,
      });
    }
  }
  const filtered = collected
    .filter((message) =>
      imapMessageHaystack(message).includes(needle.toLowerCase()),
    )
    .sort(
      (left, right) =>
        new Date(right.date).getTime() - new Date(left.date).getTime(),
    );
  const offset = pageOffset(pageToken);
  return {
    messages: filtered.slice(offset, offset + maxResults),
    nextPageToken:
      offset + maxResults < filtered.length
        ? String(offset + maxResults)
        : undefined,
  };
}

async function fetchMailboxTextMatches({
  config,
  logger,
  mailbox,
  needle,
}: {
  config: ImapConfig;
  logger: Logger;
  mailbox: string;
  needle: string;
}): Promise<ParsedImapMessage[]> {
  const client = createImapClient(config);
  await connectImapClient(client);
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const searched = await client.search({ text: needle }, { uid: true });
      const uids = (Array.isArray(searched) ? searched : [])
        .filter((uid): uid is number => typeof uid === "number")
        .sort((left, right) => right - left)
        .slice(0, SEARCH_MATCH_LIMIT);
      if (!uids.length) return [];
      const wanted = new Set(uids.map(String));
      const messages: ParsedImapMessage[] = [];
      for await (const message of client.fetch(
        uids.join(","),
        {
          uid: true,
          source: true,
          flags: true,
          internalDate: true,
        },
        { uid: true },
      )) {
        if (!wanted.has(String(message.uid)) || !message.source) continue;
        const parsed = await parseImapMessage(
          message.uid,
          message.source,
          message.flags,
          message.internalDate,
          mailbox,
        );
        if (
          isInboxMailbox(mailbox, config.syncFolder || "INBOX") &&
          !parsed.labelIds?.includes("INBOX")
        ) {
          parsed.labelIds = [...(parsed.labelIds || []), "INBOX"];
        }
        messages.push(parsed);
      }
      return messages;
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

function imapMessageHaystack(message: ParsedImapMessage) {
  return [
    message.subject,
    message.snippet,
    message.textPlain || "",
    message.headers.from,
    message.headers.to,
  ]
    .join("\n")
    .toLowerCase();
}

async function fetchSearchableMailboxMessages({
  config,
  logger,
  maxResults,
}: {
  config: ImapConfig;
  logger: Logger;
  maxResults: number;
}): Promise<ParsedImapMessage[]> {
  const mailboxes = await mailboxNamesForRead({ config, logger });
  const collected: ParsedImapMessage[] = [];
  for (const [index, mailbox] of mailboxes.entries()) {
    if (!isSearchableMailbox(mailbox)) continue;
    try {
      const messages = await fetchMailboxMessages({
        config,
        logger,
        mailbox,
        maxResults,
      });
      collected.push(...messages);
    } catch (error) {
      if (index === 0) throw error;
      if (isMissingImapMailbox(error)) continue;
      logger.warn("Skipped IMAP folder while searching mail", {
        error,
        mailbox,
      });
    }
  }
  return collected.sort(
    (left, right) =>
      Number(right.internalDate || "0") - Number(left.internalDate || "0"),
  );
}

async function mailboxNamesForRead({
  config,
  logger,
}: {
  config: ImapConfig;
  logger: Logger;
}): Promise<string[]> {
  const names = [
    config.syncFolder || "INBOX",
    "Sent",
    "Archive",
    "Trash",
    "Drafts",
    "Junk",
  ];
  const client = createImapClient(config);
  try {
    await connectImapClient(client);
    try {
      const boxes = await client.list();
      for (const box of boxes) {
        if (box.path) names.push(box.path);
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  } catch (error) {
    logger.warn("Skipped IMAP folder list while reading mail", {
      error,
      emailAccountId: config.emailAccountId,
    });
  }
  return names.filter(
    (mailbox, index, all) =>
      all.findIndex((item) => item.toLowerCase() === mailbox.toLowerCase()) ===
      index,
  );
}

function withMailboxRole(labelIds: string[], mailbox: string) {
  const role = mailboxRoleLabel(mailbox);
  if (!role || labelIds.includes(role)) return labelIds;
  return [...labelIds, role];
}

function mailboxRoleLabel(mailbox: string) {
  const name = mailbox.trim().toLowerCase();
  const leaf = name.split("/").at(-1) || name;
  if (name === "inbox" || leaf === "inbox") return "INBOX";
  if (
    name === "sent" ||
    leaf === "sent" ||
    name === "sent items" ||
    leaf === "sent items" ||
    name === "[gmail]/sent mail"
  ) {
    return "SENT";
  }
  if (name === "drafts" || leaf === "drafts" || leaf === "draft") {
    return "DRAFT";
  }
  if (
    name === "trash" ||
    leaf === "trash" ||
    leaf === "deleted" ||
    leaf === "deleted items"
  ) {
    return "TRASH";
  }
  if (
    name === "junk" ||
    leaf === "junk" ||
    leaf === "spam" ||
    leaf === "junk e-mail"
  ) {
    return "SPAM";
  }
  return;
}
