"use client";

import { useCallback } from "react";
import { useSWRConfig } from "swr";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useDisplayedEmail } from "@/hooks/useDisplayedEmail";
import { EmailThread } from "@/components/email-list/EmailThread";
import { useThread } from "@/hooks/useThread";
import { LoadingContent } from "@/components/LoadingContent";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useAccount } from "@/providers/EmailAccountProvider";
import { isGoogleProvider, isImapProvider } from "@/utils/email/provider-types";

export function EmailViewer() {
  const { provider } = useAccount();

  const {
    threadId,
    messageId,
    showEmail,
    showReplyButton,
    autoOpenForwardForMessageId,
    autoOpenReplyForMessageId,
  } = useDisplayedEmail();

  const { mutate } = useSWRConfig();
  const hideEmail = useCallback(() => showEmail(null), [showEmail]);
  const closeDiscardedConversation = useCallback(() => {
    hideEmail();
    mutate(
      (key) => typeof key === "string" && key.startsWith("/api/threads?"),
    ).catch(() => undefined);
  }, [hideEmail, mutate]);
  const supportsViewerReplies =
    isGoogleProvider(provider) || isImapProvider(provider);

  return (
    <Sheet open={!!threadId} onOpenChange={hideEmail}>
      <SheetContent
        side="right"
        size="5xl"
        className="overflow-y-auto bg-background p-6"
        overlay="transparent"
      >
        {threadId && (
          <ThreadContent
            threadId={threadId}
            showReplyButton={
              isImapProvider(provider) ||
              (supportsViewerReplies && showReplyButton)
            }
            autoOpenReplyForMessageId={
              supportsViewerReplies
                ? (autoOpenReplyForMessageId ?? undefined)
                : undefined
            }
            autoOpenForwardForMessageId={
              supportsViewerReplies
                ? (autoOpenForwardForMessageId ?? undefined)
                : undefined
            }
            expandMessageId={messageId}
            onConversationGone={closeDiscardedConversation}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

export function ThreadContent({
  threadId,
  showReplyButton,
  autoOpenReplyForMessageId,
  autoOpenForwardForMessageId,
  expandMessageId,
  topRightComponent,
  onSendSuccess,
  onConversationGone,
}: {
  threadId: string;
  showReplyButton: boolean;
  autoOpenReplyForMessageId?: string;
  autoOpenForwardForMessageId?: string;
  expandMessageId?: string | null;
  topRightComponent?: React.ReactNode;
  onSendSuccess?: (messageId: string, threadId: string) => void;
  onConversationGone?: () => void;
}) {
  const { data, isLoading, error, mutate } = useThread({ id: threadId });

  return (
    <ErrorBoundary extra={{ component: "ThreadContent", threadId }}>
      <LoadingContent loading={isLoading} error={error}>
        {data && (
          <EmailThread
            key={data.thread.id}
            messages={data.thread.messages}
            refetch={mutate}
            showReplyButton={showReplyButton}
            autoOpenReplyForMessageId={autoOpenReplyForMessageId}
            autoOpenForwardForMessageId={autoOpenForwardForMessageId}
            expandMessageId={expandMessageId}
            topRightComponent={topRightComponent}
            onSendSuccess={onSendSuccess}
            onConversationGone={onConversationGone}
            withHeader
          />
        )}
      </LoadingContent>
    </ErrorBoundary>
  );
}
