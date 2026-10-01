import { describe, expect, it } from "vitest";
import { analyticsEmailLink } from "@/app/(app)/[emailAccountId]/stats/EmailAnalytics";

describe("analyticsEmailLink", () => {
  it("opens an IMAP sender in the mailbox", () => {
    expect(
      analyticsEmailLink({
        name: "sam@example.com",
        provider: "imap",
        emailAccountId: "account-1",
        userEmail: "starttls.imap@example.com",
      }),
    ).toEqual({
      href: "/account-1/mail?q=sam%40example.com",
    });
  });

  it("opens a Gmail sender in Gmail", () => {
    expect(
      analyticsEmailLink({
        name: "sam@example.com",
        provider: "google",
        emailAccountId: "account-1",
        userEmail: "user@gmail.com",
      }),
    ).toEqual({
      href: "https://mail.google.com/mail/u/?authuser=user%40gmail.com#advanced-search/from=sam%40example.com",
      target: "_blank",
    });
  });

  it("opens an Outlook sender in Outlook", () => {
    expect(
      analyticsEmailLink({
        name: "sam@example.com",
        provider: "microsoft",
        emailAccountId: "account-1",
        userEmail: "user@outlook.com",
      }),
    ).toEqual({
      href: "https://outlook.live.com/mail/0/search/q/from%3Asam%40example.com",
      target: "_blank",
    });
  });
});
