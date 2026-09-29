import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmailProvider = vi.hoisted(() => ({
  getThread: vi.fn(),
  markMessagesStarredState: vi.fn(),
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware(mockEmailProvider);
});

import { POST } from "./route";

function star(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3000/api/threads/thread-1/star", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "thread-1" }) } as never,
  );
}

describe("POST /api/threads/[id]/star", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmailProvider.getThread.mockResolvedValue({
      id: "thread-1",
      messages: [{ id: "INBOX/1" }, { id: "INBOX/2" }],
    });
    mockEmailProvider.markMessagesStarredState.mockResolvedValue(undefined);
  });

  it("stars every message in the thread", async () => {
    const response = await star({ starred: true });

    expect(mockEmailProvider.getThread).toHaveBeenCalledWith("thread-1");
    expect(mockEmailProvider.markMessagesStarredState).toHaveBeenCalledWith(
      ["INBOX/1", "INBOX/2"],
      true,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it("removes the star when starred is false", async () => {
    const response = await star({ starred: false });

    expect(mockEmailProvider.markMessagesStarredState).toHaveBeenCalledWith(
      ["INBOX/1", "INBOX/2"],
      false,
    );
    expect(response.status).toBe(200);
  });

  it("rejects a body that does not say whether to star", async () => {
    const response = await star({});

    expect(mockEmailProvider.markMessagesStarredState).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });

  it("returns 404 when the thread has no messages", async () => {
    mockEmailProvider.getThread.mockResolvedValue({
      id: "thread-1",
      messages: [],
    });

    const response = await star({ starred: true });

    expect(response.status).toBe(404);
    expect(mockEmailProvider.markMessagesStarredState).not.toHaveBeenCalled();
  });
});
