export function statsLoadHasMore(
  loadBefore: boolean,
  result: { hasMoreAfter: boolean; hasMoreBefore: boolean } | undefined,
) {
  if (!result) return false;
  if (loadBefore) return result.hasMoreAfter || result.hasMoreBefore;
  return result.hasMoreAfter;
}
