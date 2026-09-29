import { load } from "cheerio";
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
  ).remove();

  return $.root().html() || html;
}
