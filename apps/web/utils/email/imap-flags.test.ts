import { describe, expect, it } from "vitest";
import {
  imapListLocation,
  imapMessageMailbox,
  imapRowLabelIds,
  imapSearchRestoreAction,
  imapThreadLabelIds,
} from "./imap-flags";

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

describe("imap message mailbox", () => {
  it("reads the folder from an archived message id", () => {
    expect(imapMessageMailbox("Archive/10")).toBe("Archive");
    expect(imapListLocation("Archive")).toBe("archive");
    expect(imapSearchRestoreAction("Archive/10")).toBe("unarchive");
  });

  it("treats an inbox id as inbox mail with no restore", () => {
    expect(imapMessageMailbox("INBOX/22")).toBe("INBOX");
    expect(imapListLocation("INBOX")).toBe("inbox");
    expect(imapSearchRestoreAction("INBOX/22")).toBeNull();
  });

  it("restores mail filed in another folder or in trash", () => {
    expect(imapSearchRestoreAction("Receipts/2")).toBe("restore-folder");
    expect(imapListLocation("Junk")).toBe("junk");
    expect(imapSearchRestoreAction("Junk/3")).toBe("restore-folder");
    expect(imapSearchRestoreAction("Trash/1")).toBe("untrash");
    expect(imapListLocation("Drafts")).toBe("drafts");
    expect(imapListLocation("Sent")).toBe("sent");
  });

  it("ignores an id that is not a mailbox uid", () => {
    expect(imapMessageMailbox("")).toBe("");
    expect(imapMessageMailbox("not-an-id")).toBe("");
    expect(imapSearchRestoreAction(undefined)).toBeNull();
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
