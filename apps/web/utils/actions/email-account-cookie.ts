"use server";

import { z } from "zod";
import prisma from "@/utils/prisma";
import {
  clearLastEmailAccountCookie,
  setLastEmailAccountCookie,
} from "@/utils/cookies.server";
import { actionClientUser } from "@/utils/actions/safe-action";

/**
 * Sets a cookie with the last selected email account ID.
 * This is used when emailAccountId is not provided in the URL.
 */
export const setLastEmailAccountAction = actionClientUser
  .metadata({ name: "setLastEmailAccount" })
  .inputSchema(z.object({ emailAccountId: z.string() }))
  .action(async ({ ctx: { userId }, parsedInput: { emailAccountId } }) => {
    const emailAccount = await prisma.emailAccount.findFirst({
      where: { id: emailAccountId, userId },
      select: { id: true },
    });
    if (!emailAccount) return;

    await setLastEmailAccountCookie({
      userId,
      emailAccountId: emailAccount.id,
    });
  });

/**
 * Clears the last email account cookie.
 * Called on logout to prevent stale account IDs when switching users.
 */
export const clearLastEmailAccountAction = actionClientUser
  .metadata({ name: "clearLastEmailAccount" })
  .action(async () => {
    await clearLastEmailAccountCookie();
  });
