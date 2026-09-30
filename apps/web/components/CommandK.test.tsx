// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutHandlers } from "@/lib/shortcuts/registry";
import { CommandK } from "./CommandK";
import { admissionRejectionCopy } from "@/utils/mail-engine/admission-notice";

const displayedEmail = vi.hoisted(() => ({
  showEmail: vi.fn(),
  threadId: "thread-1" as string | null,
}));
const thread = vi.hoisted(() => ({
  data: {
    thread: {
      id: "thread-1",
      messages: [{ id: "message-1" }, { id: "message-2" }],
    },
  } as { thread: { id: string; messages: { id: string }[] } } | undefined,
  isLoading: false,
}));
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
}));
const http = vi.hoisted(() => ({
  fetchWithAccount: vi.fn(),
}));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => mail.client,
}));
const notifications = vi.hoisted(() => ({ error: vi.fn() }));
const shortcuts = vi.hoisted(() => ({
  handlers: undefined as ShortcutHandlers | undefined,
}));

vi.mock("@/components/AccountCommandList", () => ({
  AccountCommandList: () => null,
}));
vi.mock("@/hooks/useDisplayedEmail", () => ({
  useDisplayedEmail: () => ({
    threadId: displayedEmail.threadId,
    showEmail: displayedEmail.showEmail,
  }),
}));
vi.mock("@/hooks/useThread", () => ({
  useThread: () => ({ data: thread.data, isLoading: thread.isLoading }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => account,
}));
vi.mock("@/utils/fetch", () => ({
  fetchWithAccount: (...args: unknown[]) => http.fetchWithAccount(...args),
}));
vi.mock("@/providers/ComposeModalProvider", () => ({
  useComposeModal: () => ({ onOpen: vi.fn() }),
}));
vi.mock("@/components/Toast", () => ({ toastError: notifications.error }));
vi.mock("@/hooks/useCommandPaletteCommands", () => ({
  useCommandPaletteCommands: () => ({ commands: [], isLoading: false }),
}));
vi.mock("@/lib/shortcuts/useShortcuts", () => ({
  useShortcuts: (handlers: ShortcutHandlers) => {
    shortcuts.handlers = handlers;
  },
}));
vi.mock("@/lib/shortcuts/ShortcutsProvider", () => ({
  ShortcutsProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/shortcuts/registry", () => ({
  buildShortcutPaletteCommands: () => [],
  MAIL_SHORTCUT_SCOPES: [],
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/mail-command-palette", () => ({
  buildMailCommandPalette: () => [],
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/ShortcutsDialog", () => ({
  ShortcutsDialog: () => null,
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/snooze-command-palette", () => ({
  buildSnoozeCommandPalette: () => [],
}));
vi.mock("@/lib/commands/fuzzy-search", () => ({ fuzzySearch: () => [] }));
vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({ children }: { children: React.ReactNode }) => children,
  CommandEmpty: () => null,
  CommandGroup: ({ children }: { children: React.ReactNode }) => children,
  CommandInput: () => null,
  CommandItem: ({ children }: { children: React.ReactNode }) => children,
  CommandList: ({ children }: { children: React.ReactNode }) => children,
  CommandSeparator: () => null,
  CommandShortcut: () => null,
}));

