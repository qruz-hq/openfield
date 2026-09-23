import { beforeAll, describe, expect, test } from "bun:test";
import {
  BATCH_DEADLINE_GRACE_MS,
  FLEX_JOB_DEADLINE_MS,
  type ModelManifest,
  type ProviderSettingsSchema,
  setFormatLocale,
  withLimitsPanel,
} from "@openfield/core";
import { GOOGLE_MODELS } from "../src/google/models";
import { GOOGLE_SETTINGS } from "../src/google/settings";
import { estimate } from "../src/manifest/estimate";
import {
  checkSettingsPatch,
  modelsOffering,
  resolveProviderSettings,
  settingShown,
  settingValues,
  staleSettingIds,
} from "../src/manifest/provider-settings";
import { offeredSpeeds, priceFor, resolveSpeed, speedOffer, speedTimeouts } from "../src/manifest/speed";

beforeAll(() => setFormatLocale("en-US"));

const byId = (id: string) => GOOGLE_MODELS.find((m) => m.modelId === id)!;
const pro = byId("gemini-3-pro-image");
const flash = byId("gemini-3.1-flash-image");
const lite = byId("gemini-3.1-flash-lite-image");

describe("speeds (§0.3)", () => {
  test("a model runs at a speed it offers, and at Standard otherwise", () => {
    expect(resolveSpeed(pro, "flex")).toEqual({ speed: "flex", fellBack: false });
    expect(resolveSpeed(flash, "flex")).toEqual({ speed: "standard", fellBack: true });
    expect(resolveSpeed(flash, "priority")).toEqual({ speed: "standard", fellBack: true });
    expect(resolveSpeed(lite, "batch")).toEqual({ speed: "batch", fellBack: false });
    expect(resolveSpeed(lite, "standard")).toEqual({ speed: "standard", fellBack: false });
  });

  test("an offer limited to some operations falls back for the rest", () => {
    const generateOnly: ModelManifest = {
      ...pro,
      speeds: pro.speeds?.map((o) => (o.id === "batch" ? { ...o, ops: ["generate" as const] } : o)),
    };
    expect(resolveSpeed(generateOnly, "batch", "generate").speed).toBe("batch");
    expect(resolveSpeed(generateOnly, "batch", "edit")).toEqual({ speed: "standard", fellBack: true });
    expect(offeredSpeeds(generateOnly, "edit")).toEqual(["standard", "flex", "priority"]);
  });

  test("what each Google model offers, per the pricing page", () => {
    expect(offeredSpeeds(pro)).toEqual(["standard", "flex", "priority", "batch"]);
    expect(offeredSpeeds(flash)).toEqual(["standard", "batch"]);
    expect(offeredSpeeds(lite)).toEqual(["standard", "batch"]);
  });

  test("prices come from the offer, or the Standard price", () => {
    expect(priceFor(pro, "standard")).toBe(pro.price);
    expect(priceFor(flash, "flex")).toBe(flash.price);
    expect(priceFor(pro, "batch")).toBe(speedOffer(pro, "batch")!.price);
  });

  test("timeouts: Flex waits 15 minutes a call and an hour overall; Batch until expiry plus a grace", () => {
    const base = { jobDeadlineMs: 900_000 };
    expect(speedTimeouts(pro, "standard", base)).toEqual({
      attemptTimeoutMs: 120_000,
      jobDeadlineMs: 900_000,
    });
    expect(speedTimeouts(pro, "priority", base)).toEqual({
      attemptTimeoutMs: 120_000,
      jobDeadlineMs: 900_000,
    });
    expect(speedTimeouts(pro, "flex", base)).toEqual({
      attemptTimeoutMs: 900_000,
      jobDeadlineMs: FLEX_JOB_DEADLINE_MS,
    });
    expect(speedTimeouts(pro, "batch", base)).toEqual({
      attemptTimeoutMs: 120_000,
      jobDeadlineMs: 48 * 3_600_000 + BATCH_DEADLINE_GRACE_MS,
    });
  });
});

