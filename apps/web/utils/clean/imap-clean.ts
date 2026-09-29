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

  const limit = Math.min(maxEmails || 50, 100);
  const { threads } = await emailProvider.getThreadsWithQuery({
    maxResults: limit,
  });
  const cutoff = daysOld > 0 ? Date.now() - daysOld * ONE_DAY_MS : null;

  for (const thread of threads) {
    const latest = thread.messages.at(-1);
    if (!thread.id || !latest) continue;
    if (cutoff && new Date(latest.date).getTime() > cutoff) continue;

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

async function applyImapCleanAction({
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
