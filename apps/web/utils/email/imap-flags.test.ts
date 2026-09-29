import { describe, expect, it } from "vitest";
import {
  imapListLocation,
  imapListMessage,
  imapMessageIsStarred,
  imapMessageIsUnread,
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

describe("imapMessageIsUnread", () => {
  it("treats an archived message as unread when it has not been seen", () => {
    expect(imapMessageIsUnread(["UNREAD"])).toBe(true);
  });

  it("leaves a seen message unmarked", () => {
    expect(imapMessageIsUnread(["INBOX"])).toBe(false);
    expect(imapMessageIsUnread(undefined)).toBe(false);
  });
});

describe("imapMessageIsStarred", () => {
  it("treats a flagged message as starred", () => {
    expect(imapMessageIsStarred(["INBOX", "STARRED"])).toBe(true);
  });

  it("leaves an unflagged message unmarked", () => {
    expect(imapMessageIsStarred(["INBOX", "UNREAD"])).toBe(false);
    expect(imapMessageIsStarred(undefined)).toBe(false);
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

describe("imapListMessage", () => {
  it("shows the incoming copy when a sent reply is newer", () => {
    expect(imapListMessage([{ id: "INBOX/22" }, { id: "Sent/9" }])?.id).toBe(
      "INBOX/22",
    );
    expect(imapListMessage([{ id: "Receipts/4" }, { id: "Sent/4" }])?.id).toBe(
      "Receipts/4",
    );
  });

  it("keeps a sent message when that is the only copy", () => {
    expect(imapListMessage([{ id: "Sent/9" }])?.id).toBe("Sent/9");
    expect(imapListMessage([{ id: "Archive/10" }])?.id).toBe("Archive/10");
    expect(imapListMessage([])).toBeUndefined();
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
