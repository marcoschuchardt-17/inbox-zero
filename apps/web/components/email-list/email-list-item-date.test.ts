import { describe, expect, it } from "vitest";
import { emailListItemDate } from "./email-list-item-date";

describe("emailListItemDate", () => {
  it("shows the date written on IMAP mail when it arrived the next day", () => {
    const shown = emailListItemDate(
      {
        headers: { date: "2026-09-29T18:00:00.000Z" },
        internalDate: String(new Date("2026-09-30T08:18:49.000Z").getTime()),
      },
      "imap",
    );

    expect(shown.toISOString()).toBe("2026-09-29T18:00:00.000Z");
  });

  it("keeps the arrival time for other providers", () => {
    const shown = emailListItemDate(
      {
        headers: { date: "2026-09-29T18:00:00.000Z" },
        internalDate: "2026-09-30T08:18:49.000Z",
      },
      "google",
    );

    expect(shown.toISOString()).toBe("2026-09-30T08:18:49.000Z");
  });

  it("uses the arrival time when an IMAP date header cannot be read", () => {
    const shown = emailListItemDate(
      {
        headers: { date: "not-a-date" },
        internalDate: "2026-09-30T08:18:49.000Z",
      },
      "imap",
    );

    expect(shown.toISOString()).toBe("2026-09-30T08:18:49.000Z");
  });
});
