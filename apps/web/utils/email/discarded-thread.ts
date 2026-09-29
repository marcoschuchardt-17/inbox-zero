/**
 * A discarded draft that was the whole conversation should close the viewer.
 * Reloading that thread asks the mailbox for a message that is already gone.
 */
export function shouldCloseConversationAfterDraftDiscard({
  discarded,
  hasCloseHandler,
  messageIds,
  discardedMessageId,
}: {
  discarded: boolean;
  hasCloseHandler: boolean;
  messageIds: readonly string[];
  discardedMessageId: string;
}) {
  return (
    discarded &&
    hasCloseHandler &&
    messageIds.every((id) => id === discardedMessageId)
  );
}
