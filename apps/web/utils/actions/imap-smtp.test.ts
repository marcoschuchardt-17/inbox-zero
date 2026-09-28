import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { LAST_EMAIL_ACCOUNT_COOKIE } from "@/utils/cookies";
import { upsertImapSmtpAccountAction } from "./imap-smtp";

const { cookiesSet } = vi.hoisted(() => ({
  cookiesSet: vi.fn(),
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
