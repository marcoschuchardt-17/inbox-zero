import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { getUncategorizedSenders } from "./get-uncategorized-senders";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

describe("getUncategorizedSenders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "starttls.imap@example.com",
    } as never);
    prisma.newsletter.findMany.mockResolvedValue([]);
  });

  it("leaves the account off the list, including when it is one of two senders", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([
      {
        from: "starttls.imap@example.com",
        fromName: "Starttls",
      },
      {
        from: "sam.participant@gmail.com, starttls.imap@example.com",
        fromName: "Sam Participant",
      },
      {
        from: "starttls.imap@example.com, ada@example.com",
        fromName: "Starttls",
      },
    ] as never);

    const result = await getUncategorizedSenders({
      emailAccountId: "account-1",
    });

    expect(result.uncategorizedSenders).toEqual([
      { email: "sam.participant@gmail.com", name: "Sam Participant" },
      { email: "ada@example.com", name: null },
    ]);
  });
});
