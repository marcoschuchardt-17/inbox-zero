import { describe, expect, it, vi } from "vitest";
import { CleanAction } from "@/generated/prisma/enums";
import { undoImapClean } from "@/utils/clean/imap-clean";
import type { EmailProvider } from "@/utils/email/types";

describe("undoImapClean", () => {
  it("moves an archived newsletter back to the inbox", async () => {
    const unarchiveThread = vi.fn();
    const markReadThread = vi.fn();

    await undoImapClean({
      action: CleanAction.ARCHIVE,
      threadId: "<weekly-newsletter@example.com>",
      emailProvider: {
        unarchiveThread,
        markReadThread,
      } as unknown as EmailProvider,
    });

    expect(unarchiveThread).toHaveBeenCalledWith(
      "<weekly-newsletter@example.com>",
    );
    expect(markReadThread).not.toHaveBeenCalled();
  });

  it("marks a read newsletter unread", async () => {
    const unarchiveThread = vi.fn();
    const markReadThread = vi.fn();

    await undoImapClean({
      action: CleanAction.MARK_READ,
      threadId: "<weekly-newsletter@example.com>",
      emailProvider: {
        unarchiveThread,
        markReadThread,
      } as unknown as EmailProvider,
    });

    expect(markReadThread).toHaveBeenCalledWith(
      "<weekly-newsletter@example.com>",
      false,
    );
    expect(unarchiveThread).not.toHaveBeenCalled();
  });
});
