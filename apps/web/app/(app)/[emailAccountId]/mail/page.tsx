import { MailRoute } from "@/app/(app)/[emailAccountId]/mail/MailRoute";
import { EmailProvider } from "@/providers/EmailProvider";

export const maxDuration = 180;

export default function Mail() {
  return (
    <EmailProvider>
      <MailRoute />
    </EmailProvider>
  );
}
