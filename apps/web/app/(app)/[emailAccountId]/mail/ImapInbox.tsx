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
import type { GetFoldersResponse } from "@/app/api/user/folders/route";
import { fetchWithAccount } from "@/utils/fetch";
import { imapThreadLabelIds } from "@/utils/email/imap-flags";
import { prefixPath } from "@/utils/path";
import type { LabelsResponse } from "@/app/api/labels/route";

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
  const [folder, setFolder] = useState("inbox");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const { data: mailboxList } = useSWR<GetFoldersResponse>("/api/user/folders");
  const { data: labelList } = useSWR<LabelsResponse>("/api/labels");
  const labelNames = new Map(
    (labelList?.labels ?? []).map((label) => [label.id, label.name]),
  );
  const extraFolders = (mailboxList ?? []).filter(
    (item) =>
      !isStandardMailbox(item.id) && !isStandardMailbox(item.displayName),
  );
  const filingFolders = extraFolders.filter(
    (item) => !isJunkMailbox(item.id) && !isJunkMailbox(item.displayName),
  );
  const selected = folders.find((item) => item.id === folder);
  const extra = extraFolders.find(
    (item) => mailboxFolderId(item.id) === folder,
  );
  const listQuery = submittedSearch
    ? `/api/threads?limit=30&view=list&q=${encodeURIComponent(submittedSearch)}`
    : (selected?.query ??
      (extra
        ? `/api/threads?limit=30&view=list&folderId=${encodeURIComponent(extra.id)}`
        : folders[0].query));
  const { data, error, isLoading, mutate } =
    useSWR<ThreadsListResponse>(listQuery);
  const [archiveError, setArchiveError] = useState("");
  const [olderPages, setOlderPages] = useState<{
    query: string;
    threads: ThreadsListResponse["threads"];
    nextPageToken?: string;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderThreads =
    olderPages?.query === listQuery ? olderPages.threads : [];
  const nextPageToken =
    olderPages?.query === listQuery
      ? olderPages.nextPageToken
      : data?.nextPageToken;
  const visibleThreads = [...(data?.threads ?? []), ...olderThreads];
  const { showEmail, threadId: openThreadId } = useDisplayedEmail();

  async function markOpenedThreadRead(threadId: string) {
    const response = await fetchWithAccount({
      url: `/api/threads/${encodeURIComponent(threadId)}/read`,
      emailAccountId,
      init: { method: "POST" },
    });
    if (response.ok) await mutate();
  }

  async function loadOlderMail() {
    if (!nextPageToken) return;
    setArchiveError("");
    setLoadingOlder(true);
    const response = await fetchWithAccount({
      url: `${listQuery}&nextPageToken=${encodeURIComponent(nextPageToken)}`,
      emailAccountId,
    });
    setLoadingOlder(false);
    if (!response.ok) {
      setArchiveError("Could not load older mail.");
      return;
    }
    const page = (await response.json()) as ThreadsListResponse;
    setOlderPages({
      query: listQuery,
      threads: [...olderThreads, ...(page.threads ?? [])],
      nextPageToken: page.nextPageToken,
    });
  }

  async function moveThread(
    threadId: string,
    action:
      | "archive"
      | "trash"
      | "spam"
      | "move"
      | "unarchive"
      | "untrash"
      | "send-draft"
      | "discard-draft"
      | "restore-folder",
    sourceFolder?: string,
  ) {
    setArchiveError("");
    const folderQuery =
      action === "move" || !sourceFolder
        ? ""
        : `?folder=${encodeURIComponent(sourceFolder)}`;
    const response = await fetchWithAccount({
      url: `/api/threads/${encodeURIComponent(threadId)}/${action}${folderQuery}`,
      emailAccountId,
      init: {
        method: "POST",
        ...(action === "move"
          ? {
              body: JSON.stringify({ folder: sourceFolder }),
              headers: { "Content-Type": "application/json" },
            }
          : {}),
      },
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

  async function addLabel(
    threadId: string,
    messageId: string,
    labelId: string,
  ) {
    setArchiveError("");
    const response = await fetchWithAccount({
      url: `/api/threads/${encodeURIComponent(threadId)}/label`,
      emailAccountId,
      init: {
        method: "POST",
        body: JSON.stringify({ labelId, messageId }),
        headers: { "Content-Type": "application/json" },
      },
    });
    if (!response.ok) {
      setArchiveError("Could not label this email.");
      return;
    }
    await mutate();
  }

  async function removeLabel(threadId: string, labelId: string) {
    setArchiveError("");
    const response = await fetchWithAccount({
      url: `/api/threads/${encodeURIComponent(threadId)}/unlabel`,
      emailAccountId,
      init: {
        method: "POST",
        body: JSON.stringify({ labelId }),
        headers: { "Content-Type": "application/json" },
      },
    });
    if (!response.ok) {
      setArchiveError("Could not remove this label.");
      return;
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
            <PageHeading>
              {submittedSearch
                ? "Search"
                : (selected?.label ?? extra?.displayName ?? "Inbox")}
            </PageHeading>
          </div>
          <Button type="button" size="sm" onClick={openCompose}>
            Compose
          </Button>
        </div>
        <form
          className="mt-3 flex max-w-md gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setArchiveError("");
            setSubmittedSearch(search.trim());
          }}
        >
          <input
            aria-label="Search mail"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search mail"
            className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
          />
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
          {submittedSearch ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setSearch("");
                setSubmittedSearch("");
                setArchiveError("");
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
        <div className="mt-3 flex flex-wrap gap-2">
          {folders.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant={item.id === folder ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setArchiveError("");
                setSubmittedSearch("");
                setFolder(item.id);
              }}
            >
              {item.label}
            </Button>
          ))}
          {extraFolders.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant={
                mailboxFolderId(item.id) === folder ? "default" : "outline"
              }
              size="sm"
              onClick={() => {
                setArchiveError("");
                setSubmittedSearch("");
                setFolder(mailboxFolderId(item.id));
              }}
            >
              {item.displayName}
            </Button>
          ))}
        </div>
        {archiveError ? (
          <p className="mt-3 text-sm text-destructive">{archiveError}</p>
        ) : null}
        {visibleThreads.length ? (
          <ul className="mt-4 divide-y">
            {visibleThreads.map((thread) => {
              const message = thread.messages.at(-1);
              const unread =
                folder === "inbox" && message?.labelIds?.includes("UNREAD");
              const rowLabels = imapThreadLabelIds(thread.messages).map(
                (labelId) => ({
                  id: labelId,
                  name: labelNames.get(labelId) ?? labelId,
                }),
              );
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
                  {rowLabels.length ? (
                    <div className="mt-3 flex max-w-40 flex-wrap gap-1">
                      {rowLabels.map((label) => (
                        <button
                          key={label.id}
                          type="button"
                          aria-label={`Remove ${label.name} from ${message?.subject || "email"}`}
                          className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            removeLabel(thread.id, label.id).catch(
                              () => undefined,
                            );
                          }}
                        >
                          {label.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {message && labelList?.labels.length ? (
                    <select
                      aria-label={`Add label to ${message.subject || "email"}`}
                      className="mt-3 h-8 rounded-md border bg-background px-2 text-sm"
                      defaultValue=""
                      onChange={(event) => {
                        const labelId = event.target.value;
                        event.currentTarget.value = "";
                        if (!labelId) return;
                        addLabel(thread.id, message.id, labelId).catch(
                          () => undefined,
                        );
                      }}
                    >
                      <option value="">Label</option>
                      {labelList.labels.map((label) => (
                        <option key={label.id} value={label.id}>
                          {label.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {folder === "inbox" && !submittedSearch ? (
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
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => moveThread(thread.id, "spam")}
                      >
                        Spam
                      </Button>
                      {filingFolders.map((item) => (
                        <Button
                          key={item.id}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={() => moveThread(thread.id, "move", item.id)}
                        >
                          {`Move to ${item.displayName}`}
                        </Button>
                      ))}
                    </>
                  ) : null}
                  {folder === "drafts" && !submittedSearch ? (
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
                  {!submittedSearch &&
                  (folder === "archive" || folder === "trash") ? (
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
                  {extra && !submittedSearch ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() =>
                        moveThread(thread.id, "restore-folder", extra.id)
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
            {submittedSearch
              ? "No mail matches that search."
              : emptyFolderCopy(folder)}
          </p>
        )}
        {nextPageToken ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            disabled={loadingOlder}
            onClick={() => {
              loadOlderMail().catch(() => undefined);
            }}
          >
            Older mail
          </Button>
        ) : null}
      </div>
    </LoadingContent>
  );
}

function mailboxFolderId(mailbox: string) {
  return `mailbox:${mailbox}`;
}

function isStandardMailbox(name: string) {
  return ["inbox", "sent", "drafts", "archive", "trash"].includes(
    name.toLowerCase(),
  );
}

function isJunkMailbox(name: string) {
  return name.toLowerCase() === "junk" || name.toLowerCase() === "spam";
}

function moveError(
  action:
    | "archive"
    | "trash"
    | "spam"
    | "move"
    | "unarchive"
    | "untrash"
    | "send-draft"
    | "discard-draft"
    | "restore-folder",
) {
  if (action === "trash") return "Could not move this email to Trash.";
  if (action === "spam") return "Could not mark this email as spam.";
  if (action === "move") return "Could not move this email.";
  if (action === "unarchive" || action === "untrash")
    return "Could not move this email to the inbox.";
  if (action === "send-draft") return "Could not send this draft.";
  if (action === "discard-draft") return "Could not discard this draft.";
  if (action === "restore-folder")
    return "Could not move this email to the inbox.";
  return "Could not archive this email.";
}

function emptyFolderCopy(folder: string) {
  if (folder === "sent") return "Sent is empty.";
  if (folder === "drafts") return "Drafts is empty.";
  if (folder === "archive") return "Archive is empty.";
  if (folder === "trash") return "Trash is empty.";
  if (folder.startsWith("mailbox:")) return "This folder is empty.";
  return "The inbox is empty.";
}
