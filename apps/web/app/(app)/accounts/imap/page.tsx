import { auth } from "@/utils/auth";
import prisma from "@/utils/prisma";
import {
  ImapAccountForm,
  type ImapAccountFormDefaults,
} from "@/app/(app)/accounts/imap/ImapAccountForm";

export default async function AddImapAccountPage(props: {
  searchParams: Promise<{ emailAccountId?: string | string[] }>;
}) {
  const searchParams = await props.searchParams;
  const emailAccountId = firstParam(searchParams.emailAccountId);
  const defaults = emailAccountId
    ? await loadImapAccountDefaults(emailAccountId)
    : null;

  return <ImapAccountForm defaults={defaults} />;
}

async function loadImapAccountDefaults(
  emailAccountId: string,
): Promise<ImapAccountFormDefaults | null> {
  const session = await auth();
  const userId = session?.user.id;
  if (!userId) return null;

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId, userId },
    select: {
      email: true,
      name: true,
      account: { select: { provider: true } },
      imapSmtpConfig: {
        select: {
          imapHost: true,
          imapPort: true,
          imapSecure: true,
          imapUsername: true,
          smtpHost: true,
          smtpPort: true,
          smtpSecure: true,
          smtpUsername: true,
          syncFolder: true,
        },
      },
    },
  });

  if (
    emailAccount?.account.provider !== "imap" ||
    !emailAccount.imapSmtpConfig
  ) {
    return null;
  }

  return {
    emailAccountId,
    email: emailAccount.email,
    name: emailAccount.name ?? "",
    ...emailAccount.imapSmtpConfig,
  };
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
