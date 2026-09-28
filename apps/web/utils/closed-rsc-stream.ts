const STORAGE_KEY = "inbox-zero:closed-rsc-stream";
const RETRY_WINDOW_MS = 15_000;

export function isClosedRscStreamError(message: string | undefined): boolean {
  if (!message) return false;
  return (
    message.includes("Minified React error #412") ||
    message.includes("https://react.dev/errors/412") ||
    message === "Connection closed."
  );
}

export function decideClosedRscStreamReload({
  message,
  locationKey,
  stored,
  now,
}: {
  message: string | undefined;
  locationKey: string;
  stored: string | null;
  now: number;
}): { action: "reload"; nextStored: string } | { action: "show" } {
  if (!isClosedRscStreamError(message)) return { action: "show" };

  const previous = parseStoredAttempt(stored);
  if (previous?.key === locationKey && now - previous.at < RETRY_WINDOW_MS) {
    return { action: "show" };
  }

  return {
    action: "reload",
    nextStored: JSON.stringify({ key: locationKey, at: now }),
  };
}

export function recoverClosedRscStream(
  message: string | undefined,
  deps: ClosedRscStreamRecoveryDeps = browserRecoveryDeps(),
): boolean {
  const decision = decideClosedRscStreamReload({
    message,
    locationKey: deps.locationKey(),
    stored: readStoredAttempt(deps.storage),
    now: deps.now(),
  });
  if (decision.action !== "reload") return false;

  try {
    deps.storage.setItem(STORAGE_KEY, decision.nextStored);
  } catch {
    return false;
  }
  deps.reload();
  return true;
}

function parseStoredAttempt(
  stored: string | null,
): { key: string; at: number } | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as { key?: unknown; at?: unknown };
    if (typeof parsed.key !== "string" || typeof parsed.at !== "number") {
      return null;
    }
    return { key: parsed.key, at: parsed.at };
  } catch {
    return null;
  }
}

function readStoredAttempt(storage: Pick<Storage, "getItem">): string | null {
  try {
    return storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function browserRecoveryDeps(): ClosedRscStreamRecoveryDeps {
  return {
    locationKey: () => `${window.location.pathname}${window.location.search}`,
    storage: window.sessionStorage,
    now: () => Date.now(),
    reload: () => window.location.reload(),
  };
}

type ClosedRscStreamRecoveryDeps = {
  locationKey: () => string;
  storage: Pick<Storage, "getItem" | "setItem">;
  now: () => number;
  reload: () => void;
};
