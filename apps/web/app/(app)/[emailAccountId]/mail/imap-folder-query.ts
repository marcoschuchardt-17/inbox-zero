// The mailbox folder has to live in the address. A reload otherwise opens
// the inbox again, and a link to Sent never arrives there.
export function imapMailboxViewFromQuery(
  type: string | null | undefined,
  folderId: string | null | undefined,
) {
  const extra = folderId?.trim();
  if (extra) return `mailbox:${extra}`;
  const kind = type?.trim().toLowerCase();
  if (kind === "sent" || kind === "archive" || kind === "trash") return kind;
  if (kind === "draft" || kind === "drafts") return "drafts";
  return "inbox";
}

export function imapMailboxQuery(folder: string) {
  if (folder.startsWith("mailbox:")) {
    return { type: null, folderId: folder.slice("mailbox:".length) };
  }
  if (folder === "inbox") return { type: null, folderId: null };
  return { type: folder, folderId: null };
}
