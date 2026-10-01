import { extractEmailAddress, splitRecipientList } from "@/utils/email";

export function isWhitelistedSender(
  from: string,
  whitelist: string | undefined,
) {
  const people = splitRecipientList(from);
  const sources = people.length > 1 ? people : [from];
  return sources.some((person) => addressIsWhitelisted(person, whitelist));
}

// Application exemptions are mailbox-specific; domain terms are only for the Gmail filter.
function addressIsWhitelisted(from: string, whitelist: string | undefined) {
  const address = extractEmailAddress(from).toLowerCase();
  if (!address) return false;

  return (
    whitelist?.split(/\s+OR\s+/i).some((entry) => {
      const whitelistedAddress = extractEmailAddress(entry).toLowerCase();
      return address === whitelistedAddress;
    }) ?? false
  );
}
