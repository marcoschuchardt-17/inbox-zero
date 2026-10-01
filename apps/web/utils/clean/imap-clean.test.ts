import { describe, expect, it, vi } from "vitest";
import { CleanAction } from "@/generated/prisma/enums";
import {
  imapCleanFetchLimit,
  loadImapCleanThreads,
  undoImapClean,
} from "@/utils/clean/imap-clean";
import type { EmailProvider, EmailThread } from "@/utils/email/types";

describe("loadImapCleanThreads", () => {
  it("reads older mail when newer mail sits outside the selected dates", async () => {
    const recent: EmailThread = {
      id: "recent-note",
      messages: [
        {
          id: "recent-note",
          threadId: "recent-note",
          date: "2026-09-28T12:00:00.000Z",
        } as EmailThread["messages"][number],
      ],
      snippet: "",
    };
    const newsletter: EmailThread = {
      id: "old-newsletter",
      messages: [
        {
          id: "old-newsletter",
          threadId: "old-newsletter",
          date: "2026-08-01T12:00:00.000Z",
        } as EmailThread["messages"][number],
      ],
      snippet: "",
    };
    const getThreadsWithQuery = vi.fn(
      async ({ pageToken }: { pageToken?: string }) => {
        if (pageToken) return { threads: [newsletter] };
        return { threads: [recent], nextPageToken: "1" };
      },
    );

    const threads = await loadImapCleanThreads({
      emailProvider: { getThreadsWithQuery } as unknown as Pick<
        EmailProvider,
        "getThreadsWithQuery"
      >,
      daysOld: 7,
      limit: 50,
      now: new Date("2026-09-29T12:00:00.000Z"),
    });

    expect(threads.map((thread) => thread.id)).toEqual(["old-newsletter"]);
    expect(getThreadsWithQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          type: "inbox",
          before: new Date("2026-09-22T12:00:00.000Z"),
        }),
      }),
    );
  });

  it("keeps reading pages when the full inbox is larger than one page", async () => {
    const first: EmailThread = {
      id: "old-one",
      messages: [
        {
          id: "old-one",
          threadId: "old-one",
          date: "2026-08-01T12:00:00.000Z",
        } as EmailThread["messages"][number],
      ],
      snippet: "",
    };
    const second: EmailThread = {
      id: "old-two",
      messages: [
        {
          id: "old-two",
          threadId: "old-two",
          date: "2026-08-02T12:00:00.000Z",
        } as EmailThread["messages"][number],
      ],
      snippet: "",
    };
    const getThreadsWithQuery = vi.fn(
      async ({ pageToken }: { pageToken?: string }) => {
        if (pageToken) return { threads: [second] };
        return { threads: [first], nextPageToken: "100" };
      },
    );

    const threads = await loadImapCleanThreads({
      emailProvider: { getThreadsWithQuery } as unknown as Pick<
        EmailProvider,
        "getThreadsWithQuery"
      >,
      daysOld: 7,
      limit: imapCleanFetchLimit(),
      now: new Date("2026-09-29T12:00:00.000Z"),
    });

    expect(imapCleanFetchLimit()).toBe(2000);
    expect(imapCleanFetchLimit(50)).toBe(50);
    expect(threads.map((thread) => thread.id)).toEqual(["old-one", "old-two"]);
    expect(getThreadsWithQuery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ maxResults: 100 }),
    );
  });
});

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
