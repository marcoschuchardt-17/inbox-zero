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

// j and k stay inside this folder. The cursor does not wrap.
export function imapListCursor(index: number, count: number, delta: number) {
  if (count <= 0) return 0;
  const current = Number.isInteger(index) ? index : 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next > count - 1) return count - 1;
  return next;
}

export function imapMailboxQuery(folder: string) {
  if (folder.startsWith("mailbox:")) {
    return { type: null, folderId: folder.slice("mailbox:".length) };
  }
  if (folder === "inbox") return { type: null, folderId: null };
  return { type: folder, folderId: null };
}
