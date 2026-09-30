import { describe, expect, it } from "vitest";
import {
  countAddressDomains,
  countAddresses,
} from "@/app/api/user/stats/helpers";

describe("countAddresses", () => {
  it("counts every address stored on one message", () => {
    expect(
      countAddresses([
        { value: "ada@example.com", count: 2 },
        { value: "sam@example.com, ada@example.com", count: 1 },
      ]),
    ).toEqual([
      { value: "ada@example.com", count: 3 },
      { value: "sam@example.com", count: 1 },
    ]);
  });

  it("leaves out the account when it is the only sender or one of two", () => {
    expect(
      countAddresses(
        [
          { value: "starttls.imap@example.com", count: 4 },
          {
            value: "sam.participant@gmail.com, starttls.imap@example.com",
            count: 1,
          },
        ],
        "starttls.imap@example.com",
      ),
    ).toEqual([{ value: "sam.participant@gmail.com", count: 1 }]);
  });
});

describe("countAddressDomains", () => {
  it("counts every sender domain on one message", () => {
    expect(
      countAddressDomains([
        {
          value: "sam@alpha.example, ada@beta.example",
          count: 1,
        },
      ]),
    ).toEqual([
      { value: "alpha.example", count: 1 },
      { value: "beta.example", count: 1 },
    ]);
  });
});
