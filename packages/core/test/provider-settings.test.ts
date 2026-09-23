// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  BATCH_POLL_SCHEDULE,
  batchPollIntervalMs,
  CONCURRENCY_CAP_FIELD,
  FAKE_BATCH_POLL_MS,
  flexBusyDelayMs,
  LIMITS_PANEL_ID,
  MAX_CONCURRENCY,
  SPEED_IDS,
} from "../src/constants";
import { setFormatLocale, t } from "../src/i18n";
import {
  isLegalSettingValue,
  limitsPanel,
  type ProviderSettingsSchema,
  providerSettingsPatchBodySchema,
  providerSettingsResponseSchema,
  providerSettingsSchemaSchema,
  providerSettingsWithLimitsSchema,
  type SettingField,
  settingFields,
  speedName,
  speedSettingField,
  withLimitsPanel,
} from "../src/schemas";

beforeAll(() => setFormatLocale("en-US"));

const speedField: SettingField = {
  id: "speed",
  kind: "select",
  role: "speed",
  label: "Speed",
  default: "standard",
  options: [
    { value: "standard", label: "Standard", description: "Full price. Images in seconds." },
    { value: "flex", label: "Flex", speed: "flex" },
    { value: "batch", label: "Batch", speed: "batch" },
  ],
};

const busyField: SettingField = {
  id: "flexBusy",
  kind: "select",
  label: "When Flex is busy",
  default: "wait",
  showWhen: [{ field: "speed", in: ["flex"] }],
  options: [
    { value: "wait", label: "Keep trying at Flex price" },
    { value: "standard", label: "Switch to Standard" },
  ],
};

const schema = (
  fields: SettingField[],
  extra: Partial<ProviderSettingsSchema> = {},
): ProviderSettingsSchema => ({
  version: 1,
  panels: [{ id: "speed", label: "Speed", fields }],
  ...extra,
});

const issues = (value: unknown) =>
  providerSettingsSchemaSchema.safeParse(value).error?.issues.map((i) => i.message) ?? [];

