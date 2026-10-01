import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmailProvider = vi.hoisted(() => ({
  moveThreadToFolder: vi.fn(),
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware(mockEmailProvider);
});

import { POST } from "./route";

function move(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3000/api/threads/thread-1/move", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "thread-1" }) } as never,
  );
}

describe("POST /api/threads/[id]/move", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmailProvider.moveThreadToFolder.mockResolvedValue(undefined);
  });

  it("moves the thread into the named folder", async () => {
    const response = await move({ folder: "Receipts" });

    expect(response.status).toBe(200);
    expect(mockEmailProvider.moveThreadToFolder).toHaveBeenCalledWith(
      "thread-1",
      "user@example.com",
      "Receipts",
    );
  });

  it("rejects a move that does not name a folder", async () => {
    const response = await move({});

    expect(response.status).toBe(400);
    expect(mockEmailProvider.moveThreadToFolder).not.toHaveBeenCalled();
  });
});
