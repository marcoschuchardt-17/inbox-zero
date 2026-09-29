import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { LAST_EMAIL_ACCOUNT_COOKIE } from "@/utils/cookies";
import {
  testImapSmtpConnectionAction,
  upsertImapSmtpAccountAction,
} from "./imap-smtp";

const { cookiesSet, connectionAttempts } = vi.hoisted(() => ({
  cookiesSet: vi.fn(),
  connectionAttempts: [] as Array<{ pass: string }>,
}));

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "primary@example.com" },
  })),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: cookiesSet })),
}));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(options: { auth: { pass: string } }) {
      connectionAttempts.push({ pass: options.auth.pass });
    }
    connect() {
      return Promise.resolve();
    }
    mailboxOpen() {
      return Promise.resolve();
    }
    logout() {
      return Promise.resolve();
    }
  },
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      verify: () => Promise.resolve(true),
    }),
  },
}));

const input = {
  email: "Mail@Example.com",
  name: "Marco",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  imapUsername: "mail@example.com",
  imapPassword: "imap-secret",
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: true,
  smtpUsername: "mail@example.com",
  smtpPassword: "smtp-secret",
  syncFolder: "INBOX",
};

describe("upsertImapSmtpAccountAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the account, mailbox, and IMAP settings together and opens that account", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);
    prisma.account.create.mockResolvedValue({
      emailAccount: { id: "email-account-1" },
    } as Awaited<ReturnType<typeof prisma.account.create>>);

    const result = await upsertImapSmtpAccountAction(input);

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({
      emailAccountId: "email-account-1",
      created: true,
    });
    expect(prisma.account.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        provider: "imap",
        providerAccountId: "mail@example.com",
        type: "credentials",
        emailAccount: {
          create: {
            userId: "user-1",
            email: "mail@example.com",
            name: "Marco",
            imapSmtpConfig: {
              create: {
                imapHost: "imap.example.com",
                imapPort: 993,
                imapSecure: true,
                imapUsername: "mail@example.com",
                imapPassword: "imap-secret",
                smtpHost: "smtp.example.com",
                smtpPort: 465,
                smtpSecure: true,
                smtpUsername: "mail@example.com",
                smtpPassword: "smtp-secret",
                syncFolder: "INBOX",
              },
            },
          },
        },
      },
      select: { emailAccount: { select: { id: true } } },
    });
    expect(prisma.imapSmtpConfig.create).not.toHaveBeenCalled();
    expect(cookiesSet).toHaveBeenCalledWith(
      LAST_EMAIL_ACCOUNT_COOKIE,
      JSON.stringify({ userId: "user-1", emailAccountId: "email-account-1" }),
      expect.objectContaining({ httpOnly: true, path: "/", sameSite: "lax" }),
    );
  });

  it("updates an owned mailbox without leaving the settings behind", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "email-account-1",
      userId: "user-1",
      accountId: "account-1",
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>);

    const result = await upsertImapSmtpAccountAction(input);

    expect(result?.data).toEqual({
      emailAccountId: "email-account-1",
      updated: true,
    });
    expect(prisma.account.create).not.toHaveBeenCalled();
    expect(prisma.account.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "account-1", userId: "user-1" },
        data: expect.objectContaining({
          provider: "imap",
          emailAccount: {
            update: expect.objectContaining({
              name: "Marco",
              imapSmtpConfig: {
                upsert: expect.objectContaining({
                  update: expect.objectContaining({
                    imapHost: "imap.example.com",
                    imapPassword: "imap-secret",
                    smtpPassword: "smtp-secret",
                    lastConnectionError: null,
                  }),
                }),
              },
            }),
          },
        }),
      }),
    );
    expect(cookiesSet).toHaveBeenCalledWith(
      LAST_EMAIL_ACCOUNT_COOKIE,
      JSON.stringify({ userId: "user-1", emailAccountId: "email-account-1" }),
      expect.anything(),
    );
  });

  it("keeps the saved passwords when an update leaves them blank", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "email-account-1",
      userId: "user-1",
      accountId: "account-1",
      imapSmtpConfig: { id: "config-1" },
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>);

    const result = await upsertImapSmtpAccountAction({
      ...input,
      imapHost: "127.0.0.1",
      imapPort: 143,
      imapSecure: false,
      imapPassword: "",
      smtpPassword: "",
    });

    expect(result?.serverError).toBeUndefined();
    expect(result?.validationErrors).toBeUndefined();
    const updateCall = prisma.account.update.mock.calls[0]?.[0] as {
      data: {
        emailAccount: {
          update: {
            imapSmtpConfig: {
              upsert: { update: Record<string, unknown> };
            };
          };
        };
      };
    };
    const configUpdate =
      updateCall.data.emailAccount.update.imapSmtpConfig.upsert.update;
    expect(configUpdate.imapHost).toBe("127.0.0.1");
    expect(configUpdate.imapPort).toBe(143);
    expect(configUpdate.imapSecure).toBe(false);
    expect(configUpdate).not.toHaveProperty("imapPassword");
    expect(configUpdate).not.toHaveProperty("smtpPassword");
    expect(configUpdate.lastConnectionError).toBeNull();
  });

  it("refuses a new mailbox without a password", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    const result = await upsertImapSmtpAccountAction({
      ...input,
      imapPassword: "",
      smtpPassword: "",
    });

    expect(result?.serverError).toBe("IMAP password is required.");
    expect(prisma.account.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
  });

  it("refuses an email that belongs to someone else", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "email-account-1",
      userId: "user-2",
      accountId: "account-2",
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>);

    const result = await upsertImapSmtpAccountAction(input);

    expect(result?.serverError).toBe(
      "This email is already linked to another user.",
    );
    expect(prisma.account.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
    expect(cookiesSet).not.toHaveBeenCalled();
  });
});

describe("testImapSmtpConnectionAction", () => {
  beforeEach(() => {
    connectionAttempts.length = 0;
  });

  it("uses the saved password when the form leaves it blank", async () => {
    prisma.imapSmtpConfig.findFirst.mockResolvedValue({
      imapPassword: "stored-imap",
      smtpPassword: "stored-smtp",
    } as Awaited<ReturnType<typeof prisma.imapSmtpConfig.findFirst>>);

    const result = await testImapSmtpConnectionAction({
      emailAccountId: "email-account-1",
      imapHost: "127.0.0.1",
      imapPort: 143,
      imapSecure: false,
      imapUsername: "imaptest",
      imapPassword: "",
      smtpHost: "127.0.0.1",
      smtpPort: 587,
      smtpSecure: false,
      smtpUsername: "imaptest",
      smtpPassword: "",
      syncFolder: "INBOX",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.imapSmtpConfig.findFirst).toHaveBeenCalledWith({
      where: {
        emailAccountId: "email-account-1",
        emailAccount: { userId: "user-1" },
      },
      select: { imapPassword: true, smtpPassword: true },
    });
    expect(connectionAttempts).toEqual([{ pass: "stored-imap" }]);
  });
});
