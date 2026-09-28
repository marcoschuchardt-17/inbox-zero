"use client";

import useSWR from "swr";
import { LoadingContent } from "@/components/LoadingContent";
import { PageHeading } from "@/components/Typography";
import { useDisplayedEmail } from "@/hooks/useDisplayedEmail";
import type { ThreadsListResponse } from "@/app/api/threads/route";

export function ImapInbox() {
  const { data, error, isLoading } = useSWR<ThreadsListResponse>(
    "/api/threads?limit=30&view=list",
  );
  const { showEmail } = useDisplayedEmail();

  return (
    <LoadingContent loading={isLoading} error={error}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <PageHeading>Inbox</PageHeading>
        {data?.threads.length ? (
          <ul className="mt-4 divide-y">
            {data.threads.map((thread) => {
              const message = thread.messages.at(-1);
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    className="w-full px-2 py-3 text-left hover:bg-muted"
                    onClick={() =>
                      showEmail({
                        threadId: thread.id,
                        messageId: message?.id,
                      })
                    }
                  >
                    <div className="truncate font-medium">
                      {message?.headers.from || "Unknown sender"}
                    </div>
                    <div className="truncate text-sm">
                      {message?.subject || "(No subject)"}
                    </div>
                    <div className="truncate text-sm text-muted-foreground">
                      {message?.snippet}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            The inbox is empty.
          </p>
        )}
      </div>
    </LoadingContent>
  );
}
