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

// The box shows what the user is typing for the query currently in the address.
// A sidebar link can clear that query, and the old draft must not stay behind.
export function imapSearchInputValue(
  committedQuery: string,
  draft: { committedQuery: string; text: string } | null,
) {
  if (draft?.committedQuery === committedQuery) return draft.text;
  return committedQuery;
}

// Once the address changes, the typed draft belongs to the previous query.
// Keeping it would put the old search back when that query returns.
export function imapSearchStateAfterQueryChange<T>(
  state: { committedQuery: string; draft: T },
  committedQuery: string,
) {
  if (state.committedQuery === committedQuery) return state;
  return { committedQuery, draft: null };
}

// The open message belongs to the list on screen. Another folder or search
// has to show that list, so a deep link stays and a view change closes it.
export function imapCloseMessageOnViewChange(
  previous: { folder: string; search: string } | null,
  next: { folder: string; search: string },
) {
  if (!previous) return false;
  return previous.folder !== next.folder || previous.search !== next.search;
}

export function imapMailboxQuery(folder: string) {
  if (folder.startsWith("mailbox:")) {
    return { type: null, folderId: folder.slice("mailbox:".length) };
  }
  if (folder === "inbox") return { type: null, folderId: null };
  return { type: folder, folderId: null };
}
