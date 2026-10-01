import { describe, expect, it, vi } from "vitest";
import type { EmailProvider } from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import {
  collectImapPollMessages,
  highestImapUid,
} from "@/utils/email/imap-poll";

function message(id: string): ParsedMessage {
  return { id } as ParsedMessage;
}

describe("collectImapPollMessages", () => {
  it("keeps reading mail that arrived after the last sync when newer mail fills the page", async () => {
    const getThreadsWithQuery = vi.fn(
      async ({ pageToken }: { pageToken?: string }) => {
        if (pageToken) {
          return {
            threads: [{ messages: [message("INBOX/2")] }],
            nextPageToken: undefined,
          };
        }
        return {
          threads: [{ messages: [message("INBOX/40")] }],
          nextPageToken: "1",
        };
      },
    );
    const getMailboxSyncPage = vi.fn();
    const provider = {
      getMailboxSyncPage,
      getThreadsWithQuery,
    } as unknown as Pick<
      EmailProvider,
      "getMailboxSyncPage" | "getThreadsWithQuery"
    >;

    const messages = await collectImapPollMessages(provider, {
      after: new Date("2026-09-20T00:00:00.000Z"),
      limit: 1,
    });

    expect(messages.map((item) => item.id)).toEqual(["INBOX/40", "INBOX/2"]);
    expect(getMailboxSyncPage).not.toHaveBeenCalled();
    expect(highestImapUid(messages)).toBe(40);
  });

  it("reads older inbox mail when the mailbox has never been synced", async () => {
    const getThreadsWithQuery = vi.fn(
      async ({ pageToken }: { pageToken?: string }) => {
        if (pageToken) {
          return {
            threads: [{ messages: [message("INBOX/1")] }],
            nextPageToken: undefined,
          };
        }
        return {
          threads: [{ messages: [message("INBOX/40")] }],
          nextPageToken: "30",
        };
      },
    );
    const getMailboxSyncPage = vi.fn();
    const provider = {
      getMailboxSyncPage,
      getThreadsWithQuery,
    } as unknown as Pick<
      EmailProvider,
      "getMailboxSyncPage" | "getThreadsWithQuery"
    >;

    const messages = await collectImapPollMessages(provider, {
      after: null,
      limit: 30,
    });

    expect(messages.map((item) => item.id)).toEqual(["INBOX/40", "INBOX/1"]);
    expect(getMailboxSyncPage).not.toHaveBeenCalled();
    expect(getThreadsWithQuery).toHaveBeenCalledWith({
      query: { type: "inbox" },
      maxResults: 30,
      pageToken: undefined,
    });
  });
});

describe("highestImapUid", () => {
  it("reads the uid from a folder-qualified message id", () => {
    expect(highestImapUid([{ id: "INBOX/22" }, { id: "Sent/6" }])).toBe(22);
    expect(highestImapUid([{ id: "not-a-uid" }])).toBe(0);
  });
});
