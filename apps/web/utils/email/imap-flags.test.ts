import { describe, expect, it } from "vitest";
import {
  imapListLocation,
  imapListMessage,
  imapListRows,
  imapMessageIsStarred,
  imapMessageIsUnread,
  imapThreadIsStarred,
  imapThreadIsUnread,
  imapMessageMailbox,
  imapRowLabelIds,
  imapFilingCommandVisible,
  imapSearchRestoreAction,
  imapSenderMark,
  imapThreadLabelIds,
  imapThreadNeedsMove,
  imapVisibleThreadLabelIds,
} from "./imap-flags";

describe("imapRowLabelIds", () => {
  it("keeps mailbox labels and drops read-state flags", () => {
    expect(
      imapRowLabelIds(["Rechnungen", "UNREAD", "STARRED", "INBOX"]),
    ).toEqual(["Rechnungen"]);
  });

  it("drops the archive folder mark and keeps a label the user added", () => {
    expect(imapRowLabelIds(["ARCHIVE", "FYI", "UNREAD"])).toEqual(["FYI"]);
    expect(imapThreadLabelIds([{ labelIds: ["ARCHIVE", "FYI"] }])).toEqual([
      "FYI",
    ]);
  });

  it("returns nothing when the message has no user label", () => {
    expect(imapRowLabelIds(undefined)).toEqual([]);
  });

  it("hides a keyword after that label is gone", () => {
    expect(
      imapVisibleThreadLabelIds(
        [{ labelIds: ["Desk_tag", "FYI"] }],
        new Set(["FYI"]),
      ),
    ).toEqual(["FYI"]);
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

describe("imapThreadIsUnread", () => {
  it("marks the thread unread when an older copy has not been seen", () => {
    expect(
      imapThreadIsUnread([{ labelIds: ["UNREAD"] }, { labelIds: ["FYI"] }]),
    ).toBe(true);
  });

  it("leaves the thread read when every copy has been seen", () => {
    expect(imapThreadIsUnread([{ labelIds: ["FYI"] }])).toBe(false);
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

describe("imapThreadIsStarred", () => {
  it("marks the thread starred when an older copy is flagged", () => {
    expect(
      imapThreadIsStarred([{ labelIds: ["STARRED"] }, { labelIds: ["INBOX"] }]),
    ).toBe(true);
  });

  it("leaves the thread unstarred when no copy is flagged", () => {
    expect(imapThreadIsStarred([{ labelIds: ["UNREAD"] }])).toBe(false);
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

  it("recognizes the mailbox names a server already uses", () => {
    expect(imapListLocation("Gesendet")).toBe("sent");
    expect(imapListLocation("Entwürfe")).toBe("drafts");
    expect(imapListLocation("Archiv")).toBe("archive");
    expect(imapSearchRestoreAction("Archiv/3")).toBe("unarchive");
    expect(imapListLocation("Papierkorb")).toBe("trash");
    expect(imapSearchRestoreAction("Papierkorb/1")).toBe("untrash");
    expect(imapListLocation("Sent to clients")).toBe("folder");
    expect(imapListLocation("Receipts")).toBe("folder");
  });

  it("ignores an id that is not a mailbox uid", () => {
    expect(imapMessageMailbox("")).toBe("");
    expect(imapMessageMailbox("not-an-id")).toBe("");
    expect(imapSearchRestoreAction(undefined)).toBeNull();
  });
});

describe("imapSenderMark", () => {
  it("keeps a space before the folder and the read state", () => {
    expect(`Sam${imapSenderMark("Sent")}`).toBe("Sam Sent");
    expect(`Ads${imapSenderMark("Unread")}`).toBe("Ads Unread");
    expect(`Sam${imapSenderMark("Starred")}`).toBe("Sam Starred");
  });
});

describe("imapListMessage", () => {
  it("shows the incoming copy when a sent reply is newer", () => {
    expect(imapListMessage([{ id: "INBOX/22" }, { id: "Sent/9" }])?.id).toBe(
      "INBOX/22",
    );
    expect(
      imapListMessage([{ id: "INBOX/22" }, { id: "Gesendet/9" }])?.id,
    ).toBe("INBOX/22");
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

describe("imapListRows", () => {
  it("keeps two messages that share a conversation id", () => {
    const rows = imapListRows([
      {
        id: "<rechnung-2026-09@example.com>",
        messages: [{ id: "Archive/7" }],
      },
      {
        id: "<rechnung-2026-09@example.com>",
        messages: [{ id: "Archive/3" }],
      },
    ]);

    expect(rows.map((row) => row.messages[0]?.id)).toEqual([
      "Archive/7",
      "Archive/3",
    ]);
  });

  it("drops a second copy of the same message", () => {
    const rows = imapListRows([
      { id: "<same@example.com>", messages: [{ id: "Archive/7" }] },
      { id: "<same@example.com>", messages: [{ id: "Archive/7" }] },
    ]);

    expect(rows).toHaveLength(1);
  });
});

describe("imapThreadNeedsMove", () => {
  it("leaves an archived message where it is", () => {
    expect(
      imapThreadNeedsMove(
        [{ id: "Archive/10", labelIds: ["ARCHIVE"] }],
        "archive",
      ),
    ).toBe(false);
    expect(
      imapThreadNeedsMove(
        [{ id: "Archiv/3", labelIds: ["ARCHIVE"] }],
        "archive",
      ),
    ).toBe(false);
  });

  it("still archives a copy that is in the inbox", () => {
    expect(
      imapThreadNeedsMove(
        [
          { id: "INBOX/4", labelIds: ["INBOX"] },
          { id: "Archive/4", labelIds: ["ARCHIVE"] },
        ],
        "archive",
      ),
    ).toBe(true);
  });

  it("offers archive only while a copy is still outside the archive", () => {
    expect(
      imapFilingCommandVisible(
        [{ id: "Sent/3", labelIds: ["SENT"] }],
        "archive",
      ),
    ).toBe(false);
    expect(imapFilingCommandVisible(undefined, "archive")).toBe(false);
    expect(
      imapFilingCommandVisible(
        [{ id: "INBOX/22", labelIds: ["INBOX", "UNREAD"] }],
        "archive",
      ),
    ).toBe(true);
  });

  it("leaves mail that is already in Trash or Junk", () => {
    expect(
      imapThreadNeedsMove([{ id: "Trash/1", labelIds: ["TRASH"] }], "trash"),
    ).toBe(false);
    expect(
      imapThreadNeedsMove([{ id: "Junk/2", labelIds: ["SPAM"] }], "junk"),
    ).toBe(false);
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
