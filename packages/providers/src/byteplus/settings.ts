import type { ModelKey, ProviderSettingsSchema } from "@openfield/core";
import { SEEDREAM_SPECS } from "./seedream";

// BytePlus's company settings, shown in its settings modal before Openfield's Limits panel. Fast is
// Seedream's lighter prompt rewrite (optimize_prompt_options "fast"), offered on 5.0 Pro and 4.0;
// the other Seedream models run at Standard. It's bound to the Priority speed id because
// Openfield's speed ids are fixed, and costs the same as Standard. Seedance has no prompt rewrite,
// so the field is for Seedream only and a video never shows a speed.

const SEEDREAM_KEYS = SEEDREAM_SPECS.map((spec): ModelKey => `byteplus:${spec.modelId}`);

export const BYTEPLUS_SETTINGS: ProviderSettingsSchema = {
  version: 1,
  panels: [
    {
      id: "speed",
      label: "Speed",
      description: "How Seedream reads your prompt before it draws. Speed doesn't change the price.",
      fields: [
        {
          id: "speed",
          kind: "select",
          role: "speed",
          label: "Speed",
          default: "standard",
          models: SEEDREAM_KEYS,
          options: [
            {
              value: "standard",
              label: "Standard",
              description: "Best results. Takes a little longer.",
            },
            {
              value: "priority",
              label: "Fast",
              speed: "priority",
              description: "Quicker, and follows your prompt a little less closely.",
            },
          ],
        },
      ],
    },
  ],
};
