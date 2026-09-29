import { NextResponse } from "next/server";
import { env } from "@/env";
import prisma from "@/utils/prisma";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { withError } from "@/utils/middleware";
import { captureException } from "@/utils/error";
import { pollImapAccount } from "@/utils/email/imap-account-poll";
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
    const result = await pollImapAccount({
      emailAccountId: account.emailAccountId,
      lastSyncedAt: account.lastSyncedAt,
      logger,
    });
    if (result.ok) {
      processed += 1;
      labeled += result.labeled;
    } else {
      failed += 1;
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
