import { cookies } from "next/headers";
import {
  LAST_EMAIL_ACCOUNT_COOKIE,
  type LastEmailAccountCookieValue,
} from "@/utils/cookies";

export async function setLastEmailAccountCookie(
  value: LastEmailAccountCookieValue,
) {
  const cookieStore = await cookies();
  cookieStore.set(LAST_EMAIL_ACCOUNT_COOKIE, JSON.stringify(value), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });
}

export async function clearLastEmailAccountCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(LAST_EMAIL_ACCOUNT_COOKIE);
}
