import { describe, expect, test } from "bun:test";
import {
  type Capabilities,
  type GenerateRequest,
  type ModelManifest,
  newId,
  normalizedRequestSchema,
} from "@openfield/core";
import { GOOGLE_MODELS } from "../src/google/models";
import { GOOGLE_SETTINGS } from "../src/google/settings";
import { appendAvoid, normalize, planCalls } from "../src/normalize";

const pro = GOOGLE_MODELS.find((m) => m.modelId === "gemini-3-pro-image")!;

const variant = (caps: Partial<Capabilities>): ModelManifest => ({
  ...pro,
  capabilities: { ...pro.capabilities, ...caps },
});

// A native-batch, seeded, reject-policy model, like the OpenAI and Higgsfield manifests will be.
const strict = variant({
  batch: { max: 4, native: true },
  seed: { supported: true, echoed: true, range: [0, 2_147_483_647] },
  negativePrompt: true,
  quality: {
    levels: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
    default: "high",
  },
  emulated: [],
  unsupported: {},
  unsupportedParamPolicy: "reject",
});

const req = (overrides: Partial<GenerateRequest> = {}): GenerateRequest => ({
  idempotencyKey: newId(),
  model: pro.key,
  op: "generate",
  prompt: "A quiet harbour at dawn",
  size: { kind: "aspect", ratio: "3:4" },
  batch: 1,
  source: "composer",
  ...overrides,
});

const run = (manifest: ModelManifest, overrides: Partial<GenerateRequest> = {}, seed = 7) =>
  normalize(manifest, req(overrides), { jobSetId: newId(), randomSeed: () => seed });

