import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";
import { isThreadNotFoundError } from "@/utils/email/thread-not-found";
import { SafeError } from "@/utils/error";
import type { EmailProvider } from "@/utils/email/types";

const paramsSchema = z.object({ id: z.string() });

type ImapFolderRestore = EmailProvider & {
  restoreThreadFromMailbox(
    threadId: string,
    sourceMailbox: string,
  ): Promise<void>;
};

export const POST = withEmailProvider(
  "threads/restore-folder",
  async (request, context) => {
    const params = await context.params;
    const { id: threadId } = paramsSchema.parse(params);
    const folder = new URL(request.url).searchParams.get("folder")?.trim();
    if (!folder) throw new SafeError("Folder is required");
    if (request.emailProvider.name !== "imap") {
      throw new SafeError("Only an IMAP mailbox can be restored this way.");
    }

    try {
      await (
        request.emailProvider as ImapFolderRestore
      ).restoreThreadFromMailbox(threadId, folder);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        return NextResponse.json(
          { error: "Thread not found" },
          { status: 404 },
        );
      }
      throw error;
    }

    return NextResponse.json({ success: true });
  },
);
