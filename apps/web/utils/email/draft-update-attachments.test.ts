import { describe, expect, it } from "vitest";
import {
  attachmentsForDraftUpdate,
  storedDraftAttachmentRefs,
} from "./draft-update-attachments";

describe("attachmentsForDraftUpdate", () => {
  it("leaves stored files alone until the composer attachment list changes", () => {
    expect(
      attachmentsForDraftUpdate({
        composerAttachments: [],
        storedAttachments: [file("photo.png", "aGVsbG8=")],
        attachmentListChanged: false,
      }),
    ).toBeUndefined();
  });

  it("sends a newly added file when the draft has no stored files", () => {
    const note = file("reply-note.txt", "bm90ZQ==");
    expect(
      attachmentsForDraftUpdate({
        composerAttachments: [note],
        storedAttachments: [],
        attachmentListChanged: true,
      }),
    ).toEqual([note]);
  });

  it("keeps a stored picture when a new file is added", () => {
    const photo = file("photo.png", "aGVsbG8=", {
      disposition: "inline",
      contentId: "photo@inboxzero.local",
    });
    const note = file("reply-note.txt", "bm90ZQ==");
    expect(
      attachmentsForDraftUpdate({
        composerAttachments: [note],
        storedAttachments: [photo],
        attachmentListChanged: true,
      }),
    ).toEqual([photo, note]);
  });

  it("does not send a stored copy of a file the composer already holds", () => {
    const note = file("reply-note.txt", "bm90ZQ==");
    expect(
      attachmentsForDraftUpdate({
        composerAttachments: [note],
        storedAttachments: [note],
        attachmentListChanged: true,
      }),
    ).toEqual([note]);
  });

  it("drops a file removed in this session and keeps the original picture", () => {
    const photo = file("photo.png", "aGVsbG8=", {
      disposition: "inline",
      contentId: "photo@inboxzero.local",
    });
    expect(
      attachmentsForDraftUpdate({
        composerAttachments: [],
        storedAttachments: [photo],
        attachmentListChanged: true,
      }),
    ).toEqual([photo]);
  });

  it("keeps a stored picture whose bytes were also attached as a file", () => {
    const photo = file("photo.png", "aGVsbG8=", {
      disposition: "inline",
      contentId: "photo@inboxzero.local",
    });
    const download = file("photo.png", "aGVsbG8=");
    expect(
      attachmentsForDraftUpdate({
        composerAttachments: [download],
        storedAttachments: [photo],
        attachmentListChanged: true,
      }),
    ).toEqual([photo, download]);
  });
});

describe("storedDraftAttachmentRefs", () => {
  it("keeps inline pictures and regular files without a fake content id", () => {
    expect(
      storedDraftAttachmentRefs(
        [
          {
            attachmentId: "13:0",
            filename: "photo.png",
            mimeType: "image/png",
            size: 5,
            headers: {
              "content-disposition": "inline",
              "content-id": "<photo@inboxzero.local>",
            },
          },
          {
            attachmentId: "13:1",
            filename: "note.txt",
            mimeType: "text/plain",
            size: 4,
            headers: {
              "content-disposition": "attachment",
              "content-id": "13:1",
            },
          },
        ],
        [
          {
            attachmentId: "13:0",
            filename: "photo.png",
            mimeType: "image/png",
            size: 5,
            headers: {
              "content-disposition": "inline",
              "content-id": "photo@inboxzero.local",
            },
          },
        ],
      ),
    ).toEqual([
      {
        attachmentId: "13:0",
        filename: "photo.png",
        mimeType: "image/png",
        size: 5,
        disposition: "inline",
        contentId: "photo@inboxzero.local",
      },
      {
        attachmentId: "13:1",
        filename: "note.txt",
        mimeType: "text/plain",
        size: 4,
        disposition: "attachment",
      },
    ]);
  });
});

function file(
  filename: string,
  content: string,
  extra?: { disposition?: "attachment" | "inline"; contentId?: string },
) {
  return {
    filename,
    content,
    contentType: filename.endsWith(".png") ? "image/png" : "text/plain",
    disposition: extra?.disposition,
    contentId: extra?.contentId,
  };
}
