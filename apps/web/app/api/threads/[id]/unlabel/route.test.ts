import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmailProvider = vi.hoisted(() => ({
  removeThreadLabel: vi.fn(),
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware(mockEmailProvider);
});

import { POST } from "./route";

function unlabel(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3000/api/threads/thread-1/unlabel", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "thread-1" }) } as never,
  );
}

describe("POST /api/threads/[id]/unlabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmailProvider.removeThreadLabel.mockResolvedValue(undefined);
  });

  it("removes the label from the thread", async () => {
    const response = await unlabel({ labelId: "Rechnungen" });

    expect(response.status).toBe(200);
    expect(mockEmailProvider.removeThreadLabel).toHaveBeenCalledWith(
      "thread-1",
      "Rechnungen",
    );
  });

  it("rejects a request that does not name the label", async () => {
    const response = await unlabel({});

    expect(response.status).toBe(400);
    expect(mockEmailProvider.removeThreadLabel).not.toHaveBeenCalled();
  });
});
