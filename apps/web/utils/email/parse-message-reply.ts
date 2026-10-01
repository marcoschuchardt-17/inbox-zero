import { load, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { textStartsWithForwardedMessage } from "@/utils/email/forwarded-quote";
import type { ParsedMessage } from "@/utils/types";
import { convertEmailHtmlToText, parseReply } from "@/utils/mail";

export function parseMessageReply(message: ParsedMessage): ParsedMessage {
  const parsedTextPlain = parseReply(message.textPlain || "").trim();
  const strippedHtml = message.textHtml
    ? stripQuotedHtmlContent(message.textHtml).trim()
    : "";
  const parsedHtmlText = strippedHtml
    ? parseReply(
        convertEmailHtmlToText({
          htmlText: strippedHtml,
          includeLinks: false,
        }),
      ).trim()
    : "";

  return {
    ...message,
    textPlain: parsedTextPlain || parsedHtmlText,
    textHtml: strippedHtml,
  };
}

export function stripQuotedHtmlContent(html: string): string {
  const $ = load(html, null, false);

  $(
    [
      ".gmail_quote_container",
      ".gmail_quote",
      ".gmail_attr",
      "blockquote[type='cite']",
    ].join(", "),
  )
    .filter((_, element) => !isForwardedQuote($, element))
    .remove();

  return $.root().html() || html;
}

// A forward is the message. A reply quote is history the thread already shows.
function isForwardedQuote($: CheerioAPI, element: AnyNode) {
  const candidates = [element, ...$(element).parents().toArray()];
  return candidates.some((node) => {
    if (node.type !== "tag") return false;
    return textStartsWithForwardedMessage($(node).text());
  });
}
