import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { createEmailProvider } from "@/utils/email/provider";
import { GET } from "./route";

vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/middleware", () => ({
  withEmailProvider:
    (_scope: string, handler: (request: NextRequest) => unknown) =>
    (request: NextRequest) => {
      Object.assign(request, {
        auth: {
          emailAccountId: "account-1",
          email: "owner@example.com",
        },
        emailProvider: { name: "imap" },
        logger: createScopedLogger("no-reply-test"),
      });
      return handler(request);
    },
}));

const getSentMessages = vi.fn();
const getThread = vi.fn();
const getThreadsWithQuery = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getThreadsWithQuery.mockResolvedValue({ threads: [] });
  vi.mocked(createEmailProvider).mockResolvedValue({
    getSentMessages,
    getThread,
    getThreadsWithQuery,
  } as never);
});

describe("GET /api/user/no-reply", () => {
  it("lists a sent conversation whose latest message is still from the account", async () => {
    getSentMessages.mockResolvedValue([
      { id: "Sent/1", threadId: "<note@example.com>" },
      { id: "Sent/2", threadId: "<note@example.com>" },
      { id: "Sent/3", threadId: "<answered@example.com>" },
    ]);
    getThread.mockImplementation(async (threadId: string) => {
      if (threadId === "<answered@example.com>") {
        return conversation("<answered@example.com>", [
          "Owner <owner@example.com>",
          "Sam <sam@example.com>",
        ]);
      }
      return conversation("<note@example.com>", [
        "Sam <sam@example.com>",
        "Owner <owner@example.com>",
      ]);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/user/no-reply"),
      {} as never,
    );
    const threads = await response.json();

    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe("<note@example.com>");
    expect(threads[0]?.messages).toHaveLength(2);
    expect(threads[0]?.messages.at(-1)?.headers.from).toContain(
      "owner@example.com",
    );
  });

  it("includes archived mail the account sent and skips mail sent with someone else", async () => {
    getSentMessages.mockResolvedValue([]);
    getThreadsWithQuery.mockResolvedValue({
      threads: [
        { id: "<copied@example.com>" },
        { id: "<both@example.com>" },
        { id: "<notowner@example.com>" },
      ],
    });
    getThread.mockImplementation(async (threadId: string) => {
      if (threadId === "<both@example.com>") {
        return conversation("<both@example.com>", [
          "Sam <sam@example.com>, Owner <owner@example.com>",
        ]);
      }
      if (threadId === "<notowner@example.com>") {
        return conversation("<notowner@example.com>", [
          "Notowner <notowner@example.com>",
        ]);
      }
      return conversation("<copied@example.com>", [
        "Owner <owner@example.com>",
      ]);
    });

    const response = await GET(
      new NextRequest("http://localhost/api/user/no-reply"),
      {} as never,
    );
    const threads = await response.json();

    expect(threads.map((thread: { id: string }) => thread.id)).toEqual([
      "<copied@example.com>",
    ]);
  });
});

function conversation(id: string, froms: string[]) {
  return {
    id,
    snippet: "Waiting",
    messages: froms.map((from, index) => ({
      id: `${id}:${index}`,
      snippet: "Waiting",
      headers: { from, subject: "Note" },
    })),
  };
}
