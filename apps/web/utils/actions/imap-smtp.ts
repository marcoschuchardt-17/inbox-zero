"use server";

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { actionClientUser } from "@/utils/actions/safe-action";
import {
  testImapSmtpConnectionBody,
  upsertImapSmtpAccountBody,
  type UpsertImapSmtpAccountBody,
} from "@/utils/actions/imap-smtp.validation";
import { setLastEmailAccountCookie } from "@/utils/cookies.server";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";

const IMAP_CONNECT_TIMEOUT_MS = 10_000;

export const testImapSmtpConnectionAction = actionClientUser
  .metadata({ name: "testImapSmtpConnection" })
  .inputSchema(testImapSmtpConnectionBody)
  .action(async ({ parsedInput, ctx: { logger } }) => {
    const imapClient = new ImapFlow({
      host: parsedInput.imapHost,
      port: parsedInput.imapPort,
      secure: parsedInput.imapSecure,
      auth: {
        user: parsedInput.imapUsername,
        pass: parsedInput.imapPassword,
      },
      logger: false,
      connectionTimeout: IMAP_CONNECT_TIMEOUT_MS,
      greetingTimeout: IMAP_CONNECT_TIMEOUT_MS,
      socketTimeout: IMAP_CONNECT_TIMEOUT_MS,
    });

    try {
      await imapClient.connect();
      await imapClient.mailboxOpen(parsedInput.syncFolder || "INBOX");
    } catch (error) {
      logger.warn("IMAP connection test failed", { error });
      throw new SafeError(
        "IMAP connection failed. Check host, port, TLS, and credentials.",
      );
    } finally {
      await imapClient.logout().catch(() => undefined);
    }

    const smtp = nodemailer.createTransport({
      host: parsedInput.smtpHost,
      port: parsedInput.smtpPort,
      secure: parsedInput.smtpSecure,
      auth: {
        user: parsedInput.smtpUsername,
        pass: parsedInput.smtpPassword,
      },
      connectionTimeout: 10_000,
      socketTimeout: 10_000,
    });

    try {
      await smtp.verify();
    } catch (error) {
      logger.warn("SMTP connection test failed", { error });
      throw new SafeError(
        "SMTP connection failed. Check host, port, TLS, and credentials.",
      );
    }

    return { success: true };
  });

export const upsertImapSmtpAccountAction = actionClientUser
  .metadata({ name: "upsertImapSmtpAccount" })
  .inputSchema(upsertImapSmtpAccountBody)
  .action(async ({ parsedInput, ctx: { userId } }) => {
    const normalizedEmail = parsedInput.email.trim().toLowerCase();
    const providerAccountId = normalizedEmail;

    const existingEmailAccount = await prisma.emailAccount.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        userId: true,
        accountId: true,
      },
    });

    if (existingEmailAccount && existingEmailAccount.userId !== userId) {
      throw new SafeError("This email is already linked to another user.");
    }

    const imapConfig = imapConfigFromInput(parsedInput);

    if (existingEmailAccount?.userId === userId) {
      await prisma.account.update({
        where: { id: existingEmailAccount.accountId, userId },
        data: {
          provider: "imap",
          providerAccountId,
          type: "credentials",
          disconnectedAt: null,
          emailAccount: {
            update: {
              name: parsedInput.name || null,
              imapSmtpConfig: {
                upsert: {
                  update: { ...imapConfig, lastConnectionError: null },
                  create: imapConfig,
                },
              },
            },
          },
        },
      });

      await setLastEmailAccountCookie({
        userId,
        emailAccountId: existingEmailAccount.id,
      });

      return { emailAccountId: existingEmailAccount.id, updated: true };
    }

    const created = await prisma.account.create({
      data: {
        userId,
        provider: "imap",
        providerAccountId,
        type: "credentials",
        emailAccount: {
          create: {
            userId,
            email: normalizedEmail,
            name: parsedInput.name || null,
            imapSmtpConfig: { create: imapConfig },
          },
        },
      },
      select: {
        emailAccount: {
          select: {
            id: true,
          },
        },
      },
    });

    const createdEmailAccountId = created.emailAccount?.id;
    if (!createdEmailAccountId)
      throw new SafeError("Failed to create IMAP account");

    await setLastEmailAccountCookie({
      userId,
      emailAccountId: createdEmailAccountId,
    });

    return { emailAccountId: createdEmailAccountId, created: true };
  });

function imapConfigFromInput(parsedInput: UpsertImapSmtpAccountBody) {
  return {
    imapHost: parsedInput.imapHost,
    imapPort: parsedInput.imapPort,
    imapSecure: parsedInput.imapSecure,
    imapUsername: parsedInput.imapUsername,
    imapPassword: parsedInput.imapPassword,
    smtpHost: parsedInput.smtpHost,
    smtpPort: parsedInput.smtpPort,
    smtpSecure: parsedInput.smtpSecure,
    smtpUsername: parsedInput.smtpUsername,
    smtpPassword: parsedInput.smtpPassword,
    syncFolder: parsedInput.syncFolder,
  };
}
