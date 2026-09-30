// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadMessage } from "@/components/email-list/types";
import { EmailDetails } from "./EmailDetails";

afterEach(cleanup);

describe("EmailDetails", () => {
  it("shows the reply-to address and the sender header", () => {
    render(
      <EmailDetails
        message={
          {
            date: "2026-09-30T18:00:00.000Z",
            headers: {
              date: "Wed, 30 Sep 2026 18:00:00 +0000",
              from: "News <news@lists.example.com>",
              to: "starttls.imap@example.com",
              "reply-to": "Ada Reply <ada-details@example.com>",
              sender: "List Bot <bot@lists.example.com>",
              subject: "Details both",
            },
          } as ThreadMessage
        }
      />,
    );

    expect(screen.getByText("Reply-To")).toBeTruthy();
    expect(
      screen.getByText("Ada Reply <ada-details@example.com>"),
    ).toBeTruthy();
    expect(screen.getByText("Sender")).toBeTruthy();
    expect(screen.getByText("List Bot <bot@lists.example.com>")).toBeTruthy();
  });
});
