import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import { messageQuerySchema } from "@/app/api/messages/validation";
import { GmailLabel } from "@/utils/gmail/label";
import type { EmailProvider } from "@/utils/email/types";
import { messageIsFromAccountOnly } from "@/utils/email";
import { isGoogleProvider, isImapProvider } from "@/utils/email/provider-types";
import type { Logger } from "@/utils/logger";

export type MessagesResponse = Awaited<ReturnType<typeof getMessages>>;

export const GET = withEmailProvider("messages", async (request) => {
  const { emailProvider } = request;
  const { emailAccountId, email } = request.auth;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");
  const pageToken = searchParams.get("pageToken");
  const r = messageQuerySchema.parse({ q: query, pageToken });

  const result = await getMessages({
    emailAccountId,
    query: r.q,
    pageToken: r.pageToken,
    accountEmail: email,
    emailProvider,
    logger: request.logger,
  });

  return NextResponse.json(result);
});

async function getMessages({
  query,
  pageToken,
  emailAccountId,
  accountEmail,
  emailProvider,
  logger,
}: {
  query?: string | null;
  pageToken?: string | null;
  emailAccountId: string;
  accountEmail: string;
  emailProvider: EmailProvider;
  logger: Logger;
}) {
  try {
    const { messages, nextPageToken } =
      await emailProvider.getMessagesWithPagination({
        query: query?.trim() ?? "",
        maxResults: 20,
        pageToken: pageToken ?? undefined,
      });

    const incomingMessages = messages.filter((message) => {
      // Sent and draft rows are mail this account wrote. Rule tests stay on
      // incoming mail, including a sent copy that is still in the inbox.
      if (
        isGoogleProvider(emailProvider.name) ||
        isImapProvider(emailProvider.name)
      ) {
        const isDraft = message.labelIds?.includes(GmailLabel.DRAFT);
        const isInbox = message.labelIds?.includes(GmailLabel.INBOX);
        const wroteIt =
          !!message.labelIds?.includes(GmailLabel.SENT) ||
          messageIsFromAccountOnly(message.headers?.from || "", accountEmail);

        if (isDraft) return false;

        if (wroteIt) {
          // Only show sent message that are in the inbox
          return isInbox;
        }
      } else if (emailProvider.name === "microsoft") {
        // For Outlook, we already filter out drafts in the message fetching
        // No additional filtering needed here
      }

      // Return all other messages
      return true;
    });

    return { messages: incomingMessages, nextPageToken };
  } catch (error) {
    logger.error("Error getting messages", {
      emailAccountId,
      query,
      pageToken,
      error,
    });
    throw error;
  }
}
