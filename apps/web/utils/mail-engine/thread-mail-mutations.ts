import { getActiveMailClient } from "@/utils/mail-engine/active-client";
import {
  mutationPayloadToChange,
  type ThreadMutationPayload,
} from "@/utils/mail-engine/mutation-change";
import { submitConversationChange } from "@/utils/mail-engine/submit-conversations";
import { admissionRejectionCopy } from "@/utils/mail-engine/admission-notice";
import { isImapProvider } from "@/utils/email/provider-types";
import { fetchWithAccount } from "@/utils/fetch";
import { randomUuid } from "@/utils/uuid";

type ThreadMailMutationTarget = {
  id: string;
  messages: readonly { id: string }[];
};

export type ThreadMailMutation = ThreadMutationPayload & {
  id: string;
  batchId: string;
  clientSource?: { kind: "sender"; sender: string };
  emailAccountId: string;
  threadId: string;
  messageIds: string[];
  status: "succeeded";
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
};

export async function enqueueThreadMailMutationBatch(
  {
    batchId = randomUuid(),
    clientSource,
    emailAccountId,
    provider,
    payload,
    threads,
  }: {
    batchId?: string;
    clientSource?: { kind: "sender"; sender: string };
    emailAccountId: string;
    provider?: string;
    payload: ThreadMutationPayload;
    threads: readonly ThreadMailMutationTarget[];
  },
  now = Date.now(),
) {
  const targets = threads.map((thread) => {
    const messageIds = [
      ...new Set(thread.messages.map((message) => message.id)),
    ];
    if (!thread.id || messageIds.length === 0 || messageIds.some((id) => !id)) {
      throw new Error(
        `Cannot queue mail mutation without a complete snapshot for thread ${thread.id || "unknown"}`,
      );
    }
    return { messageIds, threadId: thread.id };
  });
  if (!targets.length)
    return { batchId, mutations: [] as ThreadMailMutation[] };

  if (isImapProvider(provider)) {
    return submitImapHttpBatch({
      batchId,
      clientSource,
      emailAccountId,
      now,
      payload,
      targets,
    });
  }

  const client = await waitForActiveMailClient();
  const change = mutationPayloadToChange(payload);
  if (!change) {
    throw new Error("Unsupported mail mutation");
  }

  const mutations: ThreadMailMutation[] = [];
  for (const target of targets) {
    const { admission, commandId } = await submitConversationChange({
      accountId: emailAccountId,
      change,
      client,
      conversationId: target.threadId,
    });
    if (admission.status === "rejected") {
      const copy = admissionRejectionCopy(admission.code);
      if (copy) throw new Error(copy);
      continue;
    }
    mutations.push({
      id: commandId,
      batchId,
      clientSource,
      emailAccountId,
      threadId: target.threadId,
      messageIds: target.messageIds,
      ...payload,
      status: "succeeded",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { batchId, mutations };
}

const ENGINE_WAIT_MS = 30_000;
const ENGINE_POLL_MS = 25;

async function submitImapHttpBatch({
  batchId,
  clientSource,
  emailAccountId,
  now,
  payload,
  targets,
}: {
  batchId: string;
  clientSource?: { kind: "sender"; sender: string };
  emailAccountId: string;
  now: number;
  payload: ThreadMutationPayload;
  targets: { messageIds: string[]; threadId: string }[];
}) {
  const action = httpActionForPayload(payload);
  if (!action) throw new Error("Unsupported mail mutation");

  const mutations: ThreadMailMutation[] = [];
  for (const target of targets) {
    const response = await fetchWithAccount({
      url: `/api/threads/${encodeURIComponent(target.threadId)}/${action}`,
      emailAccountId,
      init: { method: "POST" },
    });
    if (!response.ok) throw new Error(httpFailureCopy(action));
    mutations.push({
      id: randomUuid(),
      batchId,
      clientSource,
      emailAccountId,
      threadId: target.threadId,
      messageIds: target.messageIds,
      ...payload,
      status: "succeeded",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { batchId, mutations };
}

function httpActionForPayload(payload: ThreadMutationPayload) {
  switch (payload.kind) {
    case "archive":
      return "archive";
    case "unarchive":
      return "unarchive";
    case "trash":
      return "trash";
    case "untrash":
      return "untrash";
    default:
      return null;
  }
}

function httpFailureCopy(action: string) {
  if (action === "archive") return "Failed to archive email";
  if (action === "trash") return "Failed to trash email";
  return "Failed to update email";
}

async function waitForActiveMailClient() {
  const deadline = Date.now() + ENGINE_WAIT_MS;
  for (;;) {
    const client = getActiveMailClient();
    if (client) return client;
    if (Date.now() >= deadline) {
      throw new Error("Mail engine is unavailable");
    }
    await new Promise((resolve) => setTimeout(resolve, ENGINE_POLL_MS));
  }
}
