"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { LoadingContent } from "@/components/LoadingContent";
import { PageHeading } from "@/components/Typography";
import { Button } from "@/components/ui/button";
import { useDisplayedEmail } from "@/hooks/useDisplayedEmail";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useComposeModal } from "@/providers/ComposeModalProvider";
import type { ThreadsListResponse } from "@/app/api/threads/route";
import { fetchWithAccount } from "@/utils/fetch";
import { prefixPath } from "@/utils/path";

const folders = [
  { id: "inbox", label: "Inbox", query: "/api/threads?limit=30&view=list" },
  {
    id: "sent",
    label: "Sent",
    query: "/api/threads?limit=30&view=list&type=sent",
  },
  {
    id: "drafts",
    label: "Drafts",
    query: "/api/threads?limit=30&view=list&type=drafts",
  },
  {
    id: "archive",
    label: "Archive",
    query: "/api/threads?limit=30&view=list&type=archive",
  },
  {
    id: "trash",
    label: "Trash",
    query: "/api/threads?limit=30&view=list&type=trash",
  },
] as const;

export function ImapInbox() {
  const { emailAccountId } = useAccount();
  const { onOpen: openCompose } = useComposeModal();
  const [folder, setFolder] = useState<(typeof folders)[number]["id"]>("inbox");
  const selected = folders.find((item) => item.id === folder) ?? folders[0];
  const { data, error, isLoading, mutate } = useSWR<ThreadsListResponse>(
    selected.query,
  );
  const { showEmail, threadId: openThreadId } = useDisplayedEmail();
  const [archiveError, setArchiveError] = useState("");

  async function markOpenedThreadRead(threadId: string) {
    const response = await fetchWithAccount({
      url: `/api/threads/${encodeURIComponent(threadId)}/read`,
      emailAccountId,
      init: { method: "POST" },
    });
    if (response.ok) await mutate();
  }

  async function moveThread(
    threadId: string,
    action:
      | "archive"
      | "trash"
      | "unarchive"
      | "untrash"
      | "send-draft"
      | "discard-draft",
  ) {
    setArchiveError("");
    const response = await fetchWithAccount({
      url: `/api/threads/${encodeURIComponent(threadId)}/${action}`,
      emailAccountId,
      init: { method: "POST" },
    });
    if (!response.ok) {
      setArchiveError(moveError(action));
      return;
    }
    if (
      openThreadId === threadId &&
      (action === "send-draft" || action === "discard-draft")
    ) {
      showEmail(null);
    }
    await mutate();
  }

  return (
    <LoadingContent loading={isLoading} error={error}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={prefixPath(emailAccountId, "/automation")}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Inbox Zero
            </Link>
            <PageHeading>{selected.label}</PageHeading>
          </div>
          <Button type="button" size="sm" onClick={openCompose}>
            Compose
          </Button>
        </div>
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
              const unread =
                folder === "inbox" && message?.labelIds?.includes("UNREAD");
              return (
                <li key={thread.id} className="flex items-start gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-2 py-3 text-left hover:bg-muted"
                    onClick={() => {
                      showEmail({
                        threadId: thread.id,
                        messageId: message?.id,
                      });
                      if (folder === "inbox") {
                        markOpenedThreadRead(thread.id).catch(() => undefined);
                      }
                    }}
                  >
                    <div
                      className={
                        unread
                          ? "truncate font-semibold"
                          : "truncate font-medium"
                      }
                    >
                      {message?.headers.from || "Unknown sender"}
                      {unread ? (
                        <span className="ml-2 font-normal text-xs text-muted-foreground">
                          Unread
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-sm">
                      {message?.subject || "(No subject)"}
                    </div>
                    <div className="truncate text-sm text-muted-foreground">
                      {message?.snippet}
                    </div>
                  </button>
                  {folder === "inbox" ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => moveThread(thread.id, "archive")}
                      >
                        Archive
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => moveThread(thread.id, "trash")}
                      >
                        Trash
                      </Button>
                    </>
                  ) : null}
                  {folder === "drafts" ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => moveThread(thread.id, "send-draft")}
                      >
                        Send
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => moveThread(thread.id, "discard-draft")}
                      >
                        Discard
                      </Button>
                    </>
                  ) : null}
                  {folder === "archive" || folder === "trash" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() =>
                        moveThread(
                          thread.id,
                          folder === "trash" ? "untrash" : "unarchive",
                        )
                      }
                    >
                      Move to inbox
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            {emptyFolderCopy(folder)}
          </p>
        )}
      </div>
    </LoadingContent>
  );
}

function moveError(
  action:
    | "archive"
    | "trash"
    | "unarchive"
    | "untrash"
    | "send-draft"
    | "discard-draft",
) {
  if (action === "trash") return "Could not move this email to Trash.";
  if (action === "unarchive" || action === "untrash")
    return "Could not move this email to the inbox.";
  if (action === "send-draft") return "Could not send this draft.";
  if (action === "discard-draft") return "Could not discard this draft.";
  return "Could not archive this email.";
}

function emptyFolderCopy(folder: (typeof folders)[number]["id"]) {
  if (folder === "sent") return "Sent is empty.";
  if (folder === "drafts") return "Drafts is empty.";
  if (folder === "archive") return "Archive is empty.";
  if (folder === "trash") return "Trash is empty.";
  return "The inbox is empty.";
}
