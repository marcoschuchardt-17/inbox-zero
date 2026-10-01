import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetMessagesWithPagination, provider } = vi.hoisted(() => ({
  mockGetMessagesWithPagination: vi.fn(),
  provider: { name: "imap" as string },
}));

vi.mock("@/utils/middleware", () => ({
  withEmailProvider:
    (
      _name: string,
      handler: (
        request: NextRequest & Record<string, unknown>,
      ) => Promise<Response>,
    ) =>
    (request: NextRequest) =>
      handler(
        Object.assign(request, {
          auth: {
            emailAccountId: "email-account-id",
            email: "owner@example.com",
          },
          emailProvider: {
            name: provider.name,
            getMessagesWithPagination: mockGetMessagesWithPagination,
          },
          logger: { error: vi.fn() },
        }),
      ),
}));

import { GET } from "./route";

describe("GET /api/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider.name = "imap";
    mockGetMessagesWithPagination.mockResolvedValue({
      messages: [
        { id: "inbox", labelIds: ["INBOX"] },
        { id: "sent", labelIds: ["SENT"] },
        { id: "draft", labelIds: ["DRAFT"] },
        { id: "sent-in-inbox", labelIds: ["SENT", "INBOX"] },
        { id: "archive", labelIds: [] },
      ],
    });
  });

  it("leaves an IMAP account's sent mail and drafts out of previous mail", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3000/api/messages"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages.map((message: { id: string }) => message.id)).toEqual([
      "inbox",
      "sent-in-inbox",
      "archive",
    ]);
  });

  it("leaves archived mail from this account out of previous mail", async () => {
    mockGetMessagesWithPagination.mockResolvedValue({
      messages: [
        {
          id: "incoming",
          labelIds: ["ARCHIVE"],
          headers: { from: "Sam <sam@example.com>" },
        },
        {
          id: "archived-sent",
          labelIds: ["ARCHIVE"],
          headers: { from: "Owner <owner@example.com>" },
        },
        {
          id: "inbox-copy",
          labelIds: ["INBOX"],
          headers: { from: "Owner <owner@example.com>" },
        },
        {
          id: "co-sender",
          labelIds: ["ARCHIVE"],
          headers: {
            from: "Sam <sam@example.com>, Owner <owner@example.com>",
          },
        },
      ],
    });

    const response = await GET(
      new NextRequest("http://localhost:3000/api/messages"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages.map((message: { id: string }) => message.id)).toEqual([
      "incoming",
      "inbox-copy",
      "co-sender",
    ]);
  });
});
