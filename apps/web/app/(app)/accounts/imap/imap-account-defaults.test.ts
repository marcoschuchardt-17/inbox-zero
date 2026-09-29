import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { imapAccountFormDefaults } from "@/app/(app)/accounts/imap/imap-account-defaults";

describe("imapAccountFormDefaults", () => {
  it("copies mailbox settings without Prisma's inspect symbol", () => {
    const source = {
      emailAccountId: "account-1",
      email: "starttls.imap@example.com",
      name: null,
      imapHost: "127.0.0.1",
      imapPort: 143,
      imapSecure: false,
      imapUsername: "imaptest",
      smtpHost: "127.0.0.1",
      smtpPort: 587,
      smtpSecure: false,
      smtpUsername: "imaptest",
      syncFolder: "INBOX",
    };
    Object.defineProperty(source, inspect.custom, {
      enumerable: true,
      value() {
        return "prisma";
      },
    });

    const defaults = imapAccountFormDefaults(source);

    expect(defaults).toEqual({
      emailAccountId: "account-1",
      email: "starttls.imap@example.com",
      name: "",
      imapHost: "127.0.0.1",
      imapPort: 143,
      imapSecure: false,
      imapUsername: "imaptest",
      smtpHost: "127.0.0.1",
      smtpPort: 587,
      smtpSecure: false,
      smtpUsername: "imaptest",
      syncFolder: "INBOX",
    });
    expect(Object.getOwnPropertySymbols(defaults)).toEqual([]);
  });
});
