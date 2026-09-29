import type { CleanThread } from "@/utils/redis/clean.types";

type CleanupRow = {
  threadId: string;
  archived: boolean;
  createdAt: Date;
};

type LoadedMessage = {
  subject: string;
  snippet: string;
  date: string;
  headers: { from: string };
};

export async function cleanupThreadsForDisplay({
  emailAccountId,
  jobId,
  rows,
  loadThread,
}: {
  emailAccountId: string;
  jobId: string;
  rows: CleanupRow[];
  loadThread: (
    threadId: string,
  ) => Promise<{ messages: LoadedMessage[] } | null>;
}): Promise<CleanThread[]> {
  const threads: CleanThread[] = [];

  for (const row of rows) {
    const loaded = await loadThread(row.threadId);
    const latest = loaded?.messages.at(-1);
    threads.push({
      emailAccountId,
      threadId: row.threadId,
      jobId,
      status: "completed",
      createdAt: row.createdAt.toISOString(),
      from: latest?.headers.from ?? "",
      subject: latest?.subject || row.threadId,
      snippet: latest?.snippet ?? "",
      date: latest ? new Date(latest.date) : row.createdAt,
      archive: row.archived,
    });
  }

  return threads;
}
