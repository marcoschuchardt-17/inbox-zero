"use client";

import { useState } from "react";
import useSWR from "swr";
import { LoadingContent } from "@/components/LoadingContent";
import { PageHeading } from "@/components/Typography";
import { Button } from "@/components/ui/button";
import { useDisplayedEmail } from "@/hooks/useDisplayedEmail";
import { useAccount } from "@/providers/EmailAccountProvider";
import type { ThreadsListResponse } from "@/app/api/threads/route";
import { fetchWithAccount } from "@/utils/fetch";

const folders = [
  { id: "inbox", label: "Inbox", query: "/api/threads?limit=30&view=list" },
  {
    id: "sent",
    label: "Sent",
    query: "/api/threads?limit=30&view=list&type=sent",
  },
] as const;

export function ImapInbox() {
  const { emailAccountId } = useAccount();
  const [folder, setFolder] = useState<(typeof folders)[number]["id"]>("inbox");
  const selected = folders.find((item) => item.id === folder) ?? folders[0];
  const { data, error, isLoading, mutate } = useSWR<ThreadsListResponse>(
    selected.query,
  );
  const { showEmail } = useDisplayedEmail();
  const [archiveError, setArchiveError] = useState("");

  async function archiveThread(threadId: string) {
    setArchiveError("");
    const response = await fetchWithAccount({
      url: `/api/threads/${encodeURIComponent(threadId)}/archive`,
      emailAccountId,
      init: { method: "POST" },
    });
    if (!response.ok) {
      setArchiveError("Could not archive this email.");
      return;
    }
    await mutate();
  }

  return (
    <LoadingContent loading={isLoading} error={error}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <PageHeading>{selected.label}</PageHeading>
        <div className="mt-3 flex gap-2">
          {folders.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant={item.id === folder ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setArchiveError("");
                setFolder(item.id);
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
        {archiveError ? (
          <p className="mt-3 text-sm text-destructive">{archiveError}</p>
        ) : null}
        {data?.threads.length ? (
          <ul className="mt-4 divide-y">
            {data.threads.map((thread) => {
              const message = thread.messages.at(-1);
              return (
                <li key={thread.id} className="flex items-start gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-2 py-3 text-left hover:bg-muted"
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
                  {folder === "inbox" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => archiveThread(thread.id)}
                    >
                      Archive
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            {folder === "sent" ? "Sent is empty." : "The inbox is empty."}
          </p>
        )}
      </div>
    </LoadingContent>
  );
}
