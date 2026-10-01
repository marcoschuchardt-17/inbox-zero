import { internalDateToDate } from "@/utils/date";
import { isImapProvider } from "@/utils/email/provider-types";

type DatedListMessage = {
  internalDate?: string | null;
  headers?: { date?: string | null };
};

// The mailbox list shows the date written on IMAP mail. Arrival time can be
// the next day when a message is filed later with an older Date header.
export function emailListItemDate(
  message: DatedListMessage | null | undefined,
  provider: string,
  options?: { fallbackToNow?: boolean },
) {
  if (isImapProvider(provider)) {
    const header = message?.headers?.date;
    if (header) {
      const shown = new Date(header);
      if (!Number.isNaN(shown.getTime())) return shown;
    }
  }
  return internalDateToDate(message?.internalDate, options);
}
