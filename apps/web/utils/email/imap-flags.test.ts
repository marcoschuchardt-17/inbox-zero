import { describe, expect, it } from "vitest";
import { imapRowLabelIds, imapThreadLabelIds } from "./imap-flags";

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

describe("imapThreadLabelIds", () => {
  it("keeps a label stored on an older copy in the thread", () => {
    expect(
      imapThreadLabelIds([
        { labelIds: ["Rechnungen"] },
        { labelIds: ["UNREAD"] },
      ]),
    ).toEqual(["Rechnungen"]);
  });
});
