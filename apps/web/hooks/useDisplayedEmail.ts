import { useCallback, useState } from "react";
import { parseAsBoolean, parseAsInteger, useQueryState } from "nuqs";

export const useDisplayedEmail = () => {
  const [threadId, setThreadId] = useQueryState("side-panel-thread-id");
  const [messageId, setMessageId] = useQueryState("side-panel-message-id");
  const [autoOpenReplyForMessageId, setAutoOpenReplyForMessageId] =
    useQueryState("auto-open-reply-for-message-id");
  const [autoOpenReplyAll, setAutoOpenReplyAll] = useQueryState(
    "auto-open-reply-all",
    parseAsBoolean,
  );
  const [composeRequest, setComposeRequest] = useQueryState(
    "compose-request",
    parseAsInteger.withDefault(0),
  );
  const [autoOpenForwardForMessageId, setAutoOpenForwardForMessageId] =
    useQueryState("auto-open-forward-for-message-id");
  const [showReplyButton, setShowReplyButton] = useState(false);

  const showEmail = useCallback(
    (
      options: {
        threadId: string;
        messageId?: string;
        showReplyButton?: boolean;
        autoOpenReplyForMessageId?: string;
        autoOpenForwardForMessageId?: string;
        replyAll?: boolean;
      } | null,
    ) => {
      setAutoOpenReplyForMessageId(options?.autoOpenReplyForMessageId || null);
      setAutoOpenReplyAll(options?.replyAll ? true : null);
      // A forward has to count too. Otherwise a reply the user already closed
      // stays closed, and the forward never appears.
      setComposeRequest((current) =>
        nextComposeRequest(
          current ?? 0,
          Boolean(
            options?.autoOpenReplyForMessageId ||
              options?.autoOpenForwardForMessageId,
          ),
        ),
      );
      setAutoOpenForwardForMessageId(
        options?.autoOpenForwardForMessageId || null,
      );
      setThreadId(options?.threadId ?? null);
      setMessageId(options?.messageId ?? null);
      setShowReplyButton(options?.showReplyButton ?? true);
    },
    [
      setAutoOpenForwardForMessageId,
      setAutoOpenReplyAll,
      setAutoOpenReplyForMessageId,
      setComposeRequest,
      setMessageId,
      setThreadId,
    ],
  );

  const dismissOpenedCompose = useCallback(() => {
    setAutoOpenReplyForMessageId(null);
    setAutoOpenReplyAll(null);
    setAutoOpenForwardForMessageId(null);
    setComposeRequest(null);
  }, [
    setAutoOpenForwardForMessageId,
    setAutoOpenReplyAll,
    setAutoOpenReplyForMessageId,
    setComposeRequest,
  ]);

  return {
    threadId,
    messageId,
    showEmail,
    dismissOpenedCompose,
    showReplyButton,
    autoOpenForwardForMessageId,
    autoOpenReplyForMessageId,
    autoOpenReplyAll: Boolean(autoOpenReplyAll),
    composeRequest,
  };
};

// An empty query value is not a message id. A cleared forward must not hide
// the reply that should open.
export function autoOpenMessageId(
  forwardId?: string | null,
  replyId?: string | null,
) {
  return forwardId || replyId || null;
}

// Opening a reply or a forward asks for a new composer. Dismissing one removes
// the request so a reload does not open it again.
export function nextComposeRequest(current: number, opening: boolean) {
  if (!opening) return null;
  return current + 1;
}

// Clearing the request must not undo a composer the user just closed.
export function composeRequestReopens(previous: number, next: number) {
  return next > previous;
}
