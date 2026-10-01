import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";
import { isThreadNotFoundError } from "@/utils/email/thread-not-found";

const paramsSchema = z.object({ id: z.string() });

export const POST = withEmailProvider(
  "threads/discard-draft",
  async (request, context) => {
    const params = await context.params;
    const { id: threadId } = paramsSchema.parse(params);

    try {
      await request.emailProvider.deleteDraft(threadId);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        return NextResponse.json({ error: "Draft not found" }, { status: 404 });
      }
      throw error;
    }

    return NextResponse.json({ success: true });
  },
);
