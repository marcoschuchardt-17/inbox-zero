import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";

const paramsSchema = z.object({ id: z.string() });

export const POST = withEmailProvider(
  "threads/read",
  async (request, context) => {
    const params = await context.params;
    const { id: threadId } = paramsSchema.parse(params);

    try {
      await request.emailProvider.markRead(threadId);
      return NextResponse.json({ success: true });
    } catch (error) {
      request.logger.error("Failed to mark thread read", {
        error,
        threadId,
        emailAccountId: request.auth.emailAccountId,
      });
      return NextResponse.json(
        { error: "Failed to mark email read" },
        { status: 500 },
      );
    }
  },
);
