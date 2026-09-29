import type { EmailProvider } from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";

const MAX_POLL_PAGES = 50;

export async function collectImapPollMessages(
  provider: Pick<EmailProvider, "getMailboxSyncPage" | "getThreadsWithQuery">,
  {
    after,
    limit,
  }: {
    after?: Date | null;
    limit: number;
  },
): Promise<ParsedMessage[]> {
  if (!after) {
    const page = await provider.getMailboxSyncPage({ limit });
    return page.upsertedMessages;
  }

  const messages: ParsedMessage[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_POLL_PAGES; page++) {
    const result = await provider.getThreadsWithQuery({
      query: { after, type: "inbox" },
      maxResults: limit,
      pageToken,
    });
    for (const thread of result.threads) {
      messages.push(...thread.messages);
    }
    if (!result.nextPageToken || result.nextPageToken === pageToken) break;
    pageToken = result.nextPageToken;
  }
  return messages;
}

export function highestImapUid(messages: { id: string }[]) {
  return messages.reduce((max, message) => {
    const uid = imapUid(message.id);
    return uid > max ? uid : max;
  }, 0);
}

function imapUid(messageId: string) {
  const separator = messageId.lastIndexOf("/");
  const raw = separator >= 0 ? messageId.slice(separator + 1) : messageId;
  const uid = Number(raw);
  if (!Number.isInteger(uid) || uid <= 0) return 0;
  return uid;
}
