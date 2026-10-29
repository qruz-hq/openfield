// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { ModelListItem } from "@openfield/core";
import { modelsForEdit } from "../src/engine/inputs";
import { banana } from "./fixtures";

// The Edit tab's model picker (design JYJSUrM1XY): models that take a mask under "Change only what
// you paint", then those that redraw the whole image. A model that can't edit isn't offered.

const model = (
  id: string,
  ops: Partial<ModelListItem["capabilities"]["ops"]>,
  extra: Partial<ModelListItem> = {},
) =>
  ({
    ...banana,
    key: `test:${id}`,
    modelId: id,
    displayName: id,
    capabilities: { ...banana.capabilities, ops: { ...banana.capabilities.ops, ...ops } },
    ...extra,
  }) as ModelListItem;

const keys = (list: readonly ModelListItem[]) => list.map((m) => m.modelId);

describe("modelsForEdit", () => {
  const flare = model("flare", { inpaint: true, imageEdit: true });
  const pro = model("pro", { inpaint: false, imageEdit: true });
  const sunburst = model("sunburst", { inpaint: true, imageEdit: true }, { ready: false });
  const textOnly = model("text-only", { inpaint: false, imageEdit: false });
  const lite = model("lite", { inpaint: false, imageEdit: true });

  test("models that take a mask come first, each group in the order it came", () => {
    const { masked, whole } = modelsForEdit([pro, flare, textOnly, lite, sunburst]);
    expect(keys(masked)).toEqual(["flare", "sunburst"]);
    expect(keys(whole)).toEqual(["pro", "lite"]);
  });

  test("models that need a key stay in their group, so the picker can offer to add one", () => {
    expect(modelsForEdit([sunburst]).masked).toEqual([sunburst]);
  });

  test("a model that can't edit, or makes video, isn't offered", () => {
    const video = model("seedance", { inpaint: false, imageEdit: true }, { modality: "video" });
    expect(modelsForEdit([textOnly, video])).toEqual({ masked: [], whole: [] });
  });
});
