import { afterEach, describe, expect, test } from "bun:test";
import {
  buildEngineContext,
  type CompileOutcome,
  compileRun,
  type EngineContext,
  emptyDocument,
  fromDocument,
  planFingerprints,
  resolveFingerprints,
  specRegistry,
} from "@openfield/canvas";
import {
  type CanvasDetail,
  type CanvasPatchResponse,
  type CanvasRunBody,
  canvasDetailSchema,
  canvasRunResponseSchema,
  type ModelsListResponse,
  type ProviderSettingsResponse,
  type ProviderSummary,
  type Settings,
} from "@openfield/core";
import { finished, MODEL, newCanvas } from "./canvas-helpers";
import { saveKey, startTestServer, type TestServer } from "./helpers";

// A saved canvas compiles on the server, with no tab open, through the same engine the editor
// runs (@openfield/canvas). The context comes from the queries the editor builds its own from, and
// the run route takes the plan as it takes the browser's.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** What the editor's useEngineContextState builds, from the same four queries. */
async function engineContext(s: TestServer): Promise<EngineContext> {
  const { models } = (await s.json<ModelsListResponse>("/api/models")).body;
  const settings = (await s.json<Settings>("/api/settings")).body;
  const providers = (await s.json<ProviderSummary[]>("/api/providers")).body;
  const speeds = new Map<string, ProviderSettingsResponse>();
  for (const p of providers) {
    speeds.set(p.id, (await s.json<ProviderSettingsResponse>(`/api/providers/${p.id}/settings`)).body);
  }
  return buildEngineContext(models, settings, providers, speeds);
}

/** Prompt → Generate, placed the way the editor places new nodes, and saved. */
async function savedChain(s: TestServer, ctx: EngineContext): Promise<CanvasDetail> {
  const canvas = await newCanvas(s, { name: "Headless" });
  const prompt = specRegistry.instantiate("prompt", { position: { x: 0, y: 0 }, ctx });
  prompt.id = "n_prompt";
  prompt.params = { ...prompt.params, text: "A lighthouse at dusk" };
  const generate = specRegistry.instantiate("image.generate", { position: { x: 400, y: 0 }, ctx });
  generate.id = "n_gen";
  generate.params = {
    ...generate.params,
    model: MODEL,
    prompt: "long exposure",
    batch: 2,
    size: { kind: "aspect", ratio: "3:4" },
  };
  const graph = {
    ...emptyDocument(canvas.id, canvas.name, canvas.graph.createdAt),
    nodes: [prompt, generate],
    edges: [
      {
        id: "e_prompt",
        source: "n_prompt",
        sourceHandle: "text",
        target: "n_gen",
        targetHandle: "prompt",
        kind: "data" as const,
      },
    ],
  };
  const saved = await s.json<CanvasPatchResponse>(`/api/canvases/${canvas.id}`, {
    method: "PATCH",
    body: { graph, graphVersion: canvas.graphVersion },
  });
  expect(saved.status).toBe(200);
  return canvasDetailSchema.parse((await s.json(`/api/canvases/${canvas.id}`)).body);
}

/** Everything the editor's Run all does before it posts, from the saved document alone. */
async function compileSaved(detail: CanvasDetail, ctx: EngineContext) {
  const { slice } = fromDocument(detail.graph);
  const fingerprints = await resolveFingerprints(planFingerprints(slice, specRegistry, ctx), new Map());
  const outcome = compileRun({
    doc: slice,
    registry: specRegistry,
    ctx,
    fingerprints,
    request: { scope: "all", nodeIds: [] },
  });
  return { fingerprints, outcome };
}

function planOf(outcome: CompileOutcome): Extract<CompileOutcome, { kind: "plan" }> {
  if (outcome.kind !== "plan") throw new Error(`Expected a plan, got ${outcome.kind}`);
  return outcome;
}

describe("compiling a saved canvas on the server", () => {
  test("compiles to the plan the editor posts, runs, and then reads as up to date", async () => {
    server = await startTestServer();
    await saveKey(server);
    const ctx = await engineContext(server);
    const detail = await savedChain(server, ctx);

    const first = await compileSaved(detail, ctx);
    const plan = planOf(first.outcome);
    // Prompt isn't runnable: it hands its text to Generate, which carries it in its call.
    expect(plan.items.map((c) => c.item.nodeId)).toEqual(["n_gen"]);
    expect(plan.upToDate).toEqual([]);
    expect(plan.jobs).toBe(2);
    const [item] = plan.items.map((c) => c.item);
    expect(item!.fingerprint).toBe(first.fingerprints.n_gen!);
    expect(item!.calls).toEqual([
      expect.objectContaining({
        model: MODEL,
        op: "generate",
        prompt: "A lighthouse at dusk\nlong exposure",
        size: { kind: "aspect", ratio: "3:4" },
        batch: 2,
      }),
    ]);

    const body: CanvasRunBody = { scope: "all", nodeIds: [], plan: plan.items.map((c) => c.item) };
    const dry = await server.json(`/api/canvases/${detail.id}/run`, {
      method: "POST",
      body: { ...body, dryRun: true },
    });
    expect(dry.status).toBe(200);
    const preview = canvasRunResponseSchema.parse(dry.body);
    expect(preview.jobs).toBe(2);
    // The server prices the plan as the engine did.
    expect(preview.estimate).toMatchObject({ min: plan.estimate.min, max: plan.estimate.max });

    const run = await server.json(`/api/canvases/${detail.id}/run`, { method: "POST", body });
    expect(run.status).toBe(201);
    const { runId } = canvasRunResponseSchema.parse(run.body);
    expect((await finished(server, runId!)).status).toBe("succeeded");

    // The server wrote the result into the saved canvas; compiled again, nothing needs to run.
    const after = canvasDetailSchema.parse((await server.json(`/api/canvases/${detail.id}`)).body);
    const result = after.graph.nodes.find((n) => n.id === "n_gen")!.result;
    expect(result).toMatchObject({ state: "done", fingerprint: item!.fingerprint });
    expect(result!.assetIds).toHaveLength(2);
    const again = planOf((await compileSaved(after, ctx)).outcome);
    expect(again.upToDate).toEqual(["n_gen"]);
  });
});
