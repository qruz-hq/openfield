import { describe, expect, test } from "bun:test";
import { providerSettingsSchemaSchema } from "@openfield/core";
import { BYTEPLUS_MODELS } from "../src/byteplus/models";
import { BYTEPLUS_SETTINGS } from "../src/byteplus/settings";
import { resolveProviderSettings } from "../src/manifest";

const byName = (name: string) => BYTEPLUS_MODELS.find((m) => m.displayName === name)!;

describe("BytePlus speed", () => {
  test("parses, and is for the Seedream models only", () => {
    expect(providerSettingsSchemaSchema.safeParse(BYTEPLUS_SETTINGS).success).toBe(true);
    const field = BYTEPLUS_SETTINGS.panels[0]!.fields[0]!;
    const images = BYTEPLUS_MODELS.filter((m) => m.modality !== "video").map((m) => m.key);
    expect(field.models).toEqual(images);
    expect(images).toHaveLength(5);
  });

  test("Fast runs on 5.0 Pro and 4.0, and every other model stays at Standard without a fallback", () => {
    const stored = { speed: "priority" };
    const at = (name: string) => resolveProviderSettings(BYTEPLUS_SETTINGS, stored, byName(name));
    expect(at("Seedream 5.0 Pro").speed).toBe("priority");
    expect(at("Seedream 4.0").speed).toBe("priority");
    expect(at("Seedream 5.0 Flash")).toMatchObject({ speed: "standard", speedRequested: "priority" });
    // Seedance has no prompt rewrite, so Fast never reaches it, and it never says it fell back.
    const video = BYTEPLUS_MODELS.find((m) => m.modality === "video")!;
    expect(resolveProviderSettings(BYTEPLUS_SETTINGS, stored, video)).toMatchObject({
      speed: "standard",
      speedRequested: "standard",
    });
  });
});
