import type { OnboardingRuleAction } from "@/app/api/chat/onboarding/validation";
import type { CategoryAction } from "@/utils/actions/rule.validation";
import {
  isGoogleProvider,
  isImapProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";

export function onboardingCategoryActionChoices(provider: string): {
  value: CategoryAction;
  label: string;
}[] {
  const choices: { value: CategoryAction; label: string }[] = [];

  if (isMicrosoftProvider(provider)) {
    choices.push(
      { value: "label", label: "Categorise" },
      { value: "move_folder", label: "Move to folder" },
    );
  } else if (isGoogleProvider(provider) || isImapProvider(provider)) {
    choices.push(
      { value: "label", label: "Label" },
      { value: "label_archive", label: "Label & archive" },
    );
  }

  if (isImapProvider(provider)) {
    choices.push({ value: "move_folder", label: "Move to folder" });
  }

  choices.push({ value: "none", label: "Do nothing" });
  return choices;
}

export function chatOnboardingRuleActions(
  provider: string,
): OnboardingRuleAction[] {
  if (isMicrosoftProvider(provider)) {
    return ["move_folder", "label", "label_archive"];
  }
  if (isImapProvider(provider)) {
    return ["label", "label_archive", "move_folder"];
  }
  return ["label", "label_archive"];
}
