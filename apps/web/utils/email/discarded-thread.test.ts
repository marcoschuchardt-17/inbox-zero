import { describe, expect, it } from "vitest";
import { shouldCloseConversationAfterDraftDiscard } from "@/utils/email/discarded-thread";

describe("shouldCloseConversationAfterDraftDiscard", () => {
  it("closes when the discarded draft was the only message", () => {
    expect(
      shouldCloseConversationAfterDraftDiscard({
        discarded: true,
        hasCloseHandler: true,
        messageIds: ["Drafts/111"],
        discardedMessageId: "Drafts/111",
      }),
    ).toBe(true);
  });

  it("keeps a conversation that still has the original message", () => {
    expect(
      shouldCloseConversationAfterDraftDiscard({
        discarded: true,
        hasCloseHandler: true,
        messageIds: ["Inbox/4", "Drafts/111"],
        discardedMessageId: "Drafts/111",
      }),
    ).toBe(false);
  });

  it("keeps the conversation when another draft is still there", () => {
    expect(
      shouldCloseConversationAfterDraftDiscard({
        discarded: true,
        hasCloseHandler: true,
        messageIds: ["Drafts/111", "Drafts/112"],
        discardedMessageId: "Drafts/111",
      }),
    ).toBe(false);
  });

  it("leaves the conversation open when discard failed", () => {
    expect(
      shouldCloseConversationAfterDraftDiscard({
        discarded: false,
        hasCloseHandler: true,
        messageIds: ["Drafts/111"],
        discardedMessageId: "Drafts/111",
      }),
    ).toBe(false);
  });

  it("leaves the conversation open when nothing can close it", () => {
    expect(
      shouldCloseConversationAfterDraftDiscard({
        discarded: true,
        hasCloseHandler: false,
        messageIds: ["Drafts/111"],
        discardedMessageId: "Drafts/111",
      }),
    ).toBe(false);
  });
});
