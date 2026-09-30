import {
  canonicalizeEmailAddress,
  extractEmailAddress,
  extractNameFromEmail,
  splitRecipientList,
} from "@/utils/email";
import { GmailLabel } from "@/utils/gmail/label";
import type { ParsedMessageHeaders } from "@/utils/types";

type ParticipantMessage = {
  headers: Pick<ParsedMessageHeaders, "from" | "to" | "cc" | "bcc">;
  labelIds?: string[] | null;
};

export function initialsForSenderList(value: string) {
  const people = value
    .split(",")
    .map((person) => person.trim())
    .filter(Boolean);
  if (people.length < 2) return null;
  return people
    .slice(0, 2)
    .map((person) => person[0]?.toUpperCase() ?? "")
    .join("");
}

export function getMessageSenderProfile(from: string) {
  const people = splitRecipientList(from);
  const senderName = people
    .map(
      (person) => extractNameFromEmail(person) || extractEmailAddress(person),
    )
    .filter(Boolean)
    .join(", ");
  const senderEmail = people
    .map((person) => extractEmailAddress(person))
    .filter(Boolean)
    .join(", ");
  return { senderName, senderEmail };
}

export function getThreadParticipantNames(
  messages: ParticipantMessage[],
  userEmail: string,
) {
  const normalizedUserEmail = canonicalizeEmailAddress(userEmail);
  const senders = new Map<string, string>();
  const nonDraftMessages = messages.filter(
    (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
  );

  for (const message of nonDraftMessages) {
    for (const sender of splitRecipientList(message.headers.from)) {
      addParticipant(senders, sender, normalizedUserEmail);
    }
  }

  const hasOnlyAccountOwnerAsSender =
    senders.size === 1 && senders.has(normalizedUserEmail);
  if (senders.size > 0 && !hasOnlyAccountOwnerAsSender) {
    return [...senders.values()];
  }

  const recipients = new Map<string, string>();
  const recipientMessages = senders.size > 0 ? nonDraftMessages : messages;
  addRecipients(recipients, recipientMessages, normalizedUserEmail, ["to"]);
  // An outgoing-only thread should name the other side, not "me".
  recipients.delete(normalizedUserEmail);
  if (!recipients.size) {
    addRecipients(recipients, recipientMessages, normalizedUserEmail, [
      "cc",
      "bcc",
    ]);
    recipients.delete(normalizedUserEmail);
  }

  return recipients.size ? [...recipients.values()] : [...senders.values()];
}

function addRecipients(
  recipients: Map<string, string>,
  messages: ParticipantMessage[],
  normalizedUserEmail: string,
  fields: ("to" | "cc" | "bcc")[],
) {
  for (const message of messages) {
    for (const field of fields) {
      for (const recipient of splitRecipientList(
        message.headers[field] || "",
      )) {
        addParticipant(recipients, recipient, normalizedUserEmail);
      }
    }
  }
}

function addParticipant(
  participants: Map<string, string>,
  header: string,
  normalizedUserEmail: string,
) {
  const email = canonicalizeEmailAddress(header);
  const key = email || header.trim().toLowerCase();
  if (!key || participants.has(key)) return;

  const name =
    email && email === normalizedUserEmail
      ? "me"
      : extractNameFromEmail(header) || email;
  if (name) participants.set(key, name);
}
