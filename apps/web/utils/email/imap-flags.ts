import { specialUse } from "imapflow/lib/special-use";

const SYSTEM_FLAG = "\\";
const ROW_SYSTEM_LABELS = new Set([
  "UNREAD",
  "STARRED",
  "INBOX",
  "SENT",
  "DRAFT",
  "TRASH",
  "SPAM",
  "ARCHIVE",
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

export function imapVisibleThreadLabelIds(
  messages: readonly { labelIds?: readonly string[] | null }[],
  knownIds: ReadonlySet<string>,
) {
  return imapThreadLabelIds(messages).filter((labelId) =>
    knownIds.has(labelId),
  );
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

const LIST_LOCATION_BY_FLAG: Record<
  string,
  "sent" | "drafts" | "trash" | "archive" | "junk"
> = {
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Archive": "archive",
  "\\Junk": "junk",
};

export function imapListLocation(mailbox: string) {
  const trimmed = mailbox.trim();
  const name = trimmed.toLowerCase();
  const leaf = trimmed.split("/").at(-1) || trimmed;
  if (name === "inbox" || leaf.toLowerCase() === "inbox") return "inbox";
  const flag = specialUse(false, { flags: new Set<string>(), name: leaf }).flag;
  return (flag && LIST_LOCATION_BY_FLAG[flag]) || "folder";
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

export function imapListRows<
  T extends { id: string; messages: readonly { id: string }[] },
>(threads: readonly T[]) {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const thread of threads) {
    // Two different messages can share a conversation id. The row key has to
    // be the copy on screen, or React drops one of them.
    const key = imapListMessage(thread.messages)?.id || thread.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(thread);
  }
  return rows;
}

type ImapFilingRole = "archive" | "trash" | "junk";

const FILED_LABEL: Record<ImapFilingRole, string> = {
  archive: "ARCHIVE",
  trash: "TRASH",
  junk: "SPAM",
};

export function imapThreadNeedsMove(
  messages: readonly { id: string; labelIds?: readonly string[] | null }[],
  role: ImapFilingRole,
) {
  const inbox = messages.filter((message) => messageIsInboxCopy(message));
  const targets = inbox.length
    ? inbox
    : messages.filter((message) => {
        const labels = message.labelIds ?? [];
        return !labels.includes("SENT") && !labels.includes("DRAFT");
      });
  return targets.some((message) => !messageIsFiled(message, role));
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

function messageIsInboxCopy(message: {
  id: string;
  labelIds?: readonly string[] | null;
}) {
  return (
    message.labelIds?.includes("INBOX") ||
    imapListLocation(imapMessageMailbox(message.id)) === "inbox"
  );
}

function messageIsFiled(
  message: { id: string; labelIds?: readonly string[] | null },
  role: ImapFilingRole,
) {
  if (message.labelIds?.includes(FILED_LABEL[role])) return true;
  const location = imapListLocation(imapMessageMailbox(message.id));
  if (role === "junk") return location === "junk";
  return location === role;
}