describe("settings schema rules (§0.3)", () => {
  test("a well-formed schema parses", () => {
    expect(issues(schema([speedField, busyField]))).toEqual([]);
  });

  test("no more panels or options than the modal can show", () => {
    const panel = (i: number) => ({
      id: `p${i}`,
      label: `Panel ${i}`,
      fields: [{ ...busyField, id: `f${i}`, showWhen: undefined }],
    });
    // Eleven of the company's own, then Openfield's Limits panel makes twelve.
    const panels = Array.from({ length: 12 }, (_, i) => panel(i));
    const eleven = { version: 1, panels: panels.slice(0, 11) };
    expect(providerSettingsSchemaSchema.safeParse(eleven).success).toBe(true);
    expect(providerSettingsSchemaSchema.safeParse({ version: 1, panels }).success).toBe(false);
    const view = withLimitsPanel(eleven, { company: "X", defaultCap: 2 });
    expect(providerSettingsWithLimitsSchema.safeParse(view).success).toBe(true);
    const options = Array.from({ length: 9 }, (_, i) => ({ value: `o${i}`, label: `Option ${i}` }));
    const many = { ...busyField, showWhen: undefined, default: "o0", options };
    expect(providerSettingsSchemaSchema.safeParse(schema([many])).success).toBe(false);
    expect(
      providerSettingsSchemaSchema.safeParse(schema([{ ...many, options: options.slice(0, 8) }])).success,
    ).toBe(true);
  });

  test("rule 1: a text field can't hold a key", () => {
    const apiKey: SettingField = { id: "apiKey", kind: "text", label: "Key", default: "", maxLength: 100 };
    expect(issues(schema([apiKey]))).toContain("Keys are credentials, never settings");
  });

  test("rule 2: Openfield's panel and field ids are reserved for adapters", () => {
    const cap: SettingField = {
      id: CONCURRENCY_CAP_FIELD,
      kind: "number",
      label: "Runs",
      min: 1,
      max: 4,
      step: 1,
      default: 2,
      control: "stepper",
    };
    const reserved = { version: 1, panels: [{ id: LIMITS_PANEL_ID, label: "Limits", fields: [cap] }] };
    expect(issues(reserved)).toEqual([
      `"${LIMITS_PANEL_ID}" is Openfield's own panel`,
      `"${CONCURRENCY_CAP_FIELD}" is Openfield's own field`,
    ]);
    // The modal's view carries Openfield's panel, so there it's allowed.
    expect(providerSettingsWithLimitsSchema.safeParse(reserved).success).toBe(true);
  });

  test("rule 3: defaults must be legal, for every model the field applies to", () => {
    expect(issues(schema([{ ...busyField, showWhen: undefined, default: "later" }]))).toContain(
      "default must be one of the options",
    );
    const narrow: SettingField = {
      id: "look",
      kind: "select",
      label: "Look",
      default: "vivid",
      options: [
        { value: "vivid", label: "Vivid", models: ["google:gemini-3-pro-image"] },
        { value: "calm", label: "Calm" },
      ],
    };
    expect(issues(schema([narrow]))).toContain(
      "The default must be offered by every model the field applies to",
    );
    expect(issues(schema([{ ...narrow, models: ["google:gemini-3-pro-image"] }]))).toEqual([]);
    const number: SettingField = {
      id: "count",
      kind: "number",
      label: "Count",
      min: 1,
      max: 10,
      step: 2,
      default: 4,
      control: "input",
    };
    expect(issues(schema([number]))).toContain("default must be in range and on a step");
    expect(issues(schema([{ ...speedField, default: "flex" }]))).toContain(
      "A speed field defaults to standard",
    );
  });

  test("rule 4: one speed field, bound to real speeds, with no model lists", () => {
    expect(issues(schema([speedField, { ...speedField, id: "speed2" }]))).toContain(
      "At most one field may pick the speed",
    );
    const unbound = {
      ...speedField,
      options: [
        { value: "standard", label: "Standard" },
        { value: "flex", label: "Flex" },
      ],
    };
    expect(issues(schema([unbound]))).toContain("Each speed option sets speed to its value");
    const listed = {
      ...speedField,
      options: [
        { value: "standard", label: "Standard" },
        {
          value: "flex",
          label: "Flex",
          speed: "flex" as const,
          models: ["google:gemini-3-pro-image" as const],
        },
      ],
    };
    expect(issues(schema([listed]))).toContain("Speed options never list models");
    const madeUp = { ...speedField, options: [...speedField.options, { value: "turbo", label: "Turbo" }] };
    expect(issues(schema([madeUp]))).toContain('"turbo" isn\'t a speed');
    const noStandard = { ...speedField, default: "flex", options: speedField.options.slice(1) };
    expect(issues(schema([noStandard]))).toContain("A speed field offers standard");
    expect(
      issues(
        schema([
          {
            ...busyField,
            showWhen: undefined,
            options: [{ value: "wait", label: "W", speed: "flex" as const }],
          },
        ]),
      ),
    ).toContain("Only the speed field binds options to speeds");
  });

  test("rule 5: conditions point backwards at legal values", () => {
    expect(issues(schema([busyField, speedField]))).toContain(
      "showWhen may only name a field declared earlier",
    );
    expect(
      issues(schema([speedField, { ...busyField, showWhen: [{ field: "speed", in: ["warp"] }] }])),
    ).toContain('"speed" can\'t hold one of these values');
  });

  test("ids are unique across panels", () => {
    const twice = {
      version: 1,
      panels: [
        { id: "speed", label: "Speed", fields: [speedField] },
        { id: "speed", label: "Again", fields: [{ ...busyField, showWhen: undefined, id: "speed" }] },
      ],
    };
    expect(issues(twice)).toEqual(['Panel "speed" is declared twice', 'Field "speed" is declared twice']);
  });

  test("unknown keys anywhere fail", () => {
    expect(issues(schema([{ ...speedField, secret: true } as SettingField])).length).toBeGreaterThan(0);
  });
});

describe("values", () => {
  test("legal values follow each kind", () => {
    expect(isLegalSettingValue(speedField, "flex")).toBe(true);
    expect(isLegalSettingValue(speedField, "turbo")).toBe(false);
    expect(isLegalSettingValue({ id: "on", kind: "toggle", label: "On", default: false }, true)).toBe(true);
    const n: SettingField = {
      id: "n",
      kind: "number",
      label: "N",
      min: 1,
      max: 5,
      step: 0.5,
      default: 1,
      control: "input",
    };
    expect([1, 2.5, 5].map((v) => isLegalSettingValue(n, v))).toEqual([true, true, true]);
    expect([0, 2.3, 6, "2"].map((v) => isLegalSettingValue(n, v))).toEqual([false, false, false, false]);
    const text: SettingField = { id: "note", kind: "text", label: "Note", default: "", maxLength: 3 };
    expect(isLegalSettingValue(text, "abc")).toBe(true);
    expect(isLegalSettingValue(text, "abcd")).toBe(false);
  });

  test("helpers find fields and the speed field", () => {
    const s = schema([speedField, busyField]);
    expect(settingFields(s).map((f) => f.id)).toEqual(["speed", "flexBusy"]);
    expect(speedSettingField(s)?.id).toBe("speed");
    expect(speedSettingField(undefined)).toBeUndefined();
  });

  test("route bodies", () => {
    expect(providerSettingsPatchBodySchema.safeParse({ values: { speed: "batch" } }).success).toBe(true);
    expect(providerSettingsPatchBodySchema.safeParse({ values: { "bad id": 1 } }).success).toBe(false);
    expect(providerSettingsPatchBodySchema.safeParse({ values: {}, extra: 1 }).success).toBe(false);
    expect(
      providerSettingsPatchBodySchema.safeParse({ values: { n: Number.POSITIVE_INFINITY } }).success,
    ).toBe(false);
  });
});

