"use server";

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { actionClientUser } from "@/utils/actions/safe-action";
import {
  testImapSmtpConnectionBody,
  upsertImapSmtpAccountBody,
} from "@/utils/actions/imap-smtp.validation";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";

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

    if (existingEmailAccount?.userId === userId) {
      await prisma.account.update({
        where: { id: existingEmailAccount.accountId, userId },
        data: {
          provider: "imap",
          providerAccountId,
          type: "credentials",
          disconnectedAt: null,
        },
      });

      await prisma.imapSmtpConfig.upsert({
        where: { emailAccountId: existingEmailAccount.id },
        update: {
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
          lastConnectionError: null,
        },
        create: {
          emailAccountId: existingEmailAccount.id,
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
        },
      });

      await prisma.emailAccount.update({
        where: { id: existingEmailAccount.id },
        data: {
          name: parsedInput.name || null,
        },
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

    await prisma.imapSmtpConfig.create({
      data: {
        emailAccountId: createdEmailAccountId,
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
      },
    });

    return { emailAccountId: createdEmailAccountId, created: true };
  });
