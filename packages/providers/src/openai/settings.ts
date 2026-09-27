import type { ProviderSettingsSchema } from "@openfield/core";

// OpenAI's company settings (§6.14), shown in the OpenAI settings modal before Openfield's Limits
// panel. The Image API has no Flex or Priority: those cover the Responses and Chat Completions APIs
// only. Which models offer Batch, and at what price, comes from each manifest's speeds.

export const OPENAI_SETTINGS: ProviderSettingsSchema = {
  version: 1,
  panels: [
    {
      id: "speed",
      label: "Speed",
      description: "How quickly OpenAI makes your images. Waiting longer costs less.",
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
              description: "Full price. Images in under two minutes. Works on every model.",
            },
            {
              value: "batch",
              label: "Batch",
              speed: "batch",
              description: "Half price. Runs in the background and is ready within a day.",
            },
          ],
        },
      ],
    },
  ],
};
