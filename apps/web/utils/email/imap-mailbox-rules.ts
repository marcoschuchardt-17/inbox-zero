import { ActionType } from "@/generated/prisma/enums";
import { matchesStaticRule } from "@/utils/ai/choose-rule/match-rules";
import { imapKeyword } from "@/utils/email/imap-flags";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { ParsedMessage } from "@/utils/types";

const MAILBOX_RULES: Array<{
  name: string;
  label: string;
  subject?: string;
  from?: string;
}> = [
  { name: "Rechnungen", label: "Rechnungen", subject: "Rechnung" },
  { name: "Invoices", label: "Rechnungen", subject: "Invoice" },
  { name: "Kontoauszüge", label: "Kontoauszug", subject: "Kontoauszug" },
  { name: "Verträge", label: "Vertrag", subject: "Vertrag" },
  { name: "Versicherungen", label: "Versicherung", subject: "Versicherung" },
  { name: "Steuer", label: "Steuer", subject: "Steuer" },
  { name: "Finanzamt", label: "Steuer", subject: "Finanzamt" },
  { name: "PayPal", label: "PayPal", from: "paypal.com" },
];

export async function ensureImapMailboxRules(emailAccountId: string) {
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      userId: true,
      user: { select: { completedOnboardingAt: true } },
    },
  });
  if (account && !account.user.completedOnboardingAt) {
    await prisma.user.update({
      where: { id: account.userId },
      data: { completedOnboardingAt: new Date() },
    });
  }

  for (const definition of MAILBOX_RULES) {
    const keyword = imapKeyword(definition.label);
    await prisma.label.upsert({
      where: {
        name_emailAccountId: {
          name: definition.label,
          emailAccountId,
        },
      },
      create: {
        name: definition.label,
        gmailLabelId: keyword,
        emailAccountId,
        enabled: true,
      },
      update: { enabled: true, gmailLabelId: keyword },
    });

    const existing = await prisma.rule.findUnique({
      where: {
        name_emailAccountId: { name: definition.name, emailAccountId },
      },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.rule.create({
      data: {
        name: definition.name,
        emailAccountId,
        enabled: true,
        subject: definition.subject,
        from: definition.from,
        actions: {
          create: {
            type: ActionType.LABEL,
            label: definition.label,
            labelId: keyword,
            emailAccountId,
          },
        },
      },
    });
  }
}

export async function labelImapMessagesWithStaticRules({
  emailAccountId,
  messages,
  provider,
  logger,
}: {
  emailAccountId: string;
  messages: ParsedMessage[];
  provider: EmailProvider;
  logger: Logger;
}) {
  const rules = await prisma.rule.findMany({
    where: {
      emailAccountId,
      enabled: true,
      actions: { some: { type: ActionType.LABEL } },
    },
    select: {
      from: true,
      to: true,
      subject: true,
      body: true,
      actions: {
        where: { type: ActionType.LABEL },
        select: { label: true, labelId: true },
      },
    },
  });

  let labeled = 0;
  for (const message of messages) {
    for (const rule of rules) {
      if (!matchesLoweredStaticRule(rule, message, logger)) continue;
      const action = rule.actions.find((item) => item.label || item.labelId);
      const labelName = action?.label || action?.labelId;
      if (!labelName) continue;
      const keyword = imapKeyword(action?.labelId || labelName);
      if (message.labelIds?.includes(keyword)) continue;
      try {
        await provider.labelMessage({
          messageId: message.id,
          labelId: keyword,
          labelName,
        });
        message.labelIds = [...(message.labelIds || []), keyword];
        labeled += 1;
      } catch (error) {
        logger.error("Skipped IMAP label", {
          error,
          rule: rule.subject || rule.from,
          emailAccountId,
        });
      }
    }
  }
  return labeled;
}

function matchesLoweredStaticRule(
  rule: { from: string | null; to: string | null; subject: string | null; body: string | null },
  message: ParsedMessage,
  logger: Logger,
) {
  return matchesStaticRule(
    {
      from: rule.from,
      to: rule.to,
      subject: rule.subject?.toLowerCase() ?? null,
      body: rule.body?.toLowerCase() ?? null,
    },
    {
      ...message,
      headers: {
        ...message.headers,
        subject: message.headers.subject.toLowerCase(),
      },
      textPlain: message.textPlain?.toLowerCase(),
    },
    logger,
  );
}
