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
      setAutoOpenReplyForMessageId(options?.autoOpenReplyForMessageId || "");
      setAutoOpenReplyAll(options?.replyAll ? true : null);
      if (options?.autoOpenReplyForMessageId) {
        setComposeRequest((current) => (current ?? 0) + 1);
      } else if (!options) {
        setComposeRequest(null);
      }
      setAutoOpenForwardForMessageId(
        options?.autoOpenForwardForMessageId || "",
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

  return {
    threadId,
    messageId,
    showEmail,
    showReplyButton,
    autoOpenForwardForMessageId,
    autoOpenReplyForMessageId,
    autoOpenReplyAll: Boolean(autoOpenReplyAll),
    composeRequest,
  };
};
