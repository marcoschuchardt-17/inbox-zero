import { describe, expect, it } from "vitest";
import { imapRowLabelIds } from "./imap-flags";

describe("imapRowLabelIds", () => {
  it("keeps mailbox labels and drops read-state flags", () => {
    expect(
      imapRowLabelIds(["Rechnungen", "UNREAD", "STARRED", "INBOX"]),
    ).toEqual(["Rechnungen"]);
  });

  it("returns nothing when the message has no user label", () => {
    expect(imapRowLabelIds(undefined)).toEqual([]);
  });
});
