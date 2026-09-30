"use client";

import { useCallback, useState } from "react";
import { useSWRConfig } from "swr";
import { getMessageSenderProfile } from "@/app/(app)/[emailAccountId]/mail/thread-participants";
import { SenderContextPanel } from "@/app/(app)/[emailAccountId]/mail/SenderContextPanel";
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
    autoOpenReplyAll,
    composeRequest,
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
            autoOpenReplyAll={supportsViewerReplies && autoOpenReplyAll}
            composeRequest={composeRequest}
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
  autoOpenReplyAll,
  composeRequest,
  autoOpenForwardForMessageId,
  expandMessageId,
  topRightComponent,
  onSendSuccess,
  onConversationGone,
}: {
  threadId: string;
  showReplyButton: boolean;
  autoOpenReplyForMessageId?: string;
  autoOpenReplyAll?: boolean;
  composeRequest?: number;
  autoOpenForwardForMessageId?: string;
  expandMessageId?: string | null;
  topRightComponent?: React.ReactNode;
  onSendSuccess?: (messageId: string, threadId: string) => void;
  onConversationGone?: () => void;
}) {
  const { data, isLoading, error, mutate } = useThread({ id: threadId });
  const [senderContext, setSenderContext] = useState<{
    threadId: string;
    messageId: string;
    senderName: string;
    senderEmail: string;
  } | null>(null);
  const openSender =
    senderContext?.threadId === threadId ? senderContext : null;

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
            autoOpenReplyAll={autoOpenReplyAll}
            composeRequest={composeRequest}
            autoOpenForwardForMessageId={autoOpenForwardForMessageId}
            expandMessageId={expandMessageId}
            topRightComponent={topRightComponent}
            onSendSuccess={onSendSuccess}
            onConversationGone={onConversationGone}
            onOpenSenderContext={(message) => {
              const profile = getMessageSenderProfile(message.headers.from);
              setSenderContext({
                threadId,
                messageId: message.id,
                senderEmail: profile.senderEmail,
                senderName: profile.senderName || profile.senderEmail,
              });
            }}
            withHeader
          />
        )}
      </LoadingContent>
      {openSender ? (
        <SenderContextPanel
          messageId={openSender.messageId}
          onClose={() => setSenderContext(null)}
          senderEmail={openSender.senderEmail}
          senderName={openSender.senderName}
          variant="sheet"
        />
      ) : null}
    </ErrorBoundary>
  );
}
