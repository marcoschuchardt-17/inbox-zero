"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { useQueryState } from "nuqs";
import Link from "next/link";
import useSWR from "swr";
import { LoadingContent } from "@/components/LoadingContent";
import { PageHeading } from "@/components/Typography";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { AlertCircle } from "lucide-react";
import { useDisplayedEmail } from "@/hooks/useDisplayedEmail";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useComposeModal } from "@/providers/ComposeModalProvider";
import type { ThreadsListResponse } from "@/app/api/threads/route";
import type { GetFoldersResponse } from "@/app/api/user/folders/route";
import { fetchWithAccount } from "@/utils/fetch";
import { formatShortDate } from "@/utils/date";
import { getThreadParticipantNames } from "@/app/(app)/[emailAccountId]/mail/thread-participants";
import {
  imapListLocation,
  imapListMessage,
  imapMessageIsUnread,
  imapMessageMailbox,
  imapThreadIsStarred,
  imapThreadIsUnread,
  imapSearchRestoreAction,
  imapVisibleThreadLabelIds,
} from "@/utils/email/imap-flags";
import { prefixPath } from "@/utils/path";
import type { LabelsResponse } from "@/app/api/labels/route";
import { syncImapMailboxAction } from "@/utils/actions/imap-sync";
import {
  createLabelAction,
  deleteMailboxItemAction,
  updateMailboxItemAction,
} from "@/utils/actions/mail";
import { imapConnectionErrorMessage } from "@/utils/email/imap-connection-error";
import { getActionErrorMessage } from "@/utils/error";

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
  const { emailAccountId, userEmail } = useAccount();
  const { onOpen: openCompose } = useComposeModal();
  const [folder, setFolder] = useState("inbox");
  const [queryParam, setQueryParam] = useQueryState("q");
  const [search, setSearch] = useState(queryParam ?? "");
  const submittedSearch = queryParam?.trim() ?? "";
  const { data: mailboxList } = useSWR<GetFoldersResponse>("/api/user/folders");
  const { data: labelList, mutate: mutateLabels } =
    useSWR<LabelsResponse>("/api/labels");
  const labelNames = new Map(
    (labelList?.labels ?? []).map((label) => [label.id, label.name]),
  );
  const extraFolders = (mailboxList ?? []).filter(
    (item) =>
      !isStandardMailbox(item.id) &&
      !isStandardMailbox(item.displayName) &&
      !isDedicatedMailbox(item.systemType),
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
  const syncedAccountId = useRef("");

  useEffect(() => {
    if (!emailAccountId || syncedAccountId.current === emailAccountId) return;
    syncedAccountId.current = emailAccountId;
    syncImapMailboxAction(emailAccountId)
      .then((result) => {
        if (!result?.data?.synced) return;
        return mutate();
      })
      .catch(() => undefined);
  }, [emailAccountId, mutate]);

  async function toggleStar(threadId: string, starred: boolean) {
    setArchiveError("");
    const response = await fetchWithAccount({
      url: `/api/threads/${encodeURIComponent(threadId)}/star`,
      emailAccountId,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starred }),
      },
    });
    if (!response.ok) {
      setArchiveError(
        starred
          ? "Could not star this email."
          : "Could not remove the star from this email.",
      );
      return;
    }
    await mutate();
  }

  async function markOpenedThreadRead(threadId: string, messageId?: string) {
    const response = await fetchWithAccount({
      url: `/api/threads/${encodeURIComponent(threadId)}/read`,
      emailAccountId,
      init: {
        method: "POST",
        ...(messageId
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ messageId }),
            }
          : {}),
      },
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

  const connectionError = imapConnectionErrorMessage(error);

  return (
    <LoadingContent
      loading={isLoading}
      error={error}
      errorComponent={
        connectionError ? (
          <ImapConnectionError
            message={connectionError}
            emailAccountId={emailAccountId}
          />
        ) : undefined
      }
    >
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
            const next = search.trim();
            setSearch(next);
            setQueryParam(next || null).catch(() => undefined);
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
                setArchiveError("");
                setQueryParam(null).catch(() => undefined);
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
              variant={
                !submittedSearch && item.id === folder ? "default" : "outline"
              }
              size="sm"
              onClick={() => {
                setArchiveError("");
                setSearch("");
                setQueryParam(null).catch(() => undefined);
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
                !submittedSearch && mailboxFolderId(item.id) === folder
                  ? "default"
                  : "outline"
              }
              size="sm"
              onClick={() => {
                setArchiveError("");
                setSearch("");
                setQueryParam(null).catch(() => undefined);
                setFolder(mailboxFolderId(item.id));
              }}
            >
              {item.displayName}
            </Button>
          ))}
        </div>
        <ImapLabelManager
          emailAccountId={emailAccountId}
          labels={labelList?.labels ?? []}
          onChanged={mutateLabels}
        />
        {archiveError ? (
          <p className="mt-3 text-sm text-destructive">{archiveError}</p>
        ) : null}
        {visibleThreads.length ? (
          <ul className="mt-4 divide-y">
            {visibleThreads.map((thread) => {
              const message = imapListMessage(thread.messages);
              const sender =
                getThreadParticipantNames(thread.messages, userEmail).join(
                  ", ",
                ) || "Unknown sender";
              const sentAt = message?.headers.date
                ? new Date(message.headers.date)
                : null;
              const when =
                sentAt && !Number.isNaN(sentAt.getTime())
                  ? formatShortDate(sentAt)
                  : "";
              const mailbox = imapMessageMailbox(message?.id);
              const location = imapListLocation(mailbox);
              const messageInInbox = submittedSearch
                ? location === "inbox"
                : folder === "inbox";
              const unread = imapThreadIsUnread(thread.messages);
              const starred = imapThreadIsStarred(thread.messages);
              const searchRestore = submittedSearch
                ? imapSearchRestoreAction(message?.id)
                : null;
              const rowLabels = imapVisibleThreadLabelIds(
                thread.messages,
                new Set(labelNames.keys()),
              ).map((labelId) => ({
                id: labelId,
                name: labelNames.get(labelId) ?? labelId,
              }));
              return (
                <li key={thread.id} className="flex flex-col">
                  <button
                    type="button"
                    className="w-full min-w-0 px-2 py-3 text-left hover:bg-muted"
                    onClick={() => {
                      showEmail({
                        threadId: thread.id,
                        messageId: message?.id,
                      });
                      if (unread) {
                        const unreadIds = messageInInbox
                          ? [undefined]
                          : thread.messages
                              .filter((item) =>
                                imapMessageIsUnread(item.labelIds),
                              )
                              .map((item) => item.id);
                        Promise.all(
                          unreadIds.map((id) =>
                            markOpenedThreadRead(thread.id, id),
                          ),
                        ).catch(() => undefined);
                      }
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div
                        className={
                          unread
                            ? "truncate font-semibold"
                            : "truncate font-medium"
                        }
                      >
                        {sender}
                        {submittedSearch && location !== "inbox" && mailbox ? (
                          <span className="ml-2 font-normal text-xs text-muted-foreground">
                            {mailbox}
                          </span>
                        ) : null}
                        {unread ? (
                          <span className="ml-2 font-normal text-xs text-muted-foreground">
                            Unread
                          </span>
                        ) : null}
                        {starred ? (
                          <span className="ml-2 font-normal text-xs text-muted-foreground">
                            Starred
                          </span>
                        ) : null}
                      </div>
                      {when ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {when}
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
                  <div className="flex flex-wrap items-center gap-2 px-2 pb-3">
                    {rowLabels.map((label) => (
                      <button
                        key={label.id}
                        type="button"
                        aria-label={`Remove ${label.name} from ${message?.subject || "email"}`}
                        className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          removeLabel(thread.id, label.id).catch(
                            () => undefined,
                          );
                        }}
                      >
                        {label.name}
                      </button>
                    ))}
                    {message && labelList?.labels.length ? (
                      <select
                        aria-label={`Add label to ${message.subject || "email"}`}
                        className="h-8 rounded-md border bg-background px-2 text-sm"
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
                    {message ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => toggleStar(thread.id, !starred)}
                      >
                        {starred ? "Unstar" : "Star"}
                      </Button>
                    ) : null}
                    {messageInInbox ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => moveThread(thread.id, "archive")}
                        >
                          Archive
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => moveThread(thread.id, "trash")}
                        >
                          Trash
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
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
                            onClick={() =>
                              moveThread(thread.id, "move", item.id)
                            }
                          >
                            {`Move to ${item.displayName}`}
                          </Button>
                        ))}
                      </>
                    ) : null}
                    {(
                      submittedSearch
                        ? location === "drafts"
                        : folder === "drafts"
                    ) ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => moveThread(thread.id, "send-draft")}
                        >
                          Send
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
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
                    {searchRestore ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          moveThread(
                            thread.id,
                            searchRestore,
                            searchRestore === "restore-folder"
                              ? mailbox
                              : undefined,
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
                        onClick={() =>
                          moveThread(thread.id, "restore-folder", extra.id)
                        }
                      >
                        Move to inbox
                      </Button>
                    ) : null}
                  </div>
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

function ImapConnectionError({
  message,
  emailAccountId,
}: {
  message: string;
  emailAccountId?: string;
}) {
  const settingsHref = emailAccountId
    ? `/accounts/imap?emailAccountId=${emailAccountId}`
    : "/accounts/imap";

  return (
    <div className="p-4">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-destructive/10">
            <AlertCircle className="text-destructive" />
          </EmptyMedia>
          <EmptyTitle>There was an error</EmptyTitle>
          <EmptyDescription>{message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline" size="sm">
            <Link href={settingsHref}>Update mailbox settings</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

function ImapLabelManager({
  emailAccountId,
  labels,
  onChanged,
}: {
  emailAccountId: string;
  labels: { id: string; name: string }[];
  onChanged: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ordered = [...labels].sort((a, b) => a.name.localeCompare(b.name));

  async function createLabel(event: FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (!next || busy) return;
    setBusy(true);
    setError("");
    const result = await createLabelAction(emailAccountId, { name: next });
    setBusy(false);
    if (result?.serverError || result?.validationErrors) {
      setError(getActionErrorMessage(result));
      return;
    }
    setName("");
    await onChanged();
  }

  async function renameLabel(id: string) {
    const next = editName.trim();
    if (!next || busy) return;
    setBusy(true);
    setError("");
    const result = await updateMailboxItemAction(emailAccountId, {
      kind: "label",
      id,
      name: next,
    });
    setBusy(false);
    if (result?.serverError || result?.validationErrors) {
      setError(getActionErrorMessage(result));
      return;
    }
    setEditingId(null);
    await onChanged();
  }

  async function deleteLabel(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await deleteMailboxItemAction(emailAccountId, {
      kind: "label",
      id,
    });
    setBusy(false);
    if (result?.serverError || result?.validationErrors) {
      setError(getActionErrorMessage(result));
      return;
    }
    setConfirmDeleteId(null);
    await onChanged();
  }

  return (
    <div className="mt-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Labels
      </Button>
      {open ? (
        <div className="mt-2 max-w-md rounded-md border p-3">
          <form className="flex gap-2" onSubmit={createLabel}>
            <input
              aria-label="New label name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Label name"
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            />
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>
              Add
            </Button>
          </form>
          {error ? (
            <p className="mt-2 text-sm text-destructive">{error}</p>
          ) : null}
          <ul className="mt-2 flex flex-col gap-1">
            {ordered.map((label) => (
              <li key={label.id} className="flex flex-col gap-1 text-sm">
                {editingId === label.id ? (
                  <div className="flex gap-2">
                    <input
                      aria-label={`Label name for ${label.name}`}
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !editName.trim()}
                      onClick={() => {
                        renameLabel(label.id).catch(() => undefined);
                      }}
                    >
                      Save label
                    </Button>
                  </div>
                ) : (
                  <span>{label.name}</span>
                )}
                <div className="flex flex-wrap gap-2">
                  {editingId === label.id ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(label.id);
                        setEditName(label.name);
                        setConfirmDeleteId(null);
                      }}
                    >
                      {`Rename ${label.name}`}
                    </Button>
                  )}
                  {confirmDeleteId === label.id ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        deleteLabel(label.id).catch(() => undefined);
                      }}
                    >
                      {`Delete ${label.name} now`}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setConfirmDeleteId(label.id);
                        setEditingId(null);
                      }}
                    >
                      {`Delete ${label.name}`}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
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

function isDedicatedMailbox(systemType: string | undefined) {
  return (
    systemType === "SENT" ||
    systemType === "DRAFT" ||
    systemType === "ARCHIVE" ||
    systemType === "TRASH"
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
