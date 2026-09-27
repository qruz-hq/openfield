// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { beforeAll, describe, expect, test } from "bun:test";
import { type SelectSettingField, type SettingsPanel, setFormatLocale } from "@openfield/core";
import { runSpeed } from "@openfield/providers/manifest";
import { defaultPrice, speedPrice } from "../src/lib/cost";
import {
  batchExpiryDays,
  dependencyNote,
  fieldView,
  formatPriceRange,
  isAsyncSpeed,
  optionAvailability,
  optionPriceRange,
  settingSummaries,
} from "../src/lib/provider-settings";
import { lite, pro, speedSettings } from "./fixtures";

beforeAll(() => setFormatLocale("en-US"));

const google = [pro, lite];
const settings = speedSettings();
const panels = settings.schema.panels;
const speedField = panels[0]!.fields[0] as SelectSettingField;
const option = (value: string) => speedField.options.find((o) => o.value === value)!;

describe("option prices", () => {
  test("span every model that offers the speed, two significant digits", () => {
    const range = (value: string) => {
      const r = optionPriceRange(speedField, option(value), google);
      return r ? formatPriceRange(r) : undefined;
    };
    expect(range("standard")).toBe("$0.034–0.24");
    expect(range("flex")).toBe("$0.067–0.12");
    expect(range("batch")).toBe("$0.017–0.12");
    expect(range("priority")).toBe("$0.24–0.43");
  });

  test("one amount when both ends read the same", () => {
    expect(formatPriceRange({ min: 0.0336, max: 0.034, currency: "USD" })).toBe("$0.034");
  });

  test("another option shows the price it bills at, across the models the field matters for", () => {
    const busy = panels[1]!.fields[0]!;
    if (busy.kind !== "select") throw new Error("expected a select");
    const range = (i: number) => {
      const r = optionPriceRange(busy, busy.options[i]!, google, "speed");
      return r ? formatPriceRange(r) : undefined;
    };
    // Only Nano Banana Pro has Flex, so Lite's Standard price stays out of "Switch to Standard".
    expect(range(0)).toBe("$0.067–0.12");
    expect(range(1)).toBe("$0.13–0.24");
    const { priceAt: _, ...plain } = busy.options[0]!;
    expect(optionPriceRange(busy, plain, google, "speed")).toBeUndefined();
  });
});

describe("availability", () => {
  test("names the models when only some offer an option", () => {
    expect(optionAvailability(speedField, option("flex"), google)).toBe("Nano Banana Pro only");
    expect(optionAvailability(speedField, option("batch"), google)).toBeUndefined();
    expect(optionAvailability(speedField, option("standard"), google)).toBeUndefined();
  });
});

describe("runSpeed", () => {
  test("a model without the chosen speed runs at Standard and says so", () => {
    const flex = speedSettings({ speed: "flex" });
    expect(runSpeed(flex, pro)).toEqual({
      speed: "flex",
      requested: "flex",
      fellBack: false,
      name: "Flex",
      requestedName: "Flex",
    });
    expect(runSpeed(flex, lite)).toEqual({
      speed: "standard",
      requested: "flex",
      fellBack: true,
      name: "Standard",
      requestedName: "Flex",
    });
    expect(runSpeed(undefined, pro)).toMatchObject({ speed: "standard", fellBack: false, name: "Standard" });
  });

  test("speeds go by the company's own names", () => {
    const flex = speedSettings({ speed: "flex" });
    const renamed = structuredClone(flex);
    const field = renamed.schema.panels[0]!.fields[0] as SelectSettingField;
    for (const o of field.options) o.label = `${o.label} lane`;
    expect(runSpeed(renamed, lite)).toMatchObject({ name: "Standard lane", requestedName: "Flex lane" });
    expect(speedPrice(lite, runSpeed(renamed, lite))).toMatchObject({
      note: "· Standard lane",
      hint: "Nano Banana 2 Lite has no Flex lane, so it runs at Standard lane.",
    });
  });

  test("prices follow the speed", () => {
    const batch = speedSettings({ speed: "batch" });
    expect(defaultPrice(pro, runSpeed(batch, pro).speed)).toBe("~$0.067");
    expect(defaultPrice(lite, runSpeed(batch, lite).speed)).toBe("~$0.017");
    expect(defaultPrice(lite)).toBe("~$0.034");
  });

  test("a price at Standard in place of the chosen speed says so", () => {
    const flex = speedSettings({ speed: "flex" });
    expect(speedPrice(pro, runSpeed(flex, pro))).toEqual({ price: "~$0.067" });
    expect(speedPrice(lite, runSpeed(flex, lite))).toEqual({
      price: "~$0.034",
      note: "· Standard",
      hint: "Nano Banana 2 Lite has no Flex, so it runs at Standard.",
    });
  });
});

describe("settingSummaries", () => {
  test("one pill per choice that isn't the default, value only", () => {
    expect(settingSummaries(speedSettings())).toEqual([]);
    expect(settingSummaries(speedSettings({ speed: "batch", concurrencyCap: 2 }))).toEqual([
      { fieldId: "speed", field: "Speed", label: "Batch", speed: true },
    ]);
  });

  test("leaves out choices whose condition doesn't hold", () => {
    expect(settingSummaries(speedSettings({ speed: "batch", flexBusy: "standard" }))).toHaveLength(1);
    expect(settingSummaries(speedSettings({ speed: "flex", flexBusy: "standard" }))).toEqual([
      { fieldId: "speed", field: "Speed", label: "Flex", speed: true },
      { fieldId: "flexBusy", field: "When Flex is busy", label: "Switch to Standard", speed: false },
    ]);
  });
});

describe("fieldView", () => {
  const busyField = panels[1]!.fields[0]!;

  test("a field whose condition reads another panel stays in view, muted, with a note", () => {
    const values = speedSettings({ speed: "batch" }).values;
    const view = fieldView(busyField, "busy", panels, values);
    expect(view.mode).toBe("muted");
    if (view.mode !== "muted") return;
    expect(view.blocked.targetPanel).toBe("speed");
    expect(dependencyNote(view.blocked, values)).toEqual({
      message: "Only used when Speed is Flex. Your speed is Batch.",
      action: "Change speed",
    });
  });

  test("shows when the condition holds", () => {
    expect(fieldView(busyField, "busy", panels, speedSettings({ speed: "flex" }).values)).toEqual({
      mode: "shown",
    });
  });

  test("a condition on a field in the same panel hides it", () => {
    const merged: SettingsPanel[] = [{ ...panels[0]!, fields: [speedField, busyField] }];
    expect(fieldView(busyField, "speed", merged, speedSettings({ speed: "batch" }).values)).toEqual({
      mode: "hidden",
    });
  });
});

describe("Batch note", () => {
  test("only for a speed whose runs arrive later, with the company's expiry", () => {
    expect(isAsyncSpeed("batch", google)).toBe(true);
    expect(isAsyncSpeed("flex", google)).toBe(false);
    expect(isAsyncSpeed("standard", google)).toBe(false);
    expect(batchExpiryDays(google)).toBe(2);
  });
});
