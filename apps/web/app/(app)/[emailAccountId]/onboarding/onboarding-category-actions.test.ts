import { describe, expect, it } from "vitest";
import {
  chatOnboardingRuleActions,
  onboardingCategoryActionChoices,
} from "./onboarding-category-actions";

describe("onboardingCategoryActionChoices", () => {
  it("offers label and archive for Gmail", () => {
    expect(onboardingCategoryActionChoices("google")).toEqual([
      { value: "label", label: "Label" },
      { value: "label_archive", label: "Label & archive" },
      { value: "none", label: "Do nothing" },
    ]);
  });

  it("offers categorise and move for Outlook", () => {
    expect(onboardingCategoryActionChoices("microsoft")).toEqual([
      { value: "label", label: "Categorise" },
      { value: "move_folder", label: "Move to folder" },
      { value: "none", label: "Do nothing" },
    ]);
  });

  it("offers label, archive, and move for an IMAP mailbox", () => {
    expect(onboardingCategoryActionChoices("imap")).toEqual([
      { value: "label", label: "Label" },
      { value: "label_archive", label: "Label & archive" },
      { value: "move_folder", label: "Move to folder" },
      { value: "none", label: "Do nothing" },
    ]);
  });
});

describe("chatOnboardingRuleActions", () => {
  it("keeps the Outlook chat actions", () => {
    expect(chatOnboardingRuleActions("microsoft")).toEqual([
      "move_folder",
      "label",
      "label_archive",
    ]);
  });

  it("lets an IMAP mailbox move mail into a folder", () => {
    expect(chatOnboardingRuleActions("imap")).toEqual([
      "label",
      "label_archive",
      "move_folder",
    ]);
  });
});
