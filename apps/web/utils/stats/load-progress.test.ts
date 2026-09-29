import { describe, expect, it } from "vitest";
import { statsLoadHasMore } from "@/utils/stats/load-progress";

describe("statsLoadHasMore", () => {
  it("stops when the mailbox has no older or newer mail left", () => {
    expect(
      statsLoadHasMore(true, { hasMoreAfter: false, hasMoreBefore: false }),
    ).toBe(false);
    expect(statsLoadHasMore(true, undefined)).toBe(false);
  });

  it("keeps loading while either side of the window still has mail", () => {
    expect(
      statsLoadHasMore(true, { hasMoreAfter: false, hasMoreBefore: true }),
    ).toBe(true);
    expect(
      statsLoadHasMore(false, { hasMoreAfter: true, hasMoreBefore: false }),
    ).toBe(true);
    expect(
      statsLoadHasMore(false, { hasMoreAfter: false, hasMoreBefore: true }),
    ).toBe(false);
  });
});
