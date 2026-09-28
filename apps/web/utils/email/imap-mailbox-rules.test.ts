import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "@/utils/types";
import { blockedSenderAddresses } from "./imap-mailbox-rules";

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
