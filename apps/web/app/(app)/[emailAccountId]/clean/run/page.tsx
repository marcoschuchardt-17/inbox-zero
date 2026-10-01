import { Suspense } from "react";
import { getThreadsByJobId } from "@/utils/redis/clean";
import prisma from "@/utils/prisma";
import { CardTitle } from "@/components/ui/card";
import { Loading } from "@/components/Loading";
import {
  getJobById,
  getLastJob,
} from "@/app/(app)/[emailAccountId]/clean/helpers";
import { CleanRun } from "@/app/(app)/[emailAccountId]/clean/CleanRun";
import { checkUserOwnsEmailAccount } from "@/utils/email-account";
import { isCleanerApiEnabled } from "@/utils/cleaner-feature";
import { cleanupThreadsForDisplay } from "@/utils/clean/cleanup-threads";
import { createEmailProvider } from "@/utils/email/provider";
import { createScopedLogger } from "@/utils/logger";

export default async function CleanRunPage(props: {
  params: Promise<{ emailAccountId: string }>;
  searchParams: Promise<{ jobId: string; isPreviewBatch: string }>;
}) {
  const { emailAccountId } = await props.params;
  await checkUserOwnsEmailAccount({ emailAccountId });

  const searchParams = await props.searchParams;

  const { jobId, isPreviewBatch } = searchParams;

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      account: { select: { provider: true } },
    },
  });

  if (!emailAccount) return <CardTitle>Email account not found</CardTitle>;

  const job = jobId
    ? await getJobById({ emailAccountId, jobId })
    : await getLastJob({ emailAccountId });

  if (!job) return <CardTitle>Job not found</CardTitle>;

  let threads = await getThreadsByJobId({
    emailAccountId,
    jobId: job.id,
  });

  const [total, done] = await Promise.all([
    prisma.cleanupThread.count({
      where: { jobId: job.id, emailAccountId },
    }),
    prisma.cleanupThread.count({
      where: { jobId: job.id, emailAccountId, archived: true },
    }),
  ]);

  if (threads.length === 0 && total > 0) {
    threads = await storedCleanupThreads({
      emailAccountId,
      jobId: job.id,
      provider: emailAccount.account.provider,
    });
  }

  return (
    <Suspense fallback={<Loading />}>
      <CleanRun
        isPreviewBatch={isPreviewBatch === "true"}
        job={job}
        threads={threads}
        total={total}
        done={done}
        streamEnabled={isCleanerApiEnabled()}
      />
    </Suspense>
  );
}

async function storedCleanupThreads({
  emailAccountId,
  jobId,
  provider,
}: {
  emailAccountId: string;
  jobId: string;
  provider: string;
}) {
  const rows = await prisma.cleanupThread.findMany({
    where: { jobId, emailAccountId },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { threadId: true, archived: true, createdAt: true },
  });
  const logger = createScopedLogger("clean-run").with({ emailAccountId });
  const emailProvider = await createEmailProvider({
    emailAccountId,
    provider,
    logger,
  });

  return cleanupThreadsForDisplay({
    emailAccountId,
    jobId,
    rows,
    loadThread: async (threadId) => {
      try {
        const thread = await emailProvider.getThread(threadId);
        return {
          messages: thread.messages.map((message) => ({
            subject: message.subject,
            snippet: message.snippet,
            date: message.date,
            headers: { from: message.headers.from },
          })),
        };
      } catch (error) {
        logger.warn("Clean result could not load a thread", {
          error,
          threadId,
        });
        return null;
      }
    },
  });
}
