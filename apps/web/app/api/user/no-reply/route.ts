import { NextResponse } from "next/server";
import { isDefined } from "@/utils/types";
import { withEmailProvider } from "@/utils/middleware";
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
  const threads = (
    await Promise.all(
      sentEmails.map(async (message) => {
        try {
          return await emailProvider.getThread(message.threadId || "");
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
    if (!from.includes(userEmail)) continue;
    seen.add(thread.id);
    awaiting.push(thread);
  }
  return awaiting;
}

function isMissingThread(error: unknown) {
  return error instanceof Error && error.message === "Thread not found";
}
