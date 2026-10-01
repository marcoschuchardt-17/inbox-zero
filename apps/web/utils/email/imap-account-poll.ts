import "server-only";
import { env } from "@/env";
import prisma from "@/utils/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import {
  applyImapStaticMailboxActions,
  archiveBlockedImapSenders,
  ensureImapMailboxRules,
  labelImapMessagesWithStaticRules,
} from "@/utils/email/imap-mailbox-rules";
import {
  collectImapPollMessages,
  highestImapUid,
} from "@/utils/email/imap-poll";
import type { Logger } from "@/utils/logger";

export async function pollImapAccount({
  emailAccountId,
  lastSyncedAt,
  logger,
}: {
  emailAccountId: string;
  lastSyncedAt: Date | null;
  logger: Logger;
}) {
  try {
    const provider = await createEmailProvider({
      emailAccountId,
      provider: "imap",
      logger,
    });
    const messages = await collectImapPollMessages(provider, {
      after: lastSyncedAt,
      limit: env.IMAP_POLL_MESSAGE_LIMIT,
    });
    const highestUid = highestImapUid(messages);

    await prisma.imapSmtpConfig.update({
      where: { emailAccountId },
      data: {
        lastSyncedAt: new Date(),
        ...(highestUid > 0 ? { lastSyncUid: BigInt(highestUid) } : {}),
        lastConnectionError: null,
      },
    });

    let labeled = 0;
    try {
      await ensureImapMailboxRules(emailAccountId);
      labeled = await labelImapMessagesWithStaticRules({
        emailAccountId,
        messages,
        provider,
        logger,
      });
      await applyImapStaticMailboxActions({
        emailAccountId,
        messages,
        provider,
        logger,
      });
      await archiveBlockedImapSenders({
        emailAccountId,
        messages,
        provider,
      });
    } catch (error) {
      logger.error("IMAP mailbox rules failed", { error, emailAccountId });
    }

    return { ok: true as const, labeled };
  } catch (error) {
    logger.error("IMAP poll failed for account", { error, emailAccountId });
    await prisma.imapSmtpConfig
      .update({
        where: { emailAccountId },
        data: {
          lastConnectionError:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Unknown error",
        },
      })
      .catch(() => undefined);
    return { ok: false as const, labeled: 0 };
  }
}
