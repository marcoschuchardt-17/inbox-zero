import { NextResponse } from "next/server";
import { env } from "@/env";
import prisma from "@/utils/prisma";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { withError } from "@/utils/middleware";
import { captureException } from "@/utils/error";
import { createEmailProvider } from "@/utils/email/provider";
import {
  ensureImapMailboxRules,
  labelImapMessagesWithStaticRules,
} from "@/utils/email/imap-mailbox-rules";
import type { Logger } from "@/utils/logger";

export const maxDuration = 300;

export const GET = withError("cron/imap-poll", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(
      new Error("Unauthorized cron request: api/cron/imap-poll"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runImapPoll(request.logger);
  return NextResponse.json(result);
});

export const POST = withError("cron/imap-poll", async (request) => {
  if (!(await hasPostCronSecret(request))) {
    captureException(
      new Error("Unauthorized cron request: api/cron/imap-poll"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await runImapPoll(request.logger);
  return NextResponse.json(result);
});

async function runImapPoll(logger: Logger) {
  if (!env.IMAP_POLL_ENABLED) {
    return { enabled: false, total: 0, processed: 0, failed: 0 };
  }

  const candidates = await prisma.imapSmtpConfig.findMany({
    where: {
      emailAccount: {
        account: {
          provider: "imap",
        },
      },
    },
    select: {
      emailAccountId: true,
      lastSyncedAt: true,
    },
    take: env.IMAP_POLL_BATCH_SIZE,
    orderBy: { updatedAt: "asc" },
  });

  let processed = 0;
  let failed = 0;
  let labeled = 0;

  for (const account of candidates) {
    try {
      const provider = await createEmailProvider({
        emailAccountId: account.emailAccountId,
        provider: "imap",
        logger,
      });
      const page = await provider.getMailboxSyncPage({
        after: account.lastSyncedAt ?? undefined,
        limit: env.IMAP_POLL_MESSAGE_LIMIT,
      });

      const highestUid = page.upsertedMessages
        .map((message) => Number(message.id))
        .filter((id) => Number.isFinite(id))
        .reduce((max, value) => (value > max ? value : max), 0);

      await prisma.imapSmtpConfig.update({
        where: { emailAccountId: account.emailAccountId },
        data: {
          lastSyncedAt: new Date(),
          ...(highestUid > 0 ? { lastSyncUid: BigInt(highestUid) } : {}),
          lastConnectionError: null,
        },
      });
      processed += 1;

      try {
        await ensureImapMailboxRules(account.emailAccountId);
        const recent = await provider.getMailboxSyncPage({
          limit: env.IMAP_POLL_MESSAGE_LIMIT,
        });
        labeled += await labelImapMessagesWithStaticRules({
          emailAccountId: account.emailAccountId,
          messages: recent.upsertedMessages,
          provider,
          logger,
        });
      } catch (error) {
        logger.error("IMAP mailbox rules failed", {
          error,
          emailAccountId: account.emailAccountId,
        });
      }
    } catch (error) {
      failed += 1;
      logger.error("IMAP poll failed for account", {
        error,
        emailAccountId: account.emailAccountId,
      });
      await prisma.imapSmtpConfig.update({
        where: { emailAccountId: account.emailAccountId },
        data: {
          lastConnectionError:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Unknown error",
        },
      });
    }
  }

  return {
    enabled: true,
    total: candidates.length,
    processed,
    failed,
    labeled,
  };
}
