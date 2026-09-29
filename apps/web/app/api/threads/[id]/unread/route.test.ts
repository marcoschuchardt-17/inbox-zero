import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmailProvider = vi.hoisted(() => ({
  markReadThread: vi.fn(),
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware(mockEmailProvider);
});

import { POST } from "./route";

function markUnread() {
  return POST(
    new NextRequest("http://localhost:3000/api/threads/thread-1/unread", {
      method: "POST",
    }),
    { params: Promise.resolve({ id: "thread-1" }) } as never,
  );
}

describe("POST /api/threads/[id]/unread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmailProvider.markReadThread.mockResolvedValue(undefined);
  });

  it("clears the read state for the thread", async () => {
    const response = await markUnread();

    expect(response.status).toBe(200);
    expect(mockEmailProvider.markReadThread).toHaveBeenCalledWith(
      "thread-1",
      false,
    );
  });
});
