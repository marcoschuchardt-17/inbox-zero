import { describe, expect, it } from "vitest";
import type { EmailProvider } from "@/utils/email/types";
import { getUnhandledCount } from "@/utils/assess";

describe("getUnhandledCount", () => {
  it("counts an IMAP inbox from mailbox stats when system labels are absent", async () => {
    const result = await getUnhandledCount(
      provider({
        toJSON: () => ({ name: "imap", type: "imap" }),
        getInboxStats: async () => ({ total: 4, unread: 2 }),
      }),
    );

    expect(result).toEqual({ unhandledCount: 2, type: "unread" });
  });

  it("treats an IMAP inbox as fully unhandled when every message is unread", async () => {
    const result = await getUnhandledCount(
      provider({
        toJSON: () => ({ name: "imap", type: "imap" }),
        getInboxStats: async () => ({ total: 3, unread: 3 }),
      }),
    );

    expect(result).toEqual({ unhandledCount: 3, type: "inbox" });
  });

  it("keeps Outlook counts on label totals", async () => {
    const result = await getUnhandledCount(
      provider({
        toJSON: () => ({ name: "microsoft", type: "microsoft" }),
        getLabelById: async (id: string) =>
          id === "INBOX"
            ? { id, name: id, type: "system", threadsTotal: 10 }
            : id === "UNREAD"
              ? { id, name: id, type: "system", threadsTotal: 4 }
              : null,
      }),
    );

    expect(result).toEqual({ unhandledCount: 4, type: "unread" });
  });
});

function provider(
  overrides: Partial<EmailProvider> & Pick<EmailProvider, "toJSON">,
): EmailProvider {
  return {
    getLabelById: async () => null,
    getInboxStats: async () => {
      throw new Error("stats should not be used");
    },
    ...overrides,
  } as EmailProvider;
}
