import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueThreadMailMutationBatch } from "./thread-mail-mutations";
import { admissionRejectionCopy } from "./admission-notice";

const mail = vi.hoisted(() => ({
  current: null as null | {
    getDiagnostics: ReturnType<typeof vi.fn>;
    submitConversations: ReturnType<typeof vi.fn>;
  },
  client: {
    getDiagnostics: vi.fn(),
    submitConversations: vi.fn(),
  },
}));

const http = vi.hoisted(() => ({
  fetchWithAccount: vi.fn(),
}));

vi.mock("@/utils/mail-engine/active-client", () => ({
  getActiveMailClient: () => mail.current,
}));

vi.mock("@/utils/fetch", () => ({
  fetchWithAccount: (...args: unknown[]) => http.fetchWithAccount(...args),
}));

describe("thread mail mutation batches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mail.current = mail.client;
    mail.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mail.client.submitConversations.mockResolvedValue({ status: "queued" });
    http.fetchWithAccount.mockResolvedValue({ ok: true });
  });

  it("submits each complete thread snapshot through the engine", async () => {
    const result = await enqueueThreadMailMutationBatch(
      {
        clientSource: { kind: "sender", sender: "news@example.com" },
        emailAccountId: "account",
        threads: [
          {
            id: "thread-1",
            messages: [
              { id: "message-1" },
              { id: "message-1" },
              { id: "message-2" },
            ],
          },
          { id: "thread-2", messages: [{ id: "message-3" }] },
        ],
        payload: { kind: "archive", labelId: "label" },
      },
      10,
    );

    expect(result.mutations).toMatchObject([
      {
        batchId: result.batchId,
        clientSource: { kind: "sender", sender: "news@example.com" },
        emailAccountId: "account",
        threadId: "thread-1",
        messageIds: ["message-1", "message-2"],
        labelId: "label",
        status: "succeeded",
      },
      {
        batchId: result.batchId,
        clientSource: { kind: "sender", sender: "news@example.com" },
        emailAccountId: "account",
        threadId: "thread-2",
        messageIds: ["message-3"],
        labelId: "label",
        status: "succeeded",
      },
    ]);
    expect(mail.client.submitConversations).toHaveBeenCalledTimes(2);
  });

  it("archives IMAP threads over HTTP without waiting for the mail engine", async () => {
    mail.current = null;
    const result = await enqueueThreadMailMutationBatch(
      {
        clientSource: { kind: "sender", sender: "receipts@example.com" },
        emailAccountId: "account",
        provider: "imap",
        threads: [
          { id: "thread-1", messages: [{ id: "message-1" }] },
          { id: "thread-2", messages: [{ id: "message-2" }] },
        ],
        payload: { kind: "archive" },
      },
      10,
    );

    expect(http.fetchWithAccount).toHaveBeenNthCalledWith(1, {
      url: "/api/threads/thread-1/archive",
      emailAccountId: "account",
      init: { method: "POST" },
    });
    expect(http.fetchWithAccount).toHaveBeenNthCalledWith(2, {
      url: "/api/threads/thread-2/archive",
      emailAccountId: "account",
      init: { method: "POST" },
    });
    expect(mail.client.submitConversations).not.toHaveBeenCalled();
    expect(result.mutations).toMatchObject([
      {
        emailAccountId: "account",
        threadId: "thread-1",
        messageIds: ["message-1"],
        status: "succeeded",
      },
      {
        emailAccountId: "account",
        threadId: "thread-2",
        messageIds: ["message-2"],
        status: "succeeded",
      },
    ]);
  });

  it("marks IMAP threads read over HTTP without waiting for the mail engine", async () => {
    mail.current = null;
    const result = await enqueueThreadMailMutationBatch(
      {
        emailAccountId: "account",
        provider: "imap",
        threads: [{ id: "thread-1", messages: [{ id: "message-1" }] }],
        payload: { kind: "set_read_state", read: true },
      },
      10,
    );

    expect(http.fetchWithAccount).toHaveBeenCalledWith({
      url: "/api/threads/thread-1/read",
      emailAccountId: "account",
      init: { method: "POST" },
    });
    expect(mail.client.submitConversations).not.toHaveBeenCalled();
    expect(result.mutations).toMatchObject([
      { threadId: "thread-1", read: true, status: "succeeded" },
    ]);
  });

  it("marks an IMAP thread unread over HTTP", async () => {
    mail.current = null;
    const result = await enqueueThreadMailMutationBatch(
      {
        emailAccountId: "account",
        provider: "imap",
        threads: [{ id: "thread-1", messages: [{ id: "INBOX/1" }] }],
        payload: { kind: "set_read_state", read: false },
      },
      10,
    );

    expect(http.fetchWithAccount).toHaveBeenCalledWith({
      url: "/api/threads/thread-1/unread",
      emailAccountId: "account",
      init: { method: "POST" },
    });
    expect(mail.client.submitConversations).not.toHaveBeenCalled();
    expect(result.mutations).toMatchObject([
      { threadId: "thread-1", read: false, status: "succeeded" },
    ]);
  });

  it("stars an IMAP thread over HTTP without waiting for the mail engine", async () => {
    mail.current = null;
    const result = await enqueueThreadMailMutationBatch(
      {
        emailAccountId: "account",
        provider: "imap",
        threads: [{ id: "<note@example.com>", messages: [{ id: "INBOX/4" }] }],
        payload: { kind: "set_starred_state", starred: false },
      },
      10,
    );

    expect(http.fetchWithAccount).toHaveBeenCalledWith({
      url: "/api/threads/%3Cnote%40example.com%3E/star",
      emailAccountId: "account",
      init: {
        method: "POST",
        body: JSON.stringify({ starred: false }),
        headers: { "Content-Type": "application/json" },
      },
    });
    expect(mail.client.submitConversations).not.toHaveBeenCalled();
    expect(result.mutations).toMatchObject([
      { threadId: "<note@example.com>", starred: false, status: "succeeded" },
    ]);
  });

  it("reports a failed IMAP archive without waiting for the mail engine", async () => {
    mail.current = null;
    http.fetchWithAccount.mockResolvedValue({ ok: false });

    await expect(
      enqueueThreadMailMutationBatch({
        emailAccountId: "account",
        provider: "imap",
        threads: [{ id: "thread-1", messages: [{ id: "message-1" }] }],
        payload: { kind: "archive" },
      }),
    ).rejects.toThrow("Failed to archive email");
    expect(mail.client.submitConversations).not.toHaveBeenCalled();
  });

  it("waits until the mail engine is published", async () => {
    mail.current = null;
    const pending = enqueueThreadMailMutationBatch({
      emailAccountId: "account",
      threads: [{ id: "thread-1", messages: [{ id: "message-1" }] }],
      payload: { kind: "archive" },
    });
    queueMicrotask(() => {
      mail.current = mail.client;
    });
    await pending;
    expect(mail.client.submitConversations).toHaveBeenCalledTimes(1);
  });

  it("rejects an incomplete snapshot before submitting any thread", async () => {
    await expect(
      enqueueThreadMailMutationBatch({
        emailAccountId: "account",
        threads: [
          { id: "valid-thread", messages: [{ id: "message" }] },
          { id: "empty-thread", messages: [] },
        ],
        payload: { kind: "trash" },
      }),
    ).rejects.toThrow("empty-thread");
    expect(mail.client.submitConversations).not.toHaveBeenCalled();
  });

  it("returns an empty durable batch without contacting the engine", async () => {
    const result = await enqueueThreadMailMutationBatch({
      batchId: "empty-batch",
      emailAccountId: "account",
      threads: [],
      payload: { kind: "archive" },
    });

    expect(result).toEqual({ batchId: "empty-batch", mutations: [] });
    expect(mail.client.submitConversations).not.toHaveBeenCalled();
  });

  it("throws when the local command queue is full", async () => {
    mail.client.submitConversations.mockResolvedValue({
      status: "rejected",
      code: "queue_full",
    });
    await expect(
      enqueueThreadMailMutationBatch({
        emailAccountId: "account",
        threads: [{ id: "thread-1", messages: [{ id: "message-1" }] }],
        payload: { kind: "archive" },
      }),
    ).rejects.toThrow(admissionRejectionCopy("queue_full"));
  });
});
