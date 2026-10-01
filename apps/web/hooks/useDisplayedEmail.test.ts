import { describe, expect, it } from "vitest";
import { autoOpenMessageId } from "./useDisplayedEmail";

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
