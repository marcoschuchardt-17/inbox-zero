import type { ImapAccountFormDefaults } from "@/app/(app)/accounts/imap/ImapAccountForm";

export function imapAccountFormDefaults(input: {
  emailAccountId: string;
  email: string;
  name: string | null;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUsername: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  syncFolder: string;
}): ImapAccountFormDefaults {
  return {
    emailAccountId: input.emailAccountId,
    email: input.email,
    name: input.name ?? "",
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecure: input.imapSecure,
    imapUsername: input.imapUsername,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    smtpUsername: input.smtpUsername,
    syncFolder: input.syncFolder,
  };
}
