import { formatEmailDate } from "@/utils/gmail/reply";
import { splitRecipientList } from "@/utils/email";
import type { ParsedMessage } from "@/utils/types";
import { escapeHtml, textToHtmlParagraphs } from "@/utils/string";

// A forward already marked Fwd/Fw keeps that one prefix, the same way a reply
// keeps a single Re:.
export const forwardEmailSubject = (subject: string) => {
  const trimmed = (subject ?? "").trim();
  if (/^fw(?:d)?:/i.test(trimmed)) return trimmed;
  return `Fwd: ${trimmed}`;
};

export const forwardEmailHtml = ({
  content,
  message,
}: {
  content: string;
  message: ParsedMessage;
}) => {
  const quotedDate = formatEmailDate(new Date(message.headers.date));
  const messageContent =
    message.textHtml || textToHtmlParagraphs(message.textPlain);

  // Escape content and subject to prevent prompt injection attacks
  return `<div dir="ltr">${escapeHtml(content)}<br><br>
<div class="gmail_quote gmail_quote_container">
  <div dir="ltr" class="gmail_attr">---------- Forwarded message ----------<br>
From: ${formatFromListHtml(message.headers.from)}<br>
Date: ${quotedDate}<br>
Subject: ${escapeHtml(message.headers.subject)}<br>
To: ${formatAddressListHtml(message.headers.to)}<br>${copiedRecipientsLine(message.headers.cc)}
</div><br><br>
${messageContent}
</div></div>`.trim();
};

export const forwardEmailText = ({
  content,
  message,
}: {
  content: string;
  message: ParsedMessage;
}) => `${content}
        
---------- Forwarded message ----------
From: ${message.headers.from}
Date: ${message.headers.date}
Subject: ${message.headers.subject}
To: ${message.headers.to}${message.headers.cc?.trim() ? `\nCc: ${message.headers.cc}` : ""}

${message.textPlain}`;

function formatFromListHtml(emailHeader: string) {
  const senders = splitRecipientList(emailHeader);
  if (!senders.length) return escapeHtml(emailHeader || "");
  return senders.map(formatFromEmailWithName).join(", ");
}

const formatFromEmailWithName = (emailHeader: string) => {
  const match = emailHeader?.match(/(.*?)\s*<([^>]+)>/);
  if (!match) return escapeHtml(emailHeader || "");

  const [, name, email] = match;
  const safeName = escapeHtml(name.trim());
  const safeEmail = escapeHtml(email);

  return `<strong class="gmail_sendername" dir="auto">${safeName}</strong> <span dir="auto">&lt;<a href="mailto:${safeEmail}">${safeEmail}</a>&gt;</span>`;
};

function copiedRecipientsLine(cc: string | undefined) {
  const copied = cc?.trim();
  if (!copied) return "";
  return `\nCc: ${formatAddressListHtml(copied)}<br>`;
}

function formatAddressListHtml(emailHeader: string) {
  const recipients = splitRecipientList(emailHeader);
  if (!recipients.length) return escapeHtml(emailHeader || "");
  return recipients.map(formatToEmailWithName).join(", ");
}

const formatToEmailWithName = (emailHeader: string) => {
  const match = emailHeader?.match(/(.*?)\s*<([^>]+)>/);
  if (!match) return escapeHtml(emailHeader || "");

  const [, name, email] = match;
  const safeName = escapeHtml(name.trim());
  const safeEmail = escapeHtml(email);

  return `${safeName} &lt;<a href="mailto:${safeEmail}">${safeEmail}</a>&gt;`;
};
