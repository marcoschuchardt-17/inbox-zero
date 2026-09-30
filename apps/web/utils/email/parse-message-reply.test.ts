import { describe, expect, it, vi } from "vitest";
import type { ParsedMessage } from "@/utils/types";
import { parseMessageReply } from "./parse-message-reply";

vi.mock("server-only", () => ({}));

describe("parseMessageReply", () => {
  it("removes quoted replies from plain text messages", () => {
    const message = createMessage({
      textPlain:
        "Fresh reply\n\nOn Tue, Apr 28, 2026 at 1:10 PM, Sender <sender@example.com> wrote:\n\n> Older quoted line",
    });

    expect(parseMessageReply(message).textPlain).toBe("Fresh reply");
  });

  it("removes Gmail quote containers before converting HTML", () => {
    const message = createMessage({
      textPlain: "",
      textHtml:
        '<div>Fresh reply</div><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">Le lun. 27 avr. 2026, Sender a écrit:</div><blockquote class="gmail_quote"><div>Older quoted line</div></blockquote></div>',
    });

    expect(parseMessageReply(message)).toMatchObject({
      textPlain: "Fresh reply",
      textHtml: "<div>Fresh reply</div>",
    });
  });

  it("keeps an inline image in the opened reply", () => {
    const message = createMessage({
      textPlain: "Inline photo check",
      textHtml:
        '<p>Inline photo check</p><img src="cid:photo@inboxzero.local" alt="red block"><div class="gmail_quote">Older quoted line</div>',
    });

    const parsed = parseMessageReply(message);

    expect(parsed.textPlain).toBe("Inline photo check");
    expect(parsed.textHtml).toContain('src="cid:photo@inboxzero.local"');
    expect(parsed.textHtml).not.toContain("Older quoted line");
  });

  it("keeps a forwarded message that uses the reply quote markup", () => {
    const message = createMessage({
      textPlain:
        "Passing this along.\n\n---------- Forwarded message ----------\nFrom: Digest <digest@example.com>\n\nCan you reply to this?",
      textHtml:
        '<p>Passing this along.</p><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">---------- Forwarded message ----------<br>From: Digest &lt;digest@example.com&gt;</div><p>Can you reply to this?</p></div>',
    });

    const parsed = parseMessageReply(message);

    expect(parsed.textHtml).toContain("Passing this along.");
    expect(parsed.textHtml).toContain("digest@example.com");
    expect(parsed.textHtml).toContain("Can you reply to this?");
  });

  it("still removes a reply that quotes an older forward", () => {
    const message = createMessage({
      textPlain: "Fresh reply",
      textHtml:
        '<div>Fresh reply</div><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">On Tue, Sender wrote:</div><blockquote class="gmail_quote"><div>Older quoted line</div><div class="gmail_quote">---------- Forwarded message ----------<p>Nested forward</p></div></blockquote></div>',
    });

    const parsed = parseMessageReply(message);

    expect(parsed.textHtml).toContain("Fresh reply");
    expect(parsed.textHtml).not.toContain("Nested forward");
    expect(parsed.textHtml).not.toContain("Older quoted line");
  });
});

function createMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    date: "2026-04-28T13:10:00.000Z",
    headers: {
      date: "2026-04-28T13:10:00.000Z",
      from: "sender@example.com",
      subject: "Re: Update",
      to: "me@example.com",
    },
    historyId: "history-1",
    id: "message-1",
    inline: [],
    snippet: "Fresh reply",
    subject: "Re: Update",
    threadId: "thread-1",
    ...overrides,
  };
}