describe("normalize", () => {
  test("produces requests that match the core schema", async () => {
    const out = await run(pro, { batch: 3, references: [{ assetId: newId(), role: "style", weight: 0.4 }] });
    expect(out.error).toBeUndefined();
    expect(() => normalizedRequestSchema.parse(out.request)).not.toThrow();
    for (const call of out.calls) expect(() => normalizedRequestSchema.parse(call)).not.toThrow();
  });

  test("keeps aspect for aspect-mode models and reports placeholder pixels", async () => {
    const out = await run(pro, { resolution: "2K" });
    expect(out.request.size).toEqual({ aspect: "3:4" });
    expect(out.request.resolution).toBe("2K");
    expect(out.dimensions).toEqual({ width: 1536, height: 2048 });
  });

  test("auto stays auto; the default tier fills in", async () => {
    const out = await run(pro, { size: { kind: "auto" } });
    expect(out.request.size).toEqual({ aspect: "auto" });
    expect(out.request.resolution).toBe("1K");
  });

  test("Avoid becomes one trailing sentence on models without the field", async () => {
    const out = await run(pro, { negativePrompt: " blurry, text. " });
    expect(out.request.promptAfterPreset).toBe("A quiet harbour at dawn. Avoid: blurry, text.");
    expect(out.request.negativePrompt).toBeUndefined();
    expect(out.request.prompt).toBe("A quiet harbour at dawn");
    expect(out.emulated).toContain("negativePrompt");
    expect(out.diagnostics).toEqual([]);
  });

  test("Avoid stays a field on models that have one", async () => {
    const out = await run(strict, { negativePrompt: "blurry" });
    expect(out.request.negativePrompt).toBe("blurry");
    expect(out.request.promptAfterPreset).toBe("A quiet harbour at dawn");
  });

  test("appendAvoid handles punctuation and empty prompts", () => {
    expect(appendAvoid("A cat!", "dogs")).toBe("A cat! Avoid: dogs.");
    expect(appendAvoid("", "dogs...")).toBe("Avoid: dogs.");
  });

  test("fan-out: n single calls, one job id each", async () => {
    const out = await run(pro, { batch: 3 });
    expect(out.jobIds).toHaveLength(3);
    expect(out.calls.map((c) => [c.batch, c.batchIndex, c.jobId])).toEqual(
      out.jobIds.map((id, i) => [1, i, id]),
    );
    expect(out.request.batch).toBe(3);
    expect(out.emulated).toContain("batch");
  });

  test("native batch: one call for all n", async () => {
    const out = await run(strict, { batch: 3 });
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]).toMatchObject({ batch: 3, batchIndex: 0, jobId: out.jobIds[0] });
  });

  test("seeds: generated server-side only when supported, locked seeds are kept", async () => {
    expect((await run(pro)).request.seed).toBeUndefined();
    expect((await run(strict, {}, 99)).request.seed).toBe(99);
    expect((await run(strict, { seed: 1234 })).request.seed).toBe(1234);
  });

  test("fan-out seeds count up from the base and wrap at the top of the range", () => {
    const seeded = variant({ seed: { supported: true, echoed: true, range: [0, 9] } });
    const frozen = { ...strictRequest(), seed: 8, batch: 3 };
    const calls = planCalls(seeded, frozen, [newId(), newId(), newId()]);
    expect(calls.map((c) => c.seed)).toEqual([8, 9, 0]);
  });

  test("a seed on a model without seeds is dropped with a warning", async () => {
    const out = await run(pro, { seed: 5 });
    expect(out.request.seed).toBeUndefined();
    expect(out.diagnostics).toEqual([expect.objectContaining({ field: "seed", level: "warning" })]);
  });

  test("drop-with-warning: unknown values fall back to defaults", async () => {
    const out = await run(pro, { size: { kind: "aspect", ratio: "8:1" }, resolution: "512", batch: 4 });
    expect(out.error).toBeUndefined();
    expect(out.request.size).toEqual({ aspect: "auto" });
    expect(out.request.resolution).toBe("1K");
    expect(out.diagnostics.map((d) => [d.field, d.level])).toEqual([
      ["resolution", "warning"],
      ["size", "warning"],
    ]);
    expect(out.diagnostics[0]?.message).toBe("Nano Banana Pro doesn't support Resolution.");
  });

  test("reject: the same mistakes stop the run with unsupported_param", async () => {
    const out = await run(strict, { quality: "ultra" });
    expect(out.error?.code).toBe("unsupported_param");
    expect(out.error?.field).toBe("quality");
    expect(out.error?.userMessage).toBe("Nano Banana Pro doesn't support Quality.");
  });

  test("an op the model can't do is always an error", async () => {
    const out = await run(pro, {
      op: "inpaint",
      base: { assetId: newId(), role: "base" },
      mask: { assetId: newId() },
    });
    expect(out.error?.code).toBe("capability_unsupported");
  });

  test("widget edits compile to edit, and edits need a base", async () => {
    const relight = await run(pro, { op: "relight", base: { assetId: newId(), role: "base" } });
    expect(relight.request.op).toBe("edit");
    expect(relight.error).toBeUndefined();
    const noBase = await run(pro, { op: "edit" });
    expect(noBase.error?.field).toBe("base");
  });

  test("an empty prompt with nothing attached can't run", async () => {
    const out = await run(pro, { prompt: "  " });
    expect(out.error?.userMessage).toBe("Describe the image first.");
    const withRef = await run(pro, { prompt: "", references: [{ assetId: newId(), role: "subject" }] });
    expect(withRef.error).toBeUndefined();
  });

  test("references beyond the limit are cut, and weights go when unsupported", async () => {
    const references = Array.from({ length: 16 }, () => ({
      assetId: newId(),
      role: "style" as const,
      weight: 0.5,
    }));
    const out = await run(pro, { references });
    expect(out.request.references).toHaveLength(14);
    expect(out.request.references?.every((r) => r.weight === undefined)).toBe(true);
    expect(out.diagnostics[0]?.message).toBe("Nano Banana Pro accepts up to 14 reference images.");
  });

  test("Advanced keeps declared fields with valid values only", async () => {
    const out = await run(pro, { providerOptions: { grounding: true, thinking: "high", nope: 1 } });
    expect(out.request.providerOptions).toEqual({ grounding: true });
    expect(out.diagnostics.map((d) => d.field)).toEqual(["providerOptions.thinking", "providerOptions.nope"]);
  });

  test("the resolver hook replaces the prompt and references", async () => {
    const ref = { assetId: newId(), role: "style" as const };
    const out = await normalize(pro, req({ prompt: "@noir a street" }), {
      jobSetId: newId(),
      resolvePrompt: async () => ({ prompt: "A street, film noir, hard shadows", references: [ref] }),
    });
    expect(out.request.prompt).toBe("@noir a street");
    expect(out.request.promptAfterPreset).toBe("A street, film noir, hard shadows");
    expect(out.request.references).toEqual([ref]);
  });

  test("paramsHash ignores ids and the source, and changes with settings", async () => {
    const a = await run(pro, { source: "composer" });
    const b = await run(pro, { source: "canvas" });
    const c = await run(pro, { resolution: "4K" });
    expect(a.request.paramsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.request.paramsHash).toBe(b.request.paramsHash);
    expect(a.request.paramsHash).not.toBe(c.request.paramsHash);
  });

  test("company settings resolve for the model and freeze onto the request (§0.3)", async () => {
    const settings = { schema: GOOGLE_SETTINGS, stored: { speed: "flex", flexBusy: "standard" } };
    const out = await normalize(pro, req({ batch: 2 }), { jobSetId: newId(), settings });
    expect([out.request.speed, out.request.speedRequested]).toEqual(["flex", "flex"]);
    expect(out.request.providerSettings).toEqual({ speed: "flex", flexBusy: "standard" });
    expect(out.calls.every((c) => c.speed === "flex" && c.providerSettings.flexBusy === "standard")).toBe(
      true,
    );
    expect(() => normalizedRequestSchema.parse(out.request)).not.toThrow();

    // Nano Banana 2 has no Flex: it runs at Standard, and says what was asked for.
    const flash = GOOGLE_MODELS.find((m) => m.modelId === "gemini-3.1-flash-image")!;
    const other = await normalize(flash, req({ model: flash.key }), { jobSetId: newId(), settings });
    expect([other.request.speed, other.request.speedRequested]).toEqual(["standard", "flex"]);
    expect(other.settings.notes[0]).toMatchObject({ field: "speed", reason: "option_not_for_model" });
  });

  test("without company settings a run is Standard with none", async () => {
    const out = await run(pro);
    expect([out.request.speed, out.request.speedRequested, out.request.providerSettings]).toEqual([
      "standard",
      "standard",
      {},
    ]);
  });

  test("the speed is part of paramsHash: it changes the price", async () => {
    const standard = await run(pro);
    const batch = await normalize(pro, req(), {
      jobSetId: newId(),
      randomSeed: () => 7,
      settings: { schema: GOOGLE_SETTINGS, stored: { speed: "batch" } },
    });
    expect(batch.request.paramsHash).not.toBe(standard.request.paramsHash);
  });

  test("a Batch run always splits into single-image requests, native batch or not", () => {
    const frozen = { ...strictRequest(), batch: 3, speed: "batch" as const };
    expect(planCalls(strict, frozen, [newId(), newId(), newId()])).toHaveLength(3);
    expect(planCalls(strict, { ...frozen, speed: "standard" }, [newId(), newId(), newId()])).toHaveLength(1);
  });

  test("Recreate: planCalls on a frozen request with new ids keeps everything else", async () => {
    const out = await run(pro, { batch: 2 });
    const frozen = JSON.parse(JSON.stringify(out.request));
    const replay = planCalls(pro, frozen, [newId(), newId()]);
    expect(replay.map(({ jobId: _, ...rest }) => rest)).toEqual(
      out.calls.map(({ jobId: _, ...rest }) => rest),
    );
    expect(() => planCalls(pro, frozen, [newId()])).toThrow(RangeError);
  });
});

function strictRequest() {
  return {
    idempotencyKey: newId(),
    model: pro.key,
    op: "generate" as const,
    prompt: "x",
    size: { aspect: "1:1" as const },
    batch: 1,
    source: "api" as const,
    jobId: newId(),
    jobSetId: newId(),
    batchIndex: 0,
    promptAfterPreset: "x",
    manifestVersion: "1",
    paramsHash: `sha256:${"0".repeat(64)}`,
    speed: "standard" as const,
    speedRequested: "standard" as const,
    providerSettings: {},
  };
}
