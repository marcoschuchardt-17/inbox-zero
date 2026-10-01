export const IMAP_CONNECTION_ERROR =
  "IMAP connection failed. Check host, port, TLS, and credentials.";

const MAILBOX_SETTINGS_ERRORS = new Set([
  IMAP_CONNECTION_ERROR,
  "IMAP mailbox not found",
  "Failed to read IMAP mailbox",
]);

export function imapConnectionErrorMessage(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const info = "info" in error ? error.info : undefined;
  const infoMessage =
    info &&
    typeof info === "object" &&
    "error" in info &&
    typeof info.error === "string"
      ? info.error
      : null;
  const message =
    infoMessage ||
    ("message" in error && typeof error.message === "string"
      ? error.message
      : null);
  return message && MAILBOX_SETTINGS_ERRORS.has(message) ? message : null;
}
