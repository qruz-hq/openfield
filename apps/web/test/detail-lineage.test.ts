// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { Asset, AssetDetailResponse, EditOpParams } from "@openfield/core";
import { askedComposite, editedFrom, maskNote, reopenedEdit } from "../src/detail/lineage";
import { asset, at } from "./fixtures";

// Where an edited image came from: the Info tab's Edited from block (design Detail / Section /
// Edited from and its three variants), and what editing the original again puts back.

function full(extra: Partial<Asset> = {}): Asset {
  const item = asset(at(10));
  return {
    ...item,
    bytes: 1000,
    seed: null,
    params: null,
    tags: "",
    costUsd: null,
    parentAssetId: null,
    rootAssetId: item.id,
    op: "generate",
    opParams: null,
    maskAssetId: null,
    generative: true,
    approximateReason: null,
    fileState: "ok",
    updatedAt: item.createdAt,
    deletedAt: null,
    ...extra,
  };
}

const original = full({ prompt: "White vases, red berries" });
const mask = full({ kind: "mask", parentAssetId: original.id, prompt: "" });

const record = (composite: Partial<EditOpParams["composite"]>, more: Partial<EditOpParams> = {}) => ({
  edit: { composite: { applied: true, expandPx: 4, featherPx: 8, ...composite }, ...more },
});

function detail(edited: Partial<Asset>, extra: Partial<AssetDetailResponse> = {}): AssetDetailResponse {
  return {
    asset: full({
      kind: "edited",
      op: "inpaint",
      parentAssetId: original.id,
      rootAssetId: original.id,
      maskAssetId: mask.id,
      ...edited,
    }),
    jobSet: null,
    params: null,
    references: [],
    lineage: { ancestors: [original], children: [] },
    mask,
    folders: [],
    isFavourite: false,
    ...extra,
  };
}

describe("editedFrom", () => {
  test("an edit shows its original, its mask and its references", () => {
    const reference = full();
    const from = editedFrom(
      detail({ opParams: record({}) }, { references: [reference] }),
      "GPT Image 2.5 Flare",
    );
    expect(from?.original?.id).toBe(original.id);
    expect(from?.mask?.id).toBe(mask.id);
    expect(from?.maskNote).toBe("Feather 8 px · Expand 4 px");
    expect(from?.references.map((r) => r.id)).toEqual([reference.id]);
  });

  test("an image made any other way has none", () => {
    expect(editedFrom(detail({ op: "generate", parentAssetId: null }), undefined)).toBeNull();
    expect(editedFrom(detail({ op: "upscale" }), undefined)).toBeNull();
  });

  test("an original that has left the library isn't shown, and an edit without a mask has no Mask row", () => {
    const from = editedFrom(detail({}, { lineage: { ancestors: [], children: [] }, mask: null }), undefined);
    expect(from?.original).toBeNull();
    expect(from?.mask).toBeNull();
    expect(from?.maskNote).toBeNull();
  });
});

describe("maskNote", () => {
  test("the composite's own settings when the rest was put back", () => {
    expect(maskNote({ opParams: record({ featherPx: 12, expandPx: 0 }), params: null }, "Flare")).toBe(
      "Feather 12 px · Expand 0 px",
    );
  });

  test("a whole-image model says it redrew the image, then put the rest back", () => {
    expect(
      maskNote({ opParams: record({}, { fallback: "whole_image" }), params: null }, "Nano Banana Pro"),
    ).toBe("Redrawn by Nano Banana Pro, the rest put back");
    // The image's own approximate_reason says the same.
    expect(
      maskNote({ opParams: record({}), params: null, approximateReason: "whole_image" }, "Nano Banana Pro"),
    ).toBe("Redrawn by Nano Banana Pro, the rest put back");
  });

  test("turned off, the rest wasn't kept; when putting it back failed, it says so", () => {
    expect(maskNote({ opParams: record({ applied: false, reason: "off" }), params: null }, "Flare")).toBe(
      "Rest of the image not kept",
    );
    for (const reason of ["failed", "unavailable", "turned"] as const)
      expect(maskNote({ opParams: record({ applied: false, reason }), params: null }, "Flare")).toBe(
        "Couldn't keep the rest exactly. Try again.",
      );
    // A whole-image model whose rest wasn't kept: that's what matters most.
    expect(
      maskNote(
        { opParams: record({ applied: false, reason: "off" }, { fallback: "whole_image" }), params: null },
        "Nano Banana Pro",
      ),
    ).toBe("Rest of the image not kept");
  });

  test("with no record, what the request asked for", () => {
    const params = { mask: { assetId: mask.id, composite: true, featherPx: 6, expandPx: 2 } };
    expect(maskNote({ opParams: null, params }, "Flare")).toBe("Feather 6 px · Expand 2 px");
    expect(
      maskNote({ opParams: null, params: { mask: { assetId: mask.id, composite: false } } }, "Flare"),
    ).toBe("Rest of the image not kept");
    expect(maskNote({ opParams: null, params: null }, "Flare")).toBe("Feather 8 px · Expand 4 px");
  });
});

describe("askedComposite", () => {
  test("the request's settings come first, then the record, then the defaults", () => {
    const params = { mask: { assetId: mask.id, composite: false, featherPx: 3, expandPx: 1 } };
    expect(askedComposite({ opParams: record({}), params })).toEqual({
      composite: false,
      featherPx: 3,
      expandPx: 1,
    });
    // A put-back that failed was still asked for.
    expect(
      askedComposite({ opParams: record({ applied: false, reason: "failed", featherPx: 5 }), params: null }),
    ).toEqual({ composite: true, featherPx: 5, expandPx: 4 });
    expect(askedComposite({ opParams: null, params: null })).toEqual({
      composite: true,
      featherPx: 8,
      expandPx: 4,
    });
  });
});

describe("reopenedEdit", () => {
  test("puts back the words, model, sizes, count, references and Keep the rest that made it", () => {
    const reference = full();
    const data = detail(
      {
        params: {
          model: "openai:gpt-image-2.5",
          resolution: "1K",
          quality: "medium",
          mask: { assetId: mask.id, composite: true, featherPx: 8, expandPx: 4 },
        },
        opParams: record({}),
      },
      { references: [reference] },
    );
    const from = editedFrom(data, "Flare")!;
    const jobSet = { batchSize: 2 } as AssetDetailResponse["jobSet"];
    const plan = reopenedEdit({ ...data, jobSet }, from, "Make these berries pale and dried.");
    expect(plan).toEqual({
      original,
      mask,
      prompt: "Make these berries pale and dried.",
      model: "openai:gpt-image-2.5",
      values: { resolution: "1K", quality: "medium" },
      batch: 2,
      composite: { composite: true, featherPx: 8, expandPx: 4 },
      references: [reference.id],
    });
  });

  test("leaves out what the request didn't say, and needs both the original and the mask", () => {
    const data = detail({ params: null });
    const plan = reopenedEdit(data, editedFrom(data, undefined)!, "Pale");
    expect(plan?.model).toBeUndefined();
    expect(plan?.values).toEqual({});
    expect(plan?.batch).toBe(1);
    const gone = detail({}, { lineage: { ancestors: [], children: [] } });
    expect(reopenedEdit(gone, editedFrom(gone, undefined)!, "Pale")).toBeNull();
    const unmasked = detail({ maskAssetId: null }, { mask: null });
    expect(reopenedEdit(unmasked, editedFrom(unmasked, undefined)!, "Pale")).toBeNull();
  });
});
