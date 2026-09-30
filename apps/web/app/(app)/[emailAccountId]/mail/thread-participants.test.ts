import { describe, expect, it } from "vitest";
import {
  getMessageSenderProfile,
  getThreadParticipantNames,
} from "./thread-participants";

describe("getThreadParticipantNames", () => {
  it("lists each sender once and labels the account owner as me", () => {
    expect(
      getThreadParticipantNames(
        [
          message({
            from: "Bah <bah@example.com>",
            to: "owner@example.com",
          }),
          message({
            from: "owner@example.com",
            to: "Bah <bah@example.com>",
          }),
          message({
            from: "Bah Updated <BAH@example.com>",
            to: "owner@example.com",
          }),
        ],
        "OWNER@example.com",
      ),
    ).toEqual(["Bah", "me"]);
  });

  it("does not add me to a received-only thread", () => {
    expect(
      getThreadParticipantNames(
        [
          message({
            from: "Bah <bah@example.com>",
            to: "owner@example.com",
          }),
        ],
        "owner@example.com",
      ),
    ).toEqual(["Bah"]);
  });

  it("does not count an unsent draft as participation by the account owner", () => {
    expect(
      getThreadParticipantNames(
        [
          message({
            from: "Bah <bah@example.com>",
            to: "owner@example.com",
          }),
          message({
            from: "owner@example.com",
            to: "Bah <bah@example.com>",
            labelIds: ["DRAFT"],
          }),
        ],
        "owner@example.com",
      ),
    ).toEqual(["Bah"]);
  });

  it("keeps recipient names for an outgoing-only thread", () => {
    expect(
      getThreadParticipantNames(
        [
          message({
            from: "owner@example.com",
            to: "Jordan <jordan@example.com>, Taylor <taylor@example.com>",
          }),
        ],
        "owner@example.com",
      ),
    ).toEqual(["Jordan", "Taylor"]);
  });

  it("keeps recipient names for a draft-only thread", () => {
    expect(
      getThreadParticipantNames(
        [
          message({
            from: "owner@example.com",
            to: "Jordan <jordan@example.com>",
            labelIds: ["DRAFT"],
          }),
        ],
        "owner@example.com",
      ),
    ).toEqual(["Jordan"]);
  });

  it("names a copied person when the outgoing mail has no other recipient", () => {
    expect(
      getThreadParticipantNames(
        [
          message({
            from: "Owner <owner@example.com>",
            to: "",
            cc: "Ada Copy <ada-copy@example.com>",
          }),
        ],
        "owner@example.com",
      ),
    ).toEqual(["Ada Copy"]);
  });

  it("names every person who sent the message", () => {
    expect(
      getThreadParticipantNames(
        [
          message({
            from: "Sam <sam@example.com>, Ada <ada@example.com>",
            to: "owner@example.com",
          }),
        ],
        "owner@example.com",
      ),
    ).toEqual(["Sam", "Ada"]);
  });

  it("names a blind-copy person when the outgoing mail has no other recipient", () => {
    expect(
      getThreadParticipantNames(
        [
          message({
            from: "Owner <owner@example.com>",
            to: "Owner <owner@example.com>",
            bcc: "Hidden <hidden-copy@example.com>",
          }),
        ],
        "owner@example.com",
      ),
    ).toEqual(["Hidden"]);
  });
});

describe("getMessageSenderProfile", () => {
  it("lists every sender on the public profile", () => {
    expect(
      getMessageSenderProfile("Sam <sam@example.com>, Ada <ada@example.com>"),
    ).toEqual({
      senderName: "Sam, Ada",
      senderEmail: "sam@example.com, ada@example.com",
    });
  });
});

function message({
  from,
  to,
  cc,
  bcc,
  labelIds,
}: {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  labelIds?: string[];
}) {
  return { headers: { from, to, cc, bcc }, labelIds };
}
