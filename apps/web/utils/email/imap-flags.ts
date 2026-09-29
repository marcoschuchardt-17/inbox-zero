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
