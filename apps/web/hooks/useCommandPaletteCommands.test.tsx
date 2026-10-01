// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCommandPaletteCommands } from "./useCommandPaletteCommands";

const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));
vi.mock("@/hooks/useSettingsDialog", () => ({
  useSettingsDialog: () => ({ openSettings: vi.fn() }),
}));
vi.mock("@/hooks/useRules", () => ({
  useRules: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1", provider: "imap" }),
}));
vi.mock("@/hooks/useFeatureFlags", () => ({
  useCleanerEnabled: () => false,
  useIntegrationsEnabled: () => false,
  useMeetingBriefsEnabled: () => false,
}));

describe("command palette navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens assistant settings on the automation settings tab", () => {
    const { result } = renderHook(() => useCommandPaletteCommands());
    const command = result.current.commands.find(
      (item) => item.id === "settings-assistant",
    );

    command?.action();

    expect(router.push).toHaveBeenCalledWith(
      "/account-1/automation?tab=settings",
    );
  });
});