describe("estimate at a speed (§0.13)", () => {
  // Every Google price in §6.13, per image.
  const table: [ModelManifest, string, "standard" | "flex" | "priority" | "batch", number][] = [
    [pro, "1K", "standard", 0.134],
    [pro, "2K", "standard", 0.134],
    [pro, "4K", "standard", 0.24],
    [pro, "1K", "batch", 0.067],
    [pro, "2K", "batch", 0.067],
    [pro, "4K", "batch", 0.12],
    [pro, "1K", "flex", 0.067],
    [pro, "2K", "flex", 0.067],
    [pro, "4K", "flex", 0.12],
    [pro, "1K", "priority", 0.24192],
    [pro, "2K", "priority", 0.24192],
    [pro, "4K", "priority", 0.432],
    [flash, "512", "standard", 0.045],
    [flash, "1K", "standard", 0.067],
    [flash, "2K", "standard", 0.101],
    [flash, "4K", "standard", 0.151],
    [flash, "512", "batch", 0.022],
    [flash, "1K", "batch", 0.034],
    [flash, "2K", "batch", 0.05],
    [flash, "4K", "batch", 0.076],
    [lite, "1K", "standard", 0.0336],
    [lite, "1K", "batch", 0.0168],
  ];
  for (const [manifest, resolution, speed, usd] of table) {
    test(`${manifest.displayName} ${resolution} at ${speed}: $${usd}`, () => {
      const e = estimate(manifest, { batch: 1, resolution: resolution as never, speed });
      expect([e.min, e.max, e.confidence]).toEqual([usd, usd, "exact"]);
    });
  }

  test("the basis names the speed whenever it isn't Standard", () => {
    expect(estimate(pro, { batch: 2, resolution: "1K", speed: "batch" })).toMatchObject({
      min: 0.134,
      basis: "2 × $0.067 (1K, Batch)",
    });
    expect(estimate(pro, { batch: 2, resolution: "1K" }).basis).toBe("2 × $0.134 (1K)");
  });

  test("a speed the model lacks prices as Standard, with no speed in the basis", () => {
    const e = estimate(flash, { batch: 1, resolution: "1K", speed: "flex" });
    expect([e.min, e.basis]).toEqual([0.067, "1 × $0.067 (1K)"]);
  });

  test("§3.8 criterion 13: Batch on Nano Banana Pro at 1K × 2 is about $0.13", () => {
    expect(estimate(pro, { batch: 2, resolution: "1K", speed: "batch" }).max).toBeCloseTo(0.134, 6);
  });
});

describe("resolveProviderSettings (§0.3)", () => {
  test("defaults, with no speed field and no stored values", () => {
    expect(resolveProviderSettings(undefined, undefined, pro)).toEqual({
      values: {},
      speed: "standard",
      speedRequested: "standard",
      notes: [],
    });
    expect(resolveProviderSettings(GOOGLE_SETTINGS, null, pro)).toEqual({
      values: { speed: "standard", flexBusy: "wait" },
      speed: "standard",
      speedRequested: "standard",
      notes: [],
    });
  });

  test("a stored speed the model offers applies", () => {
    const r = resolveProviderSettings(GOOGLE_SETTINGS, { speed: "flex", flexBusy: "standard" }, pro);
    expect(r).toEqual({
      values: { speed: "flex", flexBusy: "standard" },
      speed: "flex",
      speedRequested: "flex",
      notes: [],
    });
  });

  test("a speed the model lacks falls back to Standard, and says why", () => {
    const r = resolveProviderSettings(GOOGLE_SETTINGS, { speed: "flex", flexBusy: "standard" }, flash);
    expect(r.speed).toBe("standard");
    expect(r.speedRequested).toBe("flex");
    expect(r.values).toEqual({ speed: "standard", flexBusy: "wait" });
    expect(r.notes).toEqual([
      { field: "speed", fallback: "standard", reason: "option_not_for_model" },
      { field: "flexBusy", fallback: "wait", reason: "field_not_for_model" },
    ]);
  });

  test("per op: an offer limited to generate falls back for an edit", () => {
    const generateOnly: ModelManifest = {
      ...pro,
      speeds: pro.speeds?.map((o) => (o.id === "batch" ? { ...o, ops: ["generate" as const] } : o)),
    };
    expect(resolveProviderSettings(GOOGLE_SETTINGS, { speed: "batch" }, generateOnly, "edit").speed).toBe(
      "standard",
    );
    expect(resolveProviderSettings(GOOGLE_SETTINGS, { speed: "batch" }, generateOnly).speed).toBe("batch");
  });

  test("a hidden field resolves to its default", () => {
    const r = resolveProviderSettings(GOOGLE_SETTINGS, { speed: "batch", flexBusy: "standard" }, pro);
    expect(r.values.flexBusy).toBe("wait");
    expect(r.speed).toBe("batch");
  });

  test("stale stored values are dropped, never trusted", () => {
    const stored = { speed: "warp", flexBusy: 3, gone: true };
    expect(resolveProviderSettings(GOOGLE_SETTINGS, stored, pro).values).toEqual({
      speed: "standard",
      flexBusy: "wait",
    });
    expect(staleSettingIds(GOOGLE_SETTINGS, stored).sort()).toEqual(["flexBusy", "gone", "speed"]);
  });

  test("fields and options for some models only", () => {
    const schema: ProviderSettingsSchema = {
      version: 1,
      panels: [
        {
          id: "look",
          label: "Look",
          fields: [
            {
              id: "grain",
              kind: "toggle",
              label: "Grain",
              default: false,
              models: ["google:gemini-3-pro-image"],
            },
            {
              id: "palette",
              kind: "select",
              label: "Palette",
              default: "calm",
              options: [
                { value: "calm", label: "Calm" },
                { value: "vivid", label: "Vivid", models: ["google:gemini-3-pro-image"] },
              ],
            },
          ],
        },
      ],
    };
    expect(resolveProviderSettings(schema, { grain: true, palette: "vivid" }, pro).values).toEqual({
      grain: true,
      palette: "vivid",
    });
    const other = resolveProviderSettings(schema, { grain: true, palette: "vivid" }, flash);
    expect(other.values).toEqual({ grain: false, palette: "calm" });
    expect(other.notes.map((n) => n.reason)).toEqual(["field_not_for_model", "option_not_for_model"]);
  });

  test("Openfield's Limits panel never reaches an adapter", () => {
    const view = withLimitsPanel(GOOGLE_SETTINGS, { company: "Google", defaultCap: 4 });
    const r = resolveProviderSettings(view, { concurrencyCap: 2 }, pro);
    expect(Object.keys(r.values)).toEqual(["speed", "flexBusy"]);
  });
});

