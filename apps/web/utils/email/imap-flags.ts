const SYSTEM_FLAG = "\\";
const ROW_SYSTEM_LABELS = new Set([
  "UNREAD",
  "STARRED",
  "INBOX",
  "SENT",
  "DRAFT",
  "TRASH",
  "SPAM",
  "IMPORTANT",
]);

export function imapRowLabelIds(
  labelIds: readonly string[] | null | undefined,
) {
  return (labelIds ?? []).filter(
    (labelId) =>
      !ROW_SYSTEM_LABELS.has(labelId) && !labelId.startsWith("CATEGORY_"),
  );
}

export function imapThreadLabelIds(
  messages: readonly { labelIds?: readonly string[] | null }[],
) {
  return [
    ...new Set(
      imapRowLabelIds(messages.flatMap((message) => message.labelIds ?? [])),
    ),
  ];
}

export function imapFlagsToLabelIds(flags: Iterable<string>): string[] {
  const flagSet = new Set(flags);
  const labels = [...flagSet].filter((flag) => !flag.startsWith(SYSTEM_FLAG));
  if (!flagSet.has("\\Seen")) labels.push("UNREAD");
  if (flagSet.has("\\Flagged")) labels.push("STARRED");
  return labels;
}

export function imapMessageIsUnread(
  labelIds: readonly string[] | null | undefined,
) {
  return labelIds?.includes("UNREAD") ?? false;
}

export function imapThreadIsUnread(
  messages: readonly { labelIds?: readonly string[] | null }[],
) {
  return messages.some((message) => imapMessageIsUnread(message.labelIds));
}

export function imapMessageIsStarred(
  labelIds: readonly string[] | null | undefined,
) {
  return labelIds?.includes("STARRED") ?? false;
}

export function imapThreadIsStarred(
  messages: readonly { labelIds?: readonly string[] | null }[],
) {
  return messages.some((message) => imapMessageIsStarred(message.labelIds));
}

export function imapMessageMailbox(messageId: string | null | undefined) {
  if (!messageId) return "";
  const slash = messageId.lastIndexOf("/");
  if (slash <= 0) return "";
  const uid = messageId.slice(slash + 1);
  if (!/^\d+$/.test(uid)) return "";
  return messageId.slice(0, slash);
}

export function imapListLocation(mailbox: string) {
  const name = mailbox.trim().toLowerCase();
  const leaf = name.split("/").at(-1) || name;
  if (name === "inbox" || leaf === "inbox") return "inbox";
  if (
    name === "sent" ||
    leaf === "sent" ||
    name === "sent items" ||
    leaf === "sent items" ||
    name === "[gmail]/sent mail"
  ) {
    return "sent";
  }
  if (name === "drafts" || leaf === "drafts" || leaf === "draft") {
    return "drafts";
  }
  if (name === "archive" || leaf === "archive") return "archive";
  if (
    name === "trash" ||
    leaf === "trash" ||
    leaf === "deleted" ||
    leaf === "deleted items"
  ) {
    return "trash";
  }
  if (
    name === "junk" ||
    leaf === "junk" ||
    leaf === "spam" ||
    leaf === "junk e-mail"
  ) {
    return "junk";
  }
  return "folder";
}

export function imapListMessage<T extends { id: string }>(
  messages: readonly T[],
) {
  const incoming = [...messages]
    .reverse()
    .find(
      (message) => imapListLocation(imapMessageMailbox(message.id)) !== "sent",
    );
  return incoming ?? messages.at(-1);
}

export function imapSearchRestoreAction(messageId: string | null | undefined) {
  const mailbox = imapMessageMailbox(messageId);
  if (!mailbox) return null;
  const location = imapListLocation(mailbox);
  if (location === "archive") return "unarchive";
  if (location === "trash") return "untrash";
  if (location === "junk" || location === "folder") return "restore-folder";
  return null;
}

export function imapKeyword(name: string): string {
  const keyword = name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
  if (!keyword || keyword.startsWith(SYSTEM_FLAG) || keyword.length > 64) {
    throw new Error("Invalid IMAP label");
  }
  return keyword;
}
