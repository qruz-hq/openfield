import type { ProviderSettingsSchema, SettingValue } from "@openfield/core";

// Google's company settings (§6.13), shown in the Google settings modal before Openfield's Limits
// panel. Speed option labels are Google's own names; availability and prices per model come from
// each manifest's speeds, so they live in one place.

export const GOOGLE_SETTINGS: ProviderSettingsSchema = {
  version: 1,
  panels: [
    {
      id: "speed",
      label: "Speed",
      description: "How quickly Google makes your images. Waiting longer costs less.",
      fields: [
        {
          id: "speed",
          kind: "select",
          role: "speed",
          label: "Speed",
          default: "standard",
          options: [
            {
              value: "standard",
              label: "Standard",
              description: "Images arrive in seconds. Works on every model.",
            },
            {
              value: "flex",
              label: "Flex",
              speed: "flex",
              description: "Half price. Takes 1 to 15 minutes, and Google may turn it down when busy.",
            },
            {
              value: "batch",
              label: "Batch",
              speed: "batch",
              description: "Half price. Ready within a day, often sooner.",
            },
            {
              value: "priority",
              label: "Priority",
              speed: "priority",
              description: "About 80% more. Stays fast when Google is busy.",
            },
          ],
        },
      ],
    },
    {
      // Its own panel, so it stays in view (muted, with a note) while Speed isn't Flex.
      id: "flexBusy",
      label: "When it's busy",
      description: "Google can turn down a Flex run when it's busy. Pick what happens then.",
      fields: [
        {
          id: "flexBusy",
          kind: "select",
          label: "When Flex is busy",
          default: "wait",
          showWhen: [{ field: "speed", in: ["flex"] }],
          options: [
            {
              value: "wait",
              label: "Keep trying at Flex price",
              priceAt: "flex",
              description: "Openfield tries again until Google has room. It can take longer.",
            },
            {
              value: "standard",
              label: "Switch to Standard",
              priceAt: "standard",
              description: "Runs right away at the full price.",
            },
          ],
        },
      ],
    },
  ],
};

export interface GoogleSettings {
  /** What to do when Google refuses Flex for capacity: wait it out, or send again at Standard. */
  flexBusy: "wait" | "standard";
}

/** What the adapter needs from ctx.settings. Anything missing or odd reads as its default. */
export function parseGoogleSettings(
  values: Readonly<Record<string, SettingValue>> | undefined,
): GoogleSettings {
  return { flexBusy: values?.flexBusy === "standard" ? "standard" : "wait" };
}
