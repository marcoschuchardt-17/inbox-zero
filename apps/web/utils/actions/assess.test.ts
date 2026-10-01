import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { analyzeWritingStyleAction, assessAction } from "./assess";

const { createEmailProvider } = vi.hoisted(() => ({
  createEmailProvider: vi.fn(),
}));

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "primary@example.com" },
  })),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider,
}));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));

describe("IMAP account open", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "mail@example.com",
      account: { userId: "user-1", provider: "imap" },
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>);
  });

  it("does not open the mailbox while assessing a new IMAP account", async () => {
    const result = await assessAction("email-account-1");

    expect(result?.data).toEqual({ success: true, skipped: true });
    expect(createEmailProvider).not.toHaveBeenCalled();
  });

  it("does not open the mailbox while reading writing style for IMAP", async () => {
    const result = await analyzeWritingStyleAction("email-account-1");

    expect(result?.data).toEqual({ success: true, skipped: true });
    expect(createEmailProvider).not.toHaveBeenCalled();
  });
});