describe("the settings modal's helpers", () => {
  const view = withLimitsPanel(GOOGLE_SETTINGS, { company: "Google", defaultCap: 4 });

  test("current values: stored over defaults, the cap included", () => {
    expect(settingValues(view, { speed: "batch", concurrencyCap: 2 })).toEqual({
      speed: "batch",
      flexBusy: "wait",
      concurrencyCap: 2,
    });
  });

  test("a field shows only while its conditions hold", () => {
    const busy = GOOGLE_SETTINGS.panels[1]!.fields[0]!;
    expect(settingShown(busy, { speed: "flex" })).toBe(true);
    expect(settingShown(busy, { speed: "batch" })).toBe(false);
    expect(settingShown({ showWhen: [{ field: "speed", notIn: ["flex"] }] }, { speed: "batch" })).toBe(true);
  });

  test("availability: Flex and Priority only on Nano Banana Pro, Batch everywhere", () => {
    const speed = GOOGLE_SETTINGS.panels[0]!.fields[0]!;
    if (speed.kind !== "select") throw new Error("speed is a select");
    const offering = (value: string) =>
      modelsOffering(speed, speed.options.find((o) => o.value === value)!, GOOGLE_MODELS).map(
        (m) => m.displayName,
      );
    expect(offering("flex")).toEqual(["Nano Banana Pro"]);
    expect(offering("priority")).toEqual(["Nano Banana Pro"]);
    expect(offering("batch")).toEqual(["Nano Banana Pro", "Nano Banana 2", "Nano Banana 2 Lite"]);
    expect(offering("standard")).toHaveLength(3);
  });

  test("a patch: defaults unset, others set, the cap separate", () => {
    expect(checkSettingsPatch(view, { speed: "batch", flexBusy: "wait", concurrencyCap: 2 })).toEqual({
      ok: true,
      set: { speed: "batch" },
      unset: ["flexBusy"],
      concurrencyCap: 2,
    });
    expect(checkSettingsPatch(view, { speed: "standard" })).toEqual({ ok: true, set: {}, unset: ["speed"] });
  });

  test("a patch naming an unknown field or an illegal value is refused with the field", () => {
    expect(checkSettingsPatch(view, { turbo: true })).toMatchObject({ ok: false, field: "turbo" });
    expect(checkSettingsPatch(view, { speed: "warp" })).toMatchObject({ ok: false, field: "speed" });
    expect(checkSettingsPatch(view, { concurrencyCap: 99 })).toMatchObject({
      ok: false,
      field: "concurrencyCap",
    });
    expect(checkSettingsPatch(GOOGLE_SETTINGS, { concurrencyCap: 2 })).toMatchObject({ ok: false });
  });
});
