import { env } from "@/env";
import { SafeError } from "@/utils/error";

export function isCleanerApiEnabled() {
  if (process.env.VERCEL === "1") return true;
  return Boolean(env.NEXT_PUBLIC_CLEANER_ENABLED);
}

export function assertCleanerApiEnabled() {
  if (isCleanerApiEnabled()) return;

  throw new SafeError("Cleaner is not enabled", 404);
}
