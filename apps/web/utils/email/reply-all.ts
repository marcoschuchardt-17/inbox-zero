import type { ParsedMessageHeaders } from "@/utils/types";
import {
  extractEmailAddress,
  extractEmailAddresses,
  splitRecipientList,
} from "@/utils/email";

export interface ReplyAllRecipients {
  cc: string[];
  to: string;
}

/**
 * Builds reply-all recipients by including original TO and CC recipients.
 * The reply goes to the original sender, and CC includes all other recipients.
 *
 * @param headers - Original email headers
 * @param overrideTo - Optional override for the TO field (e.g., for drafts)
 * @param currentUserEmails - Current user's email addresses to exclude from CC
 * @returns Object with TO and CC recipients for reply-all
 */
export function buildReplyAllRecipients(
  headers: ParsedMessageHeaders,
  overrideTo: string | undefined,
  currentUserEmails: string | string[],
): ReplyAllRecipients {
  // Determine the primary recipient (TO field)
  const replyToRaw = overrideTo || headers["reply-to"] || headers.from;
  const replyTargets = new Set(
    extractEmailAddresses(replyToRaw).map((email) => email.toLowerCase()),
  );

  const currentUserEmailSet = new Set(
    (Array.isArray(currentUserEmails) ? currentUserEmails : [currentUserEmails])
      .map((email) => extractEmailAddress(email).toLowerCase())
      .filter(Boolean),
  );

  // Build CC list for reply-all behavior
  const ccSet = new Set<string>();
  const seenEmails = new Set<string>();

  addHeaderRecipientsToCcSet({
    headerValue: headers.cc,
    replyTargets,
    currentUserEmailSet,
    seenEmails,
    ccSet,
  });
  addHeaderRecipientsToCcSet({
    headerValue: headers.to,
    replyTargets,
    currentUserEmailSet,
    seenEmails,
    ccSet,
  });

  return {
    // A reply the user already addressed keeps that To line. Otherwise the
    // account is already reading the message, so reply-to skips it.
    to: overrideTo
      ? replyToRaw
      : replyTargetWithoutAccount(replyToRaw, currentUserEmailSet),
    cc: Array.from(ccSet),
  };
}

/**
 * Converts array of CC recipients to a comma-separated string.
 * Returns undefined if the array is empty.
 */
export function formatCcList(ccList: string[]): string | undefined {
  return ccList.length > 0 ? ccList.join(", ") : undefined;
}

/**
 * Merges manual CC/BCC recipients with existing recipients,
 * ensuring deduplication and sanitization.
 */
export function mergeAndDedupeRecipients(
  existing: string[],
  manual: string | undefined,
): string[] {
  const result = [...existing];
  const seen = new Set(
    existing.map((e) => extractEmailAddress(e).toLowerCase()),
  );

  if (manual) {
    const manualEntries = splitRecipientList(manual);

    for (const entry of manualEntries) {
      const email = extractEmailAddress(entry);
      if (email) {
        const key = email.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          result.push(entry);
        }
      }
    }
  }

  return result;
}

function replyTargetWithoutAccount(
  replyToRaw: string,
  currentUserEmailSet: Set<string>,
) {
  const people = splitRecipientList(replyToRaw);
  const others = people.filter((person) => {
    const email = extractEmailAddress(person).toLowerCase();
    return Boolean(email) && !currentUserEmailSet.has(email);
  });
  // A reply-to that only names this account still has somewhere to go.
  if (!others.length || others.length === people.length) return replyToRaw;
  return others.join(", ");
}

function addHeaderRecipientsToCcSet({
  headerValue,
  replyTargets,
  currentUserEmailSet,
  seenEmails,
  ccSet,
}: {
  headerValue: string | undefined;
  replyTargets: Set<string>;
  currentUserEmailSet: Set<string>;
  seenEmails: Set<string>;
  ccSet: Set<string>;
}) {
  if (!headerValue) return;

  for (const entry of splitRecipientList(headerValue)) {
    const email = extractEmailAddress(entry);
    if (!email) continue;

    const normalizedEmail = email.toLowerCase();
    if (
      replyTargets.has(normalizedEmail) ||
      currentUserEmailSet.has(normalizedEmail) ||
      seenEmails.has(normalizedEmail)
    ) {
      continue;
    }

    seenEmails.add(normalizedEmail);
    ccSet.add(entry);
  }
}
