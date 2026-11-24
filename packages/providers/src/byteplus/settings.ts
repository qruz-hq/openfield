import type { ProviderSettingsSchema } from "@openfield/core";

// BytePlus's company settings, shown in its settings modal before Openfield's Limits panel. Fast is
// Seedream's lighter prompt rewrite (optimize_prompt_options "fast"), offered on 5.0 Pro and 4.0;
// every other model, Seedance included, runs at Standard. It's bound to the Priority speed id
// because Openfield's speed ids are fixed, and costs the same as Standard.

export const BYTEPLUS_SETTINGS: ProviderSettingsSchema = {
  version: 1,
  panels: [
    {
      id: "speed",
      label: "Speed",
      description: "How much time Seedream spends reading your prompt before it starts.",
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
              description: "Seedream reads your prompt closely. Works on every model.",
            },
            {
              value: "priority",
              label: "Fast",
              speed: "priority",
              description: "A quicker read of your prompt, so images start sooner. Same price.",
            },
          ],
        },
      ],
    },
  ],
};
