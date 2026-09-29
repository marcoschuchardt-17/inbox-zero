import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmailProvider = vi.hoisted(() => ({
  markSpam: vi.fn(),
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware(mockEmailProvider);
});

import { POST } from "./route";

function markSpam() {
  return POST(
    new NextRequest("http://localhost:3000/api/threads/thread-1/spam", {
      method: "POST",
    }),
    { params: Promise.resolve({ id: "thread-1" }) } as never,
  );
}

describe("POST /api/threads/[id]/spam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmailProvider.markSpam.mockResolvedValue(undefined);
  });

  it("moves the thread to Junk", async () => {
    const response = await markSpam();

    expect(response.status).toBe(200);
    expect(mockEmailProvider.markSpam).toHaveBeenCalledWith("thread-1");
  });
});