describe("Openfield's Limits panel", () => {
  test("comes last, with the company in its copy and the cap in range", () => {
    const view = withLimitsPanel(schema([speedField]), { company: "Google", defaultCap: 4 });
    expect(view.panels.map((p) => p.id)).toEqual(["speed", LIMITS_PANEL_ID]);
    const field = view.panels[1]?.fields[0];
    expect(field).toMatchObject({
      id: CONCURRENCY_CAP_FIELD,
      kind: "number",
      control: "stepper",
      default: 4,
    });
    expect(field?.description).toBe("How many Google images to make at the same time.");
    expect(
      providerSettingsResponseSchema.safeParse({ schema: view, values: { speed: "standard" } }).success,
    ).toBe(true);
    expect(limitsPanel({ company: "X", defaultCap: 99 }).fields[0]).toMatchObject({
      default: MAX_CONCURRENCY,
    });
  });

  test("a company with no settings of its own still gets the panel", () => {
    expect(
      withLimitsPanel(undefined, { company: "OpenAI", defaultCap: 2 }).panels.map((p) => p.label),
    ).toEqual(["Limits"]);
  });
});

describe("speed numbers (§0.12)", () => {
  test("the batch poll schedule steps out, and fake mode polls every second", () => {
    expect(batchPollIntervalMs(0)).toBe(30_000);
    expect(batchPollIntervalMs(9 * 60_000)).toBe(30_000);
    expect(batchPollIntervalMs(11 * 60_000)).toBe(120_000);
    expect(batchPollIntervalMs(2 * 3_600_000)).toBe(300_000);
    expect(batchPollIntervalMs(2 * 3_600_000, { fake: true })).toBe(FAKE_BATCH_POLL_MS);
    expect(BATCH_POLL_SCHEDULE).toHaveLength(3);
  });

  test("Flex busy waits grow, then repeat", () => {
    expect([1, 2, 3, 4, 5, 9].map(flexBusyDelayMs)).toEqual([
      30_000, 60_000, 120_000, 300_000, 300_000, 300_000,
    ]);
  });

  test("every speed has a name", () => {
    for (const id of SPEED_IDS) expect(t(`speed.names.${id}`)).not.toContain("speed.");
  });

  test("a speed goes by the company's own label, wherever its Speed field sits, else Openfield's", () => {
    const named = {
      version: 1,
      panels: [
        { id: "busy", label: "When it's busy", fields: [busyField] },
        {
          id: "speed",
          label: "Speed",
          fields: [
            {
              ...speedField,
              options: [{ value: "standard", label: "Normal" }, ...speedField.options.slice(1)],
            },
          ],
        },
      ],
    } as ProviderSettingsSchema;
    expect(speedName(named, "standard")).toBe("Normal");
    expect(speedName(named, "flex")).toBe("Flex");
    expect(speedName(named, "priority")).toBe("Priority");
    expect(speedName(undefined, "batch")).toBe("Batch");
  });
});

describe("speed copy", () => {
  test("tiles, confirms and reasons", () => {
    expect(t("speed.tile.busy", { speed: "Flex", wait: t("speed.wait.minutes", { count: 2 }) })).toBe(
      "Flex is busy. Trying again in 2 min.",
    );
    expect(t("speed.cancel.body", { count: 2 })).toBe(
      "Both images stop together. You may still be charged for work that already started.",
    );
    expect(t("speed.cancel.body", { count: 4 })).toBe(
      "All 4 images stop together. You may still be charged for work that already started.",
    );
    expect(t("errors.billingOff", { console: "Google AI Studio" })).toBe(
      "Turn on billing for this key in Google AI Studio to make images.",
    );
    expect(t("errors.speedNotOffered", { company: "Google", speed: "Flex" })).toBe(
      "Google doesn't offer Flex for this model. Choose another speed in Google settings.",
    );
  });
});
