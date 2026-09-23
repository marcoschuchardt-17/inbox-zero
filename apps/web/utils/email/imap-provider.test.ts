import { describe, expect, it } from "vitest";
import { createImapProvider } from "./imap";
import type { Logger } from "@/utils/logger";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  trace: () => undefined,
  child: () => logger,
} as unknown as Logger;

describe("createImapProvider", () => {
  it("is not a thenable, so async callers return the provider itself", async () => {
    const provider = createImapProvider(
      {
        emailAccountId: "account-1",
        ownerEmail: "owner@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecure: true,
        imapUsername: "owner@example.com",
        imapPassword: "secret",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: "owner@example.com",
        smtpPassword: "secret",
        syncFolder: "INBOX",
      },
      logger,
    );

    const resolved = await Promise.resolve(provider);

    expect(resolved).toBe(provider);
    expect(provider.name).toBe("imap");
  });
});
