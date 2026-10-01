// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "./types";
import { EmailList } from "./EmailList";

const query = vi.hoisted(() => ({ setThreadId: vi.fn() }));
const source = vi.hoisted(() => ({ refetch: vi.fn() }));
const engine = vi.hoisted(() => ({
  getDiagnostics: vi.fn(),
  submitConversations: vi.fn(),
}));
const mail = vi.hoisted(() => ({
  client: engine as null | typeof engine,
}));
const account = vi.hoisted(() => ({
  emailAccountId: "account-1",
  provider: "google",
  userEmail: "user@example.com",
}));
const http = vi.hoisted(() => ({
  fetchWithAccount: vi.fn(),
}));

vi.mock("nuqs", () => ({
  useQueryState: () => [null, query.setThreadId],
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => account,
}));
vi.mock("@/utils/fetch", () => ({
  fetchWithAccount: (...args: unknown[]) => http.fetchWithAccount(...args),
}));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => mail.client,
}));
vi.mock("@/utils/queue/email-actions", () => ({ runAiRules: vi.fn() }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/Checkbox", () => ({
  Checkbox: () => null,
}));
vi.mock("@/components/ActionButtonsBulk", () => ({
  ActionButtonsBulk: () => null,
}));
vi.mock("@/components/email-list/EmailPanel", () => ({
  EmailPanel: () => null,
}));
vi.mock("@/components/email-list/EmailListItem", () => ({
  EmailListItem: ({
    onArchive,
    onClick,
    thread,
  }: {
    onArchive: (thread: Thread) => void;
    onClick: () => void;
    thread: Thread;
  }) => (
    <li>
      <button type="button" onClick={() => onArchive(thread)}>
        Archive {thread.id}
      </button>
      <button type="button" onClick={onClick}>
        Open {thread.id}
      </button>
    </li>
  ),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizableHandle: () => null,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => children,
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) =>
    children,
}));
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    promise: vi.fn((run: () => Promise<unknown>) => run()),
  },
}));

describe("EmailList durable actions", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    account.provider = "google";
    mail.client = engine;
    source.refetch.mockResolvedValue(undefined);
    engine.getDiagnostics.mockResolvedValue({ revision: 1 });
    engine.submitConversations.mockResolvedValue({ status: "queued" });
    http.fetchWithAccount.mockResolvedValue({ ok: true });
  });

  it("archives an IMAP conversation through the mailbox API", async () => {
    account.provider = "imap";
    mail.client = null;
    const thread = createThread();
    render(<EmailList refetch={source.refetch} threads={[thread]} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive thread-1" }));

    await waitFor(() =>
      expect(http.fetchWithAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/api/threads/thread-1/archive",
          emailAccountId: "account-1",
          init: { method: "POST" },
        }),
      ),
    );
    expect(source.refetch).toHaveBeenCalledWith({
      removedThreadIds: ["thread-1"],
    });
  });

  it("archives and marks unread threads read through the engine", async () => {
    const thread = {
      id: "thread-1",
      messages: [
        { id: "message-1" },
        { id: "message-2", labelIds: ["UNREAD"] },
      ],
      plan: undefined,
      plans: [],
      snippet: "Preview",
    } as unknown as Thread;
    render(<EmailList refetch={source.refetch} threads={[thread]} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive thread-1" }));
    await waitFor(() =>
      expect(engine.submitConversations).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "account-1",
          conversations: [
            { accountId: "account-1", conversationId: "thread-1" },
          ],
          change: { kind: "archive" },
        }),
      ),
    );
    expect(source.refetch).toHaveBeenCalledWith({
      removedThreadIds: ["thread-1"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Open thread-1" }));
    await waitFor(() =>
      expect(engine.submitConversations).toHaveBeenLastCalledWith(
        expect.objectContaining({
          change: { kind: "set_read", read: true },
        }),
      ),
    );
  });

  it("does not queue a read mutation for an already-read thread", () => {
    const thread = createThread();
    render(<EmailList refetch={source.refetch} threads={[thread]} />);

    fireEvent.click(screen.getByRole("button", { name: "Open thread-1" }));

    expect(engine.submitConversations).not.toHaveBeenCalled();
  });

  it("shows an empty state immediately", () => {
    render(
      <EmailList
        threads={[]}
        emptyMessage="No emails"
        hideActionBarWhenEmpty
        refetch={source.refetch}
      />,
    );

    expect(screen.getByText("No emails")).toBeTruthy();
  });
});

function createThread() {
  return {
    id: "thread-1",
    messages: [{ id: "message-1", labelIds: ["INBOX"] }],
    plan: undefined,
    plans: [],
    snippet: "Preview",
  } as unknown as Thread;
}
