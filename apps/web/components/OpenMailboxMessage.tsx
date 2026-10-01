"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useDisplayedEmail } from "@/hooks/useDisplayedEmail";
import { useAccount } from "@/providers/EmailAccountProvider";
import { cn } from "@/utils";
import { getExternalEmailUrl } from "@/utils/url";

export function OpenMailboxMessage({
  threadId,
  messageId,
  className,
  children,
}: {
  threadId: string;
  messageId?: string;
  className?: string;
  children: ReactNode;
}) {
  const { provider, userEmail } = useAccount();
  const { showEmail } = useDisplayedEmail();
  const externalUrl = getExternalEmailUrl(threadId, userEmail, provider);

  if (!externalUrl) {
    return (
      <button
        type="button"
        className={cn(
          "cursor-pointer border-0 bg-transparent p-0 text-left font-[inherit]",
          className,
        )}
        onClick={() =>
          showEmail({ threadId, messageId: messageId || threadId })
        }
      >
        {children}
      </button>
    );
  }

  return (
    <Link
      href={externalUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
    </Link>
  );
}
