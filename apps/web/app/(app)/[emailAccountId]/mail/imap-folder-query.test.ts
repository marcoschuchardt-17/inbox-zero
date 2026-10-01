import { describe, expect, it } from "vitest";
import {
  imapListCursor,
  imapMailboxQuery,
  imapMailboxViewFromQuery,
  imapCloseMessageOnViewChange,
  imapSearchInputValue,
  imapSearchStateAfterQueryChange,
} from "./imap-folder-query";

describe("imapMailboxViewFromQuery", () => {
  it("opens the inbox when the address has no folder", () => {
    expect(imapMailboxViewFromQuery(null, null)).toBe("inbox");
    expect(imapMailboxViewFromQuery("", "  ")).toBe("inbox");
  });

  it("keeps Sent, Archive, Trash, and Drafts after a reload", () => {
    expect(imapMailboxViewFromQuery("sent", null)).toBe("sent");
    expect(imapMailboxViewFromQuery("archive", null)).toBe("archive");
    expect(imapMailboxViewFromQuery("trash", null)).toBe("trash");
    expect(imapMailboxViewFromQuery("drafts", null)).toBe("drafts");
    expect(imapMailboxViewFromQuery("draft", null)).toBe("drafts");
  });

  it("opens an extra folder from its id", () => {
    expect(imapMailboxViewFromQuery("sent", "Junk")).toBe("mailbox:Junk");
  });
});

describe("imapListCursor", () => {
  it("moves through the list and stops at the ends", () => {
    expect(imapListCursor(0, 6, 1)).toBe(1);
    expect(imapListCursor(2, 6, -1)).toBe(1);
    expect(imapListCursor(5, 6, 1)).toBe(5);
    expect(imapListCursor(0, 6, -1)).toBe(0);
  });

  it("stays put when the folder is empty", () => {
    expect(imapListCursor(0, 0, 1)).toBe(0);
    expect(imapListCursor(3, 0, -1)).toBe(0);
  });

  it("clamps a stale index after the list shrinks", () => {
    expect(imapListCursor(8, 3, 0)).toBe(2);
  });
});

describe("imapMailboxQuery", () => {
  it("leaves the inbox address without a folder", () => {
    expect(imapMailboxQuery("inbox")).toEqual({ type: null, folderId: null });
  });

  it("writes the folder that should survive a reload", () => {
    expect(imapMailboxQuery("sent")).toEqual({ type: "sent", folderId: null });
    expect(imapMailboxQuery("mailbox:Junk")).toEqual({
      type: null,
      folderId: "Junk",
    });
  });
});

describe("imapCloseMessageOnViewChange", () => {
  it("keeps a deep-linked message on the first view", () => {
    expect(
      imapCloseMessageOnViewChange(null, { folder: "archive", search: "" }),
    ).toBe(false);
    expect(
      imapCloseMessageOnViewChange(
        { folder: "inbox", search: "" },
        { folder: "inbox", search: "" },
      ),
    ).toBe(false);
  });

  it("closes the message when the folder or the search changes", () => {
    expect(
      imapCloseMessageOnViewChange(
        { folder: "archive", search: "" },
        { folder: "inbox", search: "" },
      ),
    ).toBe(true);
    expect(
      imapCloseMessageOnViewChange(
        { folder: "inbox", search: "" },
        { folder: "inbox", search: "billing" },
      ),
    ).toBe(true);
    expect(
      imapCloseMessageOnViewChange(
        { folder: "archive", search: "billing" },
        { folder: "archive", search: "" },
      ),
    ).toBe(true);
  });
});

describe("imapSearchInputValue", () => {
  it("keeps a typed draft only while the address still has that query", () => {
    expect(imapSearchInputValue("", null)).toBe("");
    expect(imapSearchInputValue("please keep", null)).toBe("please keep");
    expect(
      imapSearchInputValue("", {
        committedQuery: "",
        text: "please keep",
      }),
    ).toBe("please keep");
    expect(
      imapSearchInputValue("", {
        committedQuery: "please keep",
        text: "please keep",
      }),
    ).toBe("");
  });

  it("drops the draft once the address leaves the search", () => {
    const typed = {
      committedQuery: "",
      draft: { committedQuery: "", text: "please keep" },
    };
    const searching = imapSearchStateAfterQueryChange(typed, "please keep");
    expect(searching.draft).toBeNull();
    expect(imapSearchInputValue("please keep", searching.draft)).toBe(
      "please keep",
    );
    const inbox = imapSearchStateAfterQueryChange(searching, "");
    expect(imapSearchInputValue("", inbox.draft)).toBe("");
  });
});
