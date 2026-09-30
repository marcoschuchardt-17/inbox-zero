import { describe, expect, it } from "vitest";
import { imapConnectionErrorMessage } from "./imap-connection-error";

describe("imapConnectionErrorMessage", () => {
  it("sends mailbox setup failures to the saved settings", () => {
    expect(
      imapConnectionErrorMessage({
        message: "Failed to fetch threads",
        info: {
          error:
            "IMAP connection failed. Check host, port, TLS, and credentials.",
          isKnownError: true,
        },
      }),
    ).toBe("IMAP connection failed. Check host, port, TLS, and credentials.");
    expect(
      imapConnectionErrorMessage({
        info: { error: "IMAP mailbox not found", isKnownError: true },
      }),
    ).toBe("IMAP mailbox not found");
    expect(
      imapConnectionErrorMessage({
        message: "Failed to read IMAP mailbox",
      }),
    ).toBe("Failed to read IMAP mailbox");
    expect(
      imapConnectionErrorMessage({ message: "Failed to fetch threads" }),
    ).toBeNull();
    expect(imapConnectionErrorMessage(null)).toBeNull();
  });
});
