import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";

const paramsSchema = z.object({ id: z.string() });

export const POST = withEmailProvider(
  "threads/spam",
  async (request, context) => {
    const params = await context.params;
    const { id: threadId } = paramsSchema.parse(params);

    try {
      await request.emailProvider.markSpam(threadId);
      return NextResponse.json({ success: true });
    } catch (error) {
      request.logger.error("Failed to mark thread as spam", {
        error,
        threadId,
        emailAccountId: request.auth.emailAccountId,
      });
      return NextResponse.json(
        { error: "Failed to mark email as spam" },
        { status: 500 },
      );
    }
  },
);
