import { describe, expect, it } from "vitest";
import { decideCleanAction } from "@/utils/clean/decide";
import type { ParsedMessage } from "@/utils/types";

const skips = {
  starred: true,
  calendar: true,
  receipt: false,
  attachment: false,
  conversation: false,
};

describe("decideCleanAction", () => {
  it("archives a newsletter and keeps a starred message", () => {
    expect(
      decideCleanAction({
        messages: [message({ from: "News <news@newsletter.example.com>" })],
        skips,
      }),
    ).toBe("done");

    expect(
      decideCleanAction({
        messages: [
          message({
            from: "Sam <sam@example.com>",
            labelIds: ["INBOX", "STARRED"],
          }),
        ],
        skips,
      }),
    ).toBe("keep");
  });

  it("leaves ordinary mail for the model instead of archiving it", () => {
    expect(
      decideCleanAction({
        messages: [message({ from: "Sam <sam@example.com>" })],
        skips,
      }),
    ).toBe("needs-model");
  });
});

function message({
  from,
  labelIds = ["INBOX"],
}: {
  from: string;
  labelIds?: string[];
}): ParsedMessage {
  return {
    id: "1",
    threadId: "thread-1",
    labelIds,
    headers: { from, subject: "Hello", to: "me@example.com" },
  } as ParsedMessage;
}
