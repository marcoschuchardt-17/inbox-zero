export type DraftAttachmentFile = {
  id?: string;
  filename: string;
  content: string;
  contentType: string;
  size?: number;
  disposition?: "attachment" | "inline";
  contentId?: string;
};

export type StoredDraftAttachmentRef = {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  disposition: "attachment" | "inline";
  contentId?: string;
};

type DraftAttachmentSource = {
  attachmentId: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  headers?: {
    "content-disposition"?: string;
    "content-id"?: string;
  };
};

// The composer list is only the files added in this session. Replacing the
// draft with that list would drop pictures already stored on it.
export function attachmentsForDraftUpdate({
  composerAttachments,
  storedAttachments,
  attachmentListChanged,
}: {
  composerAttachments: DraftAttachmentFile[];
  storedAttachments: DraftAttachmentFile[];
  attachmentListChanged: boolean;
}): DraftAttachmentFile[] | undefined {
  if (!attachmentListChanged && composerAttachments.length === 0) return;
  const kept = storedAttachments.filter(
    (stored) =>
      !composerAttachments.some((file) => sameDraftFile(stored, file)),
  );
  return [...kept, ...composerAttachments];
}

export function storedDraftAttachmentRefs(
  attachments: DraftAttachmentSource[] | undefined,
  inline: DraftAttachmentSource[] | undefined,
): StoredDraftAttachmentRef[] {
  const seen = new Set<string>();
  const refs: StoredDraftAttachmentRef[] = [];
  for (const attachment of [...(attachments ?? []), ...(inline ?? [])]) {
    if (!attachment.attachmentId || seen.has(attachment.attachmentId)) continue;
    seen.add(attachment.attachmentId);
    const disposition =
      attachment.headers?.["content-disposition"] === "inline"
        ? "inline"
        : "attachment";
    const contentId = inlineContentId(attachment, disposition);
    refs.push({
      attachmentId: attachment.attachmentId,
      filename: attachment.filename || "attachment",
      mimeType: attachment.mimeType || "application/octet-stream",
      size: attachment.size ?? 0,
      disposition,
      ...(contentId ? { contentId } : {}),
    });
  }
  return refs;
}

function sameDraftFile(
  stored: DraftAttachmentFile,
  composer: DraftAttachmentFile,
) {
  if (stored.content !== composer.content) return false;
  const storedId = normalizeContentId(stored.contentId);
  const composerId = normalizeContentId(composer.contentId);
  if (storedId && composerId) return storedId === composerId;
  if (storedId || composerId) return false;
  return stored.filename === composer.filename;
}

function inlineContentId(
  attachment: DraftAttachmentSource,
  disposition: "attachment" | "inline",
) {
  if (disposition !== "inline") return;
  const contentId = normalizeContentId(attachment.headers?.["content-id"]);
  if (!contentId || contentId === attachment.attachmentId.toLowerCase()) return;
  return contentId;
}

function normalizeContentId(value: string | undefined) {
  const normalized = value
    ?.replace(/^cid:/i, "")
    .replace(/^<|>$/g, "")
    .trim()
    .toLowerCase();
  return normalized || undefined;
}
