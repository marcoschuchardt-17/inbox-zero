const FORWARDED_QUOTE_START =
  /^-{2,}\s*forwarded message\b|^begin forwarded message\b/i;

export function textStartsWithForwardedMessage(text: string) {
  const head = text.replace(/\s+/g, " ").trim().slice(0, 120);
  return FORWARDED_QUOTE_START.test(head);
}
