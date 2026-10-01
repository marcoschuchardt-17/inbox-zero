import { describe, expect, it } from "vitest";
import {
  imapMailboxQuery,
  imapMailboxViewFromQuery,
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
