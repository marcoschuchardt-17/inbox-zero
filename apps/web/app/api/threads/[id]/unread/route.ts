import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";

const paramsSchema = z.object({ id: z.string() });

export const POST = withEmailProvider(
  "threads/unread",
  async (request, context) => {
    const params = await context.params;
    const { id: threadId } = paramsSchema.parse(params);

    try {
      await request.emailProvider.markReadThread(threadId, false);
      return NextResponse.json({ success: true });
    } catch (error) {
      request.logger.error("Failed to mark thread unread", {
        error,
        threadId,
        emailAccountId: request.auth.emailAccountId,
      });
      return NextResponse.json(
        { error: "Failed to mark email unread" },
        { status: 500 },
      );
    }
  },
);
