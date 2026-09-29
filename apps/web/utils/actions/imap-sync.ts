"use server";

import { env } from "@/env";
import { pollImapAccount } from "@/utils/email/imap-account-poll";
import { isImapProvider } from "@/utils/email/provider-types";
import prisma from "@/utils/prisma";
import { actionClient } from "@/utils/actions/safe-action";

export const syncImapMailboxAction = actionClient
  .metadata({ name: "syncImapMailbox" })
  .action(async ({ ctx: { emailAccountId, provider, logger } }) => {
    if (!isImapProvider(provider) || !env.IMAP_POLL_ENABLED) {
      return { synced: false };
    }

    const config = await prisma.imapSmtpConfig.findUnique({
      where: { emailAccountId },
      select: { lastSyncedAt: true },
    });
    if (!config) return { synced: false };

    const result = await pollImapAccount({
      emailAccountId,
      lastSyncedAt: config.lastSyncedAt,
      logger,
    });
    return { synced: result.ok };
  });
