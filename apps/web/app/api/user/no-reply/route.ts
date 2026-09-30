import { NextResponse } from "next/server";
import { isDefined } from "@/utils/types";
import { withEmailProvider } from "@/utils/middleware";
import { messageIsFromAccountOnly } from "@/utils/email";
import { createEmailProvider } from "@/utils/email/provider";
import type { Logger } from "@/utils/logger";

export type NoReplyResponse = Awaited<ReturnType<typeof getNoReply>>;

async function getNoReply({
  emailAccountId,
  userEmail,
  provider,
  logger,
}: {
  emailAccountId: string;
  userEmail: string;
  provider: string;
  logger: Logger;
}) {
  const emailProvider = await createEmailProvider({
    emailAccountId,
    provider,
    logger,
  });

  const sentEmails = await emailProvider.getSentMessages(50);
  const threadIds = sentEmails.map((message) => message.threadId || "");
  // A copy the account sent can sit in Archive without a Sent label.
  if (provider === "imap") {
    const fromAccount = await emailProvider.getThreadsWithQuery({
      query: { fromEmail: userEmail },
      maxResults: 50,
    });
    for (const thread of fromAccount.threads) {
      if (thread.id) threadIds.push(thread.id);
    }
  }
  const seenIds = new Set<string>();
  const uniqueThreadIds: string[] = [];
  for (const threadId of threadIds) {
    if (!threadId || seenIds.has(threadId)) continue;
    seenIds.add(threadId);
    uniqueThreadIds.push(threadId);
  }
  const threads = (
    await Promise.all(
      uniqueThreadIds.map(async (threadId) => {
        try {
          return await emailProvider.getThread(threadId);
        } catch (error) {
          if (isMissingThread(error)) return;
          throw error;
        }
      }),
    )
  ).filter(isDefined);

  return threadsStillAwaitingReply(threads, userEmail);
}

export const GET = withEmailProvider("user/no-reply", async (request) => {
  const emailAccountId = request.auth.emailAccountId;
  const userEmail = request.auth.email;

  const result = await getNoReply({
    emailAccountId,
    userEmail,
    provider: request.emailProvider.name,
    logger: request.logger,
  });

  return NextResponse.json(result);
});

function threadsStillAwaitingReply<
  T extends { id: string; messages: { headers: { from: string } }[] },
>(threads: T[], userEmail: string) {
  const seen = new Set<string>();
  const awaiting: T[] = [];
  for (const thread of threads) {
    if (!thread.id || seen.has(thread.id)) continue;
    const from = thread.messages.at(-1)?.headers.from || "";
    // A shorter address inside another sender is not this account, and a
    // message sent together with someone else is not waiting on our reply.
    if (!messageIsFromAccountOnly(from, userEmail)) continue;
    seen.add(thread.id);
    awaiting.push(thread);
  }
  return awaiting;
}

function isMissingThread(error: unknown) {
  return error instanceof Error && error.message === "Thread not found";
}
