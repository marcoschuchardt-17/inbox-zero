import { describe, expect, it } from "vitest";
import {
  autoOpenMessageId,
  composeRequestReopens,
  nextComposeRequest,
} from "./useDisplayedEmail";

describe("autoOpenMessageId", () => {
  it("uses the reply when the forward id was cleared", () => {
    expect(autoOpenMessageId("", "message-1")).toBe("message-1");
  });

  it("keeps a real forward ahead of the reply", () => {
    expect(autoOpenMessageId("forward-1", "message-1")).toBe("forward-1");
  });

  it("clears both when neither id is set", () => {
    expect(autoOpenMessageId("", "")).toBeNull();
    expect(autoOpenMessageId(null, null)).toBeNull();
  });
});

describe("nextComposeRequest", () => {
  it("counts a forward as a new request so a closed reply can open it", () => {
    expect(nextComposeRequest(1, true)).toBe(2);
  });

  it("drops the request when the composer is dismissed", () => {
    expect(nextComposeRequest(2, false)).toBeNull();
  });
});

describe("composeRequestReopens", () => {
  it("opens again only when a newer request arrives", () => {
    expect(composeRequestReopens(1, 2)).toBe(true);
    expect(composeRequestReopens(2, 0)).toBe(false);
  });
});
