import { CleanAction } from "@/generated/prisma/enums";
import type { CleanInboxBody } from "@/utils/actions/clean.validation";
import { decideCleanAction } from "@/utils/clean/decide";
import { ONE_DAY_MS } from "@/utils/date";
import { createEmailProvider } from "@/utils/email/provider";
import type { EmailProvider } from "@/utils/email/types";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

export async function runImapClean({
  emailAccountId,
  provider,
  logger,
  action,
  instructions,
  daysOld,
  skips,
  maxEmails,
}: {
  emailAccountId: string;
  provider: string;
  logger: Logger;
  action: CleanInboxBody["action"];
  instructions: string;
  daysOld: number;
  skips: CleanInboxBody["skips"];
  maxEmails?: number;
}) {
  const emailProvider = await createEmailProvider({
    emailAccountId,
    provider,
    logger,
  });
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { email: true },
  });
  if (!account) throw new SafeError("Email account not found");

  const job = await prisma.cleanupJob.create({
    data: {
      emailAccountId,
      action,
      instructions,
      daysOld,
      skipReply: skips.reply,
      skipStarred: skips.starred,
      skipCalendar: skips.calendar,
      skipReceipt: skips.receipt,
      skipAttachment: skips.attachment,
      skipConversation: skips.conversation,
    },
  });

  const limit = imapCleanFetchLimit(maxEmails);
  const threads = await loadImapCleanThreads({
    emailProvider,
    daysOld,
    limit,
  });

  for (const thread of threads) {
    const latest = thread.messages.at(-1);
    if (!thread.id || !latest) continue;

    const decision = decideCleanAction({
      messages: thread.messages,
      skips,
    });
    const markDone = decision === "done";
    if (markDone) {
      await applyImapCleanAction({
        action,
        emailProvider,
        ownerEmail: account.email,
        threadId: thread.id,
      });
    }

    await prisma.cleanupThread.create({
      data: {
        emailAccount: { connect: { id: emailAccountId } },
        threadId: thread.id,
        archived: markDone,
        job: { connect: { id: job.id } },
      },
    });
  }

  return { jobId: job.id };
}

export async function applyImapCleanAction({
  action,
  emailProvider,
  ownerEmail,
  threadId,
}: {
  action: CleanInboxBody["action"];
  emailProvider: EmailProvider;
  ownerEmail: string;
  threadId: string;
}) {
  if (action === CleanAction.MARK_READ) {
    await emailProvider.markReadThread(threadId, true);
    return;
  }
  await emailProvider.archiveThread(threadId, ownerEmail);
}

export async function undoImapClean({
  action,
  emailProvider,
  threadId,
}: {
  action: CleanInboxBody["action"];
  emailProvider: EmailProvider;
  threadId: string;
}) {
  if (action === CleanAction.MARK_READ) {
    await emailProvider.markReadThread(threadId, false);
    return;
  }
  await emailProvider.unarchiveThread(threadId);
}

const CLEAN_PAGE_SIZE = 100;
const MAX_CLEAN_PAGES = 20;

export function imapCleanFetchLimit(maxEmails?: number) {
  if (maxEmails == null) return CLEAN_PAGE_SIZE * MAX_CLEAN_PAGES;
  return Math.min(Math.max(maxEmails, 0), CLEAN_PAGE_SIZE);
}

export async function loadImapCleanThreads({
  emailProvider,
  daysOld,
  limit,
  now = new Date(),
}: {
  emailProvider: Pick<EmailProvider, "getThreadsWithQuery">;
  daysOld: number;
  limit: number;
  now?: Date;
}) {
  const cutoff = daysOld > 0 ? now.getTime() - daysOld * ONE_DAY_MS : null;
  const threads = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_CLEAN_PAGES && threads.length < limit; page++) {
    const result = await emailProvider.getThreadsWithQuery({
      maxResults: Math.min(CLEAN_PAGE_SIZE, limit),
      pageToken,
      query: cutoff ? { before: new Date(cutoff), type: "inbox" } : undefined,
    });
    for (const thread of result.threads) {
      const latest = thread.messages.at(-1);
      if (!thread.id || !latest) continue;
      if (cutoff && new Date(latest.date).getTime() > cutoff) continue;
      threads.push(thread);
      if (threads.length >= limit) break;
    }
    if (!result.nextPageToken || result.nextPageToken === pageToken) break;
    pageToken = result.nextPageToken;
  }

  return threads;
}
