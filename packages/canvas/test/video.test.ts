// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { ModelListItem } from "@openfield/core";
// biome-ignore lint/style/noRestrictedImports: the real Seedance catalog, read in a test only.
import { createByteplusProvider } from "@openfield/providers/server";
import { compileRun } from "../src/engine/compile";
import { buildEngineContext } from "../src/engine/context-base";
import { planFingerprints, resolveFingerprints } from "../src/engine/fingerprint";
import { portFlow } from "../src/engine/types";
import { specRegistry } from "../src/nodes/specs";
import type { DocSlice } from "../src/store/ops";
import { banana, docOf, edge, node } from "./fixtures";

// The Video node (video.generate): its ports, its model, what it blocks on and the run it compiles.

const videos: ModelListItem[] = createByteplusProvider()
  .catalog()
  .map((m) => ({ ...m, modality: "video" as const, ready: true, enabled: true }));
const models = [banana, ...videos];
const ctx = buildEngineContext(models, { defaultModel: null, defaultBatch: 1, defaultAspect: null }, []);
const ASSET = "01K6BQ80000000000000AS0001";
const OTHER = "01K6BQ80000000000000AS0002";

async function compile(doc: DocSlice) {
  const fingerprints = await resolveFingerprints(planFingerprints(doc, specRegistry, ctx), new Map());
  return compileRun({
    doc,
    registry: specRegistry,
    ctx,
    fingerprints,
    request: { scope: "all", nodeIds: [] },
  });
}

const upload = (id: string, assetIds: string[]) => node(id, "image.upload", { params: { assetIds } });

describe("the Video node", () => {
  test("image nodes keep to image models, the Video node to video ones", () => {
    expect(ctx.defaultModel).toBe(banana.key);
    expect(ctx.defaultVideoModel).toBe("byteplus:dreamina-seedance-2-5-260628");
    const made = specRegistry.instantiate("video.generate", { position: { x: 0, y: 0 }, ctx });
    expect(made.params).toMatchObject({ model: "byteplus:dreamina-seedance-2-5-260628", prompt: "" });
    // The add-node menu lists it under Video.
    const groups = specRegistry.menu(ctx).map((g) => [g.group, g.items.map((i) => i.type)]);
    expect(groups).toContainEqual(["video", ["video.generate"]]);
  });

  test("ports: text in, a start and an end frame, a video out that connects only to video", () => {
    const ports = specRegistry.ports("video.generate").map((p) => [p.id, p.direction, p.type, p.arity]);
    expect(ports).toEqual([
      ["prompt", "in", "text", "single"],
      ["start_frame", "in", "image", "single"],
      ["end_frame", "in", "image", "single"],
      ["video", "out", "video", "single"],
    ]);
    expect(portFlow("video", "image")).toBe("no");
    expect(portFlow("video", "video")).toBe("ok");
  });

  test("compiles a video run: the model's settings, the frames as inputs, a price from the size table", async () => {
    const doc = docOf(
      [
        node("p", "prompt", { params: { text: "A kite over the hill" } }),
        upload("u", [ASSET]),
        node("v", "video.generate", {
          params: {
            model: "byteplus:seedance-1-0-pro-250528",
            size: { kind: "aspect", ratio: "16:9" },
            resolution: "720p",
            seconds: 5,
          },
        }),
      ],
      [edge("e1", "p", "text", "v", "prompt"), edge("e2", "u", "images", "v", "start_frame")],
    );
    const out = await compile(doc);
    if (out.kind !== "plan") throw new Error(out.kind);
    const item = out.items.find((i) => i.item.nodeId === "v")!;
    expect(item.item.calls).toEqual([
      {
        model: "byteplus:seedance-1-0-pro-250528",
        op: "generate",
        prompt: "A kite over the hill",
        size: { kind: "aspect", ratio: "16:9" },
        video: { seconds: 5, resolution: "720p", cameraFixed: false },
        batch: 1,
        seed: null,
      },
    ]);
    expect(item.item.inputs).toEqual([
      {
        port: "start_frame",
        to: "start_frame",
        arity: "single",
        values: [{ kind: "asset", assetId: ASSET }],
      },
    ]);
    expect(item.expectedJobs).toBe(1);
    // 1.0 Pro, 720p 16:9, 5 s: 102,960 tokens at $2.50 per million.
    expect(item.estimate.min).toBeCloseTo(0.2574, 6);
  });

  test("two start frames run it twice", async () => {
    const doc = docOf(
      [upload("u", [ASSET, OTHER]), node("v", "video.generate", { params: { model: videos[1]!.key } })],
      [edge("e1", "u", "images", "v", "start_frame")],
    );
    const out = await compile(doc);
    if (out.kind !== "plan") throw new Error(out.kind);
    expect([out.items[0]?.fanOut, out.items[0]?.expectedJobs]).toEqual([2, 2]);
  });

  test("blocks without words or a frame, on an end frame the model can't take, and without a start", async () => {
    const lone = await compile(docOf([node("v", "video.generate", { params: {} })]));
    expect(lone.kind === "plan" && lone.blocked.v).toEqual({ kind: "no_prompt" });

    const fast = "byteplus:seedance-1-0-pro-fast-251015";
    const noEnd = await compile(
      docOf(
        [
          upload("a", [ASSET]),
          upload("b", [OTHER]),
          node("v", "video.generate", { params: { model: fast, prompt: "x" } }),
        ],
        [edge("e1", "a", "images", "v", "start_frame"), edge("e2", "b", "images", "v", "end_frame")],
      ),
    );
    expect(noEnd.kind === "plan" && noEnd.blocked.v).toEqual({ kind: "end_frame_unsupported", model: fast });

    const endOnly = await compile(
      docOf(
        [upload("b", [OTHER]), node("v", "video.generate", { params: { prompt: "x" } })],
        [edge("e1", "b", "images", "v", "end_frame")],
      ),
    );
    expect(endOnly.kind === "plan" && endOnly.blocked.v).toEqual({
      kind: "missing_input",
      port: "start_frame",
    });
  });

  test("a video model on an image node is as good as missing, and the other way round", async () => {
    const onImage = await compile(
      docOf([node("g", "image.generate", { params: { model: videos[0]!.key, prompt: "x" } })]),
    );
    expect(onImage.kind === "plan" && onImage.blocked.g).toEqual({
      kind: "model_unavailable",
      model: videos[0]!.key,
    });
    const onVideo = await compile(
      docOf([node("v", "video.generate", { params: { model: banana.key, prompt: "x" } })]),
    );
    expect(onVideo.kind === "plan" && onVideo.blocked.v).toEqual({
      kind: "model_unavailable",
      model: banana.key,
    });
  });

  test("Seedance 2.5 with a start frame takes the frame's shape", async () => {
    const doc = docOf(
      [
        upload("u", [ASSET]),
        node("v", "video.generate", {
          params: { model: videos[0]!.key, size: { kind: "aspect", ratio: "9:16" }, prompt: "x" },
        }),
      ],
      [edge("e1", "u", "images", "v", "start_frame")],
    );
    const out = await compile(doc);
    if (out.kind !== "plan") throw new Error(out.kind);
    expect(out.items[0]?.item.calls[0]?.size).toEqual({ kind: "auto" });
  });
});