describe("CommandK side-panel actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    displayedEmail.threadId = "thread-1";
    thread.data = {
      thread: {
        id: "thread-1",
        messages: [{ id: "message-1" }, { id: "message-2" }],
      },
    };
    thread.isLoading = false;
    account.provider = "google";
    mail.client = engine;
    engine.getDiagnostics.mockResolvedValue({ revision: 1 });
    engine.submitConversations.mockResolvedValue({ status: "queued" });
    http.fetchWithAccount.mockResolvedValue({ ok: true });
    shortcuts.handlers = undefined;
  });

  afterEach(cleanup);

  it("queues archive through the engine before closing the viewer", async () => {
    const persisted = Promise.withResolvers<{ status: string }>();
    mail.client.submitConversations.mockReturnValue(persisted.promise);
    render(<CommandK />);

    let archive: Promise<void> | undefined;
    act(() => {
      archive = shortcuts.handlers?.archive?.() as Promise<void> | undefined;
    });

    await waitFor(() =>
      expect(mail.client.submitConversations).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "account-1",
          conversations: [
            { accountId: "account-1", conversationId: "thread-1" },
          ],
          change: { kind: "archive" },
        }),
      ),
    );
    expect(displayedEmail.showEmail).not.toHaveBeenCalled();

    persisted.resolve({ status: "queued" });
    await act(async () => archive);
    expect(displayedEmail.showEmail).toHaveBeenCalledWith(null);
  });

  it("keeps the viewer open when durable storage fails", async () => {
    mail.client.submitConversations.mockRejectedValue(
      new Error("storage unavailable"),
    );
    render(<CommandK />);

    await act(async () => shortcuts.handlers?.archive?.());

    expect(displayedEmail.showEmail).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith({
      description: "Couldn't queue archiving this email",
    });
  });

  it("explains a full command queue instead of a generic archive failure", async () => {
    mail.client.submitConversations.mockResolvedValue({
      status: "rejected",
      code: "queue_full",
    });
    render(<CommandK />);

    await act(async () => shortcuts.handlers?.archive?.());

    expect(displayedEmail.showEmail).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith({
      description: admissionRejectionCopy("queue_full"),
    });
  });

  it("keeps star bound while the side-panel thread is loading", async () => {
    thread.data = undefined;
    thread.isLoading = true;
    render(<CommandK />);
    await act(async () => shortcuts.handlers?.star?.());
    expect(mail.client.submitConversations).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith({
      description: "Email is still loading",
    });
  });

  it("stars the displayed thread through the engine", async () => {
    render(<CommandK />);
    await act(async () => shortcuts.handlers?.star?.());
    expect(mail.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        change: { kind: "set_starred", starred: true },
      }),
    );
  });

  it("keeps archive bound while the full thread snapshot is loading", async () => {
    thread.data = undefined;
    thread.isLoading = true;
    render(<CommandK />);

    expect(shortcuts.handlers?.archive).toBeTypeOf("function");

    await act(async () => shortcuts.handlers?.archive?.());

    expect(mail.client.submitConversations).not.toHaveBeenCalled();
    expect(displayedEmail.showEmail).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith({
      description: "Email is still loading",
    });
  });

  it("archives an IMAP conversation through the mailbox API", async () => {
    account.provider = "imap";
    mail.client = null;
    render(<CommandK />);

    await act(async () => shortcuts.handlers?.archive?.());

    expect(http.fetchWithAccount).toHaveBeenCalledWith({
      url: "/api/threads/thread-1/archive",
      emailAccountId: "account-1",
      init: { method: "POST" },
    });
    expect(engine.submitConversations).not.toHaveBeenCalled();
    expect(displayedEmail.showEmail).toHaveBeenCalledWith(null);
  });

  it("stars an IMAP conversation through the mailbox API", async () => {
    account.provider = "imap";
    mail.client = null;
    render(<CommandK />);

    await act(async () => shortcuts.handlers?.star?.());

    expect(http.fetchWithAccount).toHaveBeenCalledWith({
      url: "/api/threads/thread-1/star",
      emailAccountId: "account-1",
      init: {
        method: "POST",
        body: JSON.stringify({ starred: true }),
        headers: { "Content-Type": "application/json" },
      },
    });
    expect(engine.submitConversations).not.toHaveBeenCalled();
    expect(displayedEmail.showEmail).not.toHaveBeenCalled();
  });

  it("marks an open IMAP message as spam through the mailbox API", async () => {
    account.provider = "imap";
    mail.client = null;
    render(<CommandK />);

    await act(async () => shortcuts.handlers?.markSpam?.());

    expect(http.fetchWithAccount).toHaveBeenCalledWith({
      url: "/api/threads/thread-1/spam",
      emailAccountId: "account-1",
      init: { method: "POST" },
    });
    expect(engine.submitConversations).not.toHaveBeenCalled();
    expect(displayedEmail.showEmail).toHaveBeenCalledWith(null);
  });

  it("marks an open IMAP message unread through the mailbox API", async () => {
    account.provider = "imap";
    mail.client = null;
    render(<CommandK />);

    await act(async () => shortcuts.handlers?.markUnread?.());

    expect(http.fetchWithAccount).toHaveBeenCalledWith({
      url: "/api/threads/thread-1/unread",
      emailAccountId: "account-1",
      init: { method: "POST" },
    });
    expect(engine.submitConversations).not.toHaveBeenCalled();
    expect(displayedEmail.showEmail).not.toHaveBeenCalled();
  });

  it("moves an open IMAP message to Trash through the mailbox API", async () => {
    account.provider = "imap";
    mail.client = null;
    render(<CommandK />);

    await act(async () => shortcuts.handlers?.delete?.());

    expect(http.fetchWithAccount).toHaveBeenCalledWith({
      url: "/api/threads/thread-1/trash",
      emailAccountId: "account-1",
      init: { method: "POST" },
    });
    expect(engine.submitConversations).not.toHaveBeenCalled();
    expect(displayedEmail.showEmail).toHaveBeenCalledWith(null);
  });

  it("opens a reply to everyone for the latest side-panel message", () => {
    render(<CommandK />);

    act(() => shortcuts.handlers?.replyAll?.());

    expect(displayedEmail.showEmail).toHaveBeenCalledWith({
      threadId: "thread-1",
      autoOpenReplyForMessageId: "message-2",
      replyAll: true,
      showReplyButton: true,
    });
  });

  it("opens a forward composer for the latest side-panel message", () => {
    render(<CommandK />);

    act(() => shortcuts.handlers?.forward?.());

    expect(displayedEmail.showEmail).toHaveBeenCalledWith({
      threadId: "thread-1",
      autoOpenForwardForMessageId: "message-2",
      showReplyButton: true,
    });
  });
});
