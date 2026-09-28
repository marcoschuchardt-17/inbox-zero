import { describe, expect, it, vi } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import {
  applyImapStaticMailboxActions,
  blockedSenderAddresses,
} from "./imap-mailbox-rules";

vi.mock("@/utils/prisma");

function message(from: string): ParsedMessage {
  return { headers: { from } } as ParsedMessage;
}

describe("blockedSenderAddresses", () => {
  it("returns blocked senders that are in the mailbox", () => {
    expect(
      blockedSenderAddresses(
        [
          message("Billing <billing@example.com>"),
          message("Sam <sam@example.com>"),
        ],
        ["Billing@Example.com"],
      ),
    ).toEqual(["billing@example.com"]);
  });
});

describe("applyImapStaticMailboxActions", () => {
  it("archives mail that matches a static archive rule", async () => {
    vi.mocked(prisma.rule.findMany).mockResolvedValue([
      {
        from: "ads@example.com",
        to: null,
        subject: null,
        body: null,
        actions: [
          {
            type: ActionType.ARCHIVE,
            folderId: null,
            folderName: null,
          },
        ],
      },
    ] as never);
    const archiveThread = vi.fn();
    const provider = {
      archiveThread,
      markRead: vi.fn(),
      starMessage: vi.fn(),
      markSpam: vi.fn(),
      moveThreadToFolder: vi.fn(),
      getOrCreateFolderIdByName: vi.fn(),
    } as unknown as EmailProvider;

    const applied = await applyImapStaticMailboxActions({
      emailAccountId: "account-1",
      messages: [
        mail("1", "thread-1", "Ads <ads@example.com>"),
        mail("2", "thread-1", "Ads <ads@example.com>"),
        mail("3", "thread-2", "Sam <sam@example.com>"),
      ],
      provider,
      logger,
    });

    expect(applied).toBe(1);
    expect(archiveThread).toHaveBeenCalledTimes(1);
    expect(archiveThread).toHaveBeenCalledWith("thread-1", "");
  });
});

const logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  with: () => logger,
} as unknown as Logger;

function mail(id: string, threadId: string, from: string): ParsedMessage {
  return {
    id,
    threadId,
    headers: { from, subject: "Hello" },
  } as ParsedMessage;
}
