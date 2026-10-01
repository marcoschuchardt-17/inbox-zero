import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEmailProvider = vi.hoisted(() => ({
  labelMessage: vi.fn(),
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailProviderTestMiddleware(mockEmailProvider);
});

import { POST } from "./route";

function label(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3000/api/threads/thread-1/label", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: "thread-1" }) } as never,
  );
}

describe("POST /api/threads/[id]/label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmailProvider.labelMessage.mockResolvedValue({
      actualLabelId: "Rechnungen",
    });
  });

  it("adds the label to the message", async () => {
    const response = await label({
      labelId: "Rechnungen",
      messageId: "Archive/3",
    });

    expect(response.status).toBe(200);
    expect(mockEmailProvider.labelMessage).toHaveBeenCalledWith({
      messageId: "Archive/3",
      labelId: "Rechnungen",
      labelName: null,
    });
  });

  it("rejects a label request that does not name the message", async () => {
    const response = await label({ labelId: "Rechnungen" });

    expect(response.status).toBe(400);
    expect(mockEmailProvider.labelMessage).not.toHaveBeenCalled();
  });
});
