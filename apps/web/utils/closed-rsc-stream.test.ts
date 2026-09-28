import { describe, expect, it, vi } from "vitest";
import {
  decideClosedRscStreamReload,
  isClosedRscStreamError,
  recoverClosedRscStream,
} from "./closed-rsc-stream";

const productionMessage =
  "Minified React error #412; visit https://react.dev/errors/412 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";

describe("closed RSC stream recovery", () => {
  it("recognizes the production and development connection-closed errors", () => {
    expect(isClosedRscStreamError(productionMessage)).toBe(true);
    expect(isClosedRscStreamError("Connection closed.")).toBe(true);
    expect(isClosedRscStreamError("Minified React error #418")).toBe(false);
    expect(isClosedRscStreamError(undefined)).toBe(false);
  });

  it("reloads a closed stream once, then leaves the error on screen", () => {
    const first = decideClosedRscStreamReload({
      message: productionMessage,
      locationKey: "/account/mail",
      stored: null,
      now: 1000,
    });
    expect(first.action).toBe("reload");
    if (first.action !== "reload") return;

    expect(
      decideClosedRscStreamReload({
        message: productionMessage,
        locationKey: "/account/mail",
        stored: first.nextStored,
        now: 2000,
      }).action,
    ).toBe("show");

    expect(
      decideClosedRscStreamReload({
        message: productionMessage,
        locationKey: "/account/mail?thread-id=1",
        stored: first.nextStored,
        now: 2000,
      }).action,
    ).toBe("reload");

    expect(
      decideClosedRscStreamReload({
        message: productionMessage,
        locationKey: "/account/mail",
        stored: first.nextStored,
        now: 20_000,
      }).action,
    ).toBe("reload");
  });

  it("does not reload unrelated errors", () => {
    expect(
      decideClosedRscStreamReload({
        message: "Failed to load inbox",
        locationKey: "/account/mail",
        stored: null,
        now: 1000,
      }).action,
    ).toBe("show");
  });

  it("stores the attempt before reloading the document", () => {
    const storage = new Map<string, string>();
    const reload = vi.fn();
    const recovered = recoverClosedRscStream(productionMessage, {
      locationKey: () => "/account/automation",
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
      },
      now: () => 5000,
      reload,
    });

    expect(recovered).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(
      recoverClosedRscStream(productionMessage, {
        locationKey: () => "/account/automation",
        storage: {
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => {
            storage.set(key, value);
          },
        },
        now: () => 6000,
        reload,
      }),
    ).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });
});
