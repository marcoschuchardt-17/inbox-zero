const SYSTEM_FLAG = "\\";

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
