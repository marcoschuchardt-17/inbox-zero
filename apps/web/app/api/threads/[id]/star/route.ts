import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";

const paramsSchema = z.object({ id: z.string() });
const bodySchema = z.object({ starred: z.boolean() });

export const POST = withEmailProvider(
  "threads/star",
  async (request, context) => {
    const params = await context.params;
    const { id: threadId } = paramsSchema.parse(params);
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Failed to star email" },
        { status: 400 },
      );
    }

    try {
      const thread = await request.emailProvider.getThread(threadId);
      const messageIds = thread.messages.map((message) => message.id);
      if (!messageIds.length) {
        return NextResponse.json(
          { error: "Thread not found" },
          { status: 404 },
        );
      }
      await request.emailProvider.markMessagesStarredState(
        messageIds,
        parsed.data.starred,
      );
      return NextResponse.json({ success: true });
    } catch (error) {
      request.logger.error("Failed to star thread", {
        error,
        threadId,
        emailAccountId: request.auth.emailAccountId,
      });
      return NextResponse.json(
        { error: "Failed to star email" },
        { status: 500 },
      );
    }
  },
);
