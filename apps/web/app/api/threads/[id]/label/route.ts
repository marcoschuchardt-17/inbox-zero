import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";

const paramsSchema = z.object({ id: z.string() });
const bodySchema = z.object({
  labelId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
});

export const POST = withEmailProvider(
  "threads/label",
  async (request, context) => {
    const params = await context.params;
    const { id: threadId } = paramsSchema.parse(params);
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Failed to label email" },
        { status: 400 },
      );
    }

    try {
      await request.emailProvider.labelMessage({
        messageId: parsed.data.messageId,
        labelId: parsed.data.labelId,
        labelName: null,
      });
      return NextResponse.json({ success: true });
    } catch (error) {
      request.logger.error("Failed to label thread", {
        error,
        threadId,
        emailAccountId: request.auth.emailAccountId,
      });
      return NextResponse.json(
        { error: "Failed to label email" },
        { status: 500 },
      );
    }
  },
);
