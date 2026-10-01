import { isNewsletterSender } from "@/utils/ai/group/find-newsletters";
import { isMaybeReceipt, isReceipt } from "@/utils/ai/group/find-receipts";
import { getCalendarEventStatus } from "@/utils/parse/calender-event";
import { findUnsubscribeLink } from "@/utils/parse/parseHtml.server";
import type { ParsedMessage } from "@/utils/types";

const CATEGORY_LABELS = new Set([
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

export type CleanDecision = "done" | "keep" | "needs-model";

export function decideCleanAction({
  messages,
  skips,
}: {
  messages: ParsedMessage[];
  skips: {
    starred?: boolean | null;
    calendar?: boolean | null;
    receipt?: boolean | null;
    attachment?: boolean | null;
    conversation?: boolean | null;
  };
}): CleanDecision {
  let needsModel = false;

  for (const message of messages) {
    if (skips.starred && hasLabel(message, "STARRED")) return "keep";
    if (skips.conversation && hasLabel(message, "SENT")) return "keep";
    if (skips.attachment && message.attachments?.length) return "keep";

    if (skips.receipt) {
      if (isReceipt(message)) return "keep";
      if (isMaybeReceipt(message)) needsModel = true;
    }

    const calendar = getCalendarEventStatus(message);
    if (skips.calendar && calendar.isEvent) {
      if (calendar.timing === "past") return "done";
      if (calendar.timing === "future") return "keep";
    }

    if (!hasLabel(message, "SENT") && hasUnsubscribeLink(message))
      return "done";
    if (
      !hasLabel(message, "SENT") &&
      isNewsletterSender(message.headers.from)
    ) {
      return "done";
    }
  }

  const latest = messages.at(-1);
  if (
    !needsModel &&
    latest?.labelIds?.some((label) => CATEGORY_LABELS.has(label))
  ) {
    return "done";
  }

  return "needs-model";
}

function hasLabel(message: ParsedMessage, label: string) {
  return message.labelIds?.includes(label);
}

function hasUnsubscribeLink(message: ParsedMessage) {
  return Boolean(
    findUnsubscribeLink(message.textHtml) ||
      message.headers["list-unsubscribe"],
  );
}
