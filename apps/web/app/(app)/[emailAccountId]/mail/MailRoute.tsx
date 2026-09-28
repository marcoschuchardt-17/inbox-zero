"use client";

import { MailShell } from "@/app/(app)/[emailAccountId]/mail/MailShell";
import { ImapInbox } from "@/app/(app)/[emailAccountId]/mail/ImapInbox";
import { PermissionsCheck } from "@/app/(app)/[emailAccountId]/PermissionsCheck";
import { useAccount } from "@/providers/EmailAccountProvider";
import { isImapProvider } from "@/utils/email/provider-types";
import { MailEngineHost } from "@/utils/mail-engine/MailEngineHost";

export function MailRoute() {
  const { provider } = useAccount();

  if (isImapProvider(provider)) return <ImapInbox />;

  return (
    <MailEngineHost>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PermissionsCheck />
        <MailShell />
      </div>
    </MailEngineHost>
  );
}
