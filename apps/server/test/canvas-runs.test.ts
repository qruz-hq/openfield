import { afterEach, describe, expect, test } from "bun:test";
import {
  CANVAS_CONFIRM_JOBS,
  cancelResponseSchema,
  canvasRunResponseSchema,
  canvasRunsResponseSchema,
  canvasSource,
  canvasSpendResponseSchema,
  errorEnvelopeSchema,
  newId,
  type SseEvent,
  usageResponseSchema,
} from "@openfield/core";
import type { CanvasRunRecord } from "@openfield/core/canvas";
import {
  assetsForJobSets,
  feedPage,
  getAsset,
  getCanvas,
  getCanvasRun,
  getJobSetByIdempotencyKey,
  getProviderBatchForJobSet,
  insertCanvasRun,
  jobSetsOfRun,
  jobsOf,
  listFolders,
  openDb,
  softDeleteAssets,
} from "@openfield/db";
import { createFakeFetch, type FetchLike } from "@openfield/providers/server";
import { call, finished, fromNode, item, libraryImages, MODEL, newCanvas, runFrames } from "./canvas-helpers";
import { gatedFetch, isGenerateCall, saveKey, startTestServer, type TestServer, waitFor } from "./helpers";

// Canvas runs end to end on the fake provider (M4-10, M4-16, M4-17): ordering, fan-out, the
// result cache, the 32-job rail, Stop, and picking a run up again after a restart.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Prompt → Generate (2 images) → Variations. The prompt is already resolved into the calls. */
function chain() {
  const generate = item("n_gen", {
    calls: [call({ prompt: "Lighthouse at dusk\nlong exposure", batch: 2 })],
  });
  const variations = item("n_var", {
    type: "image.variations",
    inputs: [fromNode("n_gen")],
    calls: [call({ op: "variation", prompt: "Lighthouse at dusk\nlong exposure" })],
  });
  return { generate, variations };
}

describe("running a canvas", () => {
  test("prompt, generator and variations run in order, fan out and land in the library", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { generate, variations } = chain();

    const res = await server.json(`/api/canvases/${canvas.id}/run`, {
      method: "POST",
      body: { scope: "all", nodeIds: ["n_gen", "n_var"], plan: [generate, variations] },
    });
    expect(res.status).toBe(201);
    const started = canvasRunResponseSchema.parse(res.body);
    // Variations waits for Generate, so only Generate's job set exists yet.
    expect(started.jobSets.map((j) => j.nodeId)).toEqual(["n_gen"]);
    // 2 from Generate, then Variations once per image: 2 more.
    expect(started.jobs).toBe(4);
    expect(started.nodes.map((n) => [n.nodeId, n.jobs])).toEqual([
      ["n_gen", 2],
      ["n_var", 2],
    ]);
    expect(started.estimate.max).toBeGreaterThan(0);

    const done = await finished(server, started.runId!);
    expect(done.status).toBe("succeeded");
    const [gen, vari] = done.nodes;
    expect(gen).toMatchObject({
      nodeId: "n_gen",
      state: "done",
      done: 2,
      total: 2,
      fingerprint: generate.fingerprint,
    });
    expect(gen!.assetIds).toHaveLength(2);
    expect(vari).toMatchObject({ nodeId: "n_var", state: "done", done: 2, total: 2 });
    expect(vari!.jobSetIds).toHaveLength(2);
    // One job set per fanned-out image, labelled by which image it came from.
    expect(vari!.outputs.map((o) => o.source).sort()).toEqual([0, 1]);
    expect(vari!.outputs.every((o) => o.model === MODEL && o.call === 0)).toBe(true);
    expect(gen!.costUsd).toBeGreaterThan(0);

    const { db } = server.services;
    const sets = jobSetsOfRun(db, started.runId!);
    expect(sets).toHaveLength(3);
    // Run all queues behind anything the person starts by hand (§0.12).
    expect(sets.every((s) => s.priority === 5 && s.source === "canvas" && s.canvasId === canvas.id)).toBe(
      true,
    );
    // Each Variations job set got one of Generate's images as its reference.
    const refs = sets
      .filter((s) => s.canvasNodeId === "n_var")
      .map((s) => s.requestJson.references?.map((r) => r.assetId));
    expect(refs.flat().sort()).toEqual([...gen!.assetIds].sort());

    for (const assetId of [...gen!.assetIds, ...vari!.assetIds]) {
      const asset = getAsset(db, assetId)!;
      expect(asset.opParams).toMatchObject({
        source: canvasSource(canvas.id, asset.jobSetId === sets[0]!.id ? "n_gen" : "n_var"),
      });
    }
    // Canvas runs show in the feed like any other run, and are filed under the canvas's name.
    expect(feedPage(db).items).toHaveLength(4);
    const folderId = getCanvas(db, canvas.id)!.folderId!;
    expect(feedPage(db, { folderId }).items).toHaveLength(4);

    const runs = canvasRunsResponseSchema.parse(
      (await server.json(`/api/canvases/${canvas.id}/runs?since=${encodeURIComponent(done.createdAt)}`)).body,
    );
    expect(runs.runs.map((r) => [r.runId, r.status])).toEqual([[started.runId!, "succeeded"]]);
    // Without since, only runs still going.
    expect(
      canvasRunsResponseSchema.parse((await server.json(`/api/canvases/${canvas.id}/runs`)).body).runs,
    ).toEqual([]);

    // The folder follows the canvas's name.
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { name: "Harbor", graphVersion: 1 },
    });
    expect(listFolders(db).find((f) => f.id === folderId)?.name).toBe("Harbor");
  });

  test("a canvas's spend counts its own runs by Spending's rules, and nothing from another canvas", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const other = await newCanvas(server);
    const spend = async (id: string) => {
      const res = await server!.json(`/api/canvases/${id}/spend`);
      expect(res.status).toBe(200);
      return canvasSpendResponseSchema.parse(res.body);
    };
    expect(await spend(canvas.id)).toEqual({ usd: 0, images: 0, usdDiscarded: 0, currency: "USD" });

    const { generate, variations } = chain();
    const res = await server.json(`/api/canvases/${canvas.id}/run`, {
      method: "POST",
      body: { scope: "all", nodeIds: ["n_gen", "n_var"], plan: [generate, variations] },
    });
    const started = canvasRunResponseSchema.parse(res.body);
    expect((await finished(server, started.runId!)).status).toBe("succeeded");
    // Usage is logged as each image lands; the run's end is after the last.
    for (const until = Date.now() + 5_000; (await spend(canvas.id)).images < 4 && Date.now() < until; )
      await Bun.sleep(20);

    // The same figure Settings > Spending and the top nav's Spent today count for these runs.
    const usage = usageResponseSchema.parse(
      (await server.json("/api/usage?from=1970-01-01T00:00:00.000Z&groupBy=day")).body,
    );
    const mine = await spend(canvas.id);
    expect(mine.usd).toBe(usage.totalUsd);
    expect(mine.images).toBe(usage.rows.reduce((sum, r) => sum + r.images, 0));
    expect(await spend(other.id)).toMatchObject({ usd: 0, images: 0 });

    const missing = await server.json(`/api/canvases/${newId()}/spend`);
    expect(missing.status).toBe(404);
  });

  test("a single node run goes ahead of run-all work", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const res = await server.json(`/api/canvases/${canvas.id}/run`, {
      method: "POST",
      body: { scope: "node", nodeIds: ["n_gen"], plan: [item("n_gen")] },
    });
    const run = canvasRunResponseSchema.parse(res.body);
    await finished(server, run.runId!);
    expect(jobSetsOfRun(server.services.db, run.runId!).map((s) => s.priority)).toEqual([10]);
  });

  test("a single node that brings its earlier nodes along waits its turn like a batch", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { generate, variations } = chain();
    const res = await server.json(`/api/canvases/${canvas.id}/run`, {
      method: "POST",
      body: { scope: "node", nodeIds: ["n_var"], plan: [generate, variations] },
    });
    const run = canvasRunResponseSchema.parse(res.body);
    await finished(server, run.runId!);
    expect(new Set(jobSetsOfRun(server.services.db, run.runId!).map((s) => s.priority))).toEqual(
      new Set([5]),
    );
  });

  test("deleting a canvas stops its run: nothing more is sent, and nothing fails in the log", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { generate, variations } = chain();
    const started = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "all", nodeIds: [], plan: [generate, variations] },
        })
      ).body,
    );
    await waitFor(() => gate.state.calls > 0 || undefined);
    expect((await server.json(`/api/canvases/${canvas.id}`, { method: "DELETE" })).status).toBe(200);
    gate.release();
    const sets = () =>
      server!.services.db.$client
        .query<{ status: string; canvas_node_id: string }, []>("SELECT status, canvas_node_id FROM job_sets")
        .all();
    await waitFor(() => sets().every((s) => s.status !== "pending" && s.status !== "running") || undefined);
    // Generate's job set was stopped, and Variations never got one.
    expect(sets().map((s) => s.canvas_node_id)).toEqual(["n_gen"]);
    expect(sets()[0]!.status).toBe("canceled");
    await Bun.sleep(50);
    expect(sets()).toHaveLength(1);
    expect(started.runId).toBeTruthy();
    // Open tabs hear that the run ended, or they'd count it as running until they reconnect.
    expect(runFrames(server, started.runId!).at(-1)).toMatchObject({
      status: "canceled",
      finishedAt: expect.any(String),
    });
    const log = await Bun.file(`${server.home}/logs/openfield.log`)
      .text()
      .catch(() => "");
    expect(log).not.toContain("couldn't start");
  });

  test("running again with nothing changed calls no provider and reports every node up to date", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    server = await startTestServer({ fetch });
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { generate, variations } = chain();
    const body = { scope: "all", nodeIds: ["n_gen", "n_var"], plan: [generate, variations] };
    const first = canvasRunResponseSchema.parse(
      (await server.json(`/api/canvases/${canvas.id}/run`, { method: "POST", body })).body,
    );
    const done = await finished(server, first.runId!);
    const calls = fetch.calls.filter((c) => isGenerateCall(c.url)).length;
    expect(calls).toBe(4);

    const cachedOf = (i: number) => ({
      fingerprint: done.nodes[i]!.fingerprint,
      assetIds: done.nodes[i]!.assetIds,
    });
    const again = {
      ...body,
      plan: [
        { ...generate, cached: cachedOf(0) },
        { ...variations, cached: cachedOf(1) },
      ],
    };
    const preview = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { ...again, dryRun: true },
        })
      ).body,
    );
    expect(preview).toMatchObject({ runId: null, jobSets: [], jobs: 0 });
    expect(preview.estimate).toMatchObject({ max: 0, confidence: "exact" });

    const res = await server.json(`/api/canvases/${canvas.id}/run`, { method: "POST", body: again });
    const second = canvasRunResponseSchema.parse(res.body);
    expect(second.skipped).toEqual([
      { nodeId: "n_gen", reason: "cached" },
      { nodeId: "n_var", reason: "cached" },
    ]);
    const end = await finished(server, second.runId!);
    expect(end.status).toBe("succeeded");
    expect(end.nodes.map((n) => n.state)).toEqual(["cached", "cached"]);
    expect(end.nodes[1]!.assetIds).toEqual(done.nodes[1]!.assetIds);
    expect(fetch.calls.filter((c) => isGenerateCall(c.url)).length).toBe(calls);

    // Bypassing the cache, or an image gone from the library, runs the node again.
    softDeleteAssets(server.services.db, [done.nodes[1]!.assetIds[0]!]);
    const third = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { ...again, plan: [{ ...again.plan[0], bypassCache: true }, again.plan[1]], dryRun: true },
        })
      ).body,
    );
    expect(third.skipped).toEqual([]);
    expect(third.jobs).toBe(4);
  });

  test("a dry run writes nothing, and a run over 32 jobs needs confirming", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    // 9 images into a single input, 4 each: 36 jobs.
    const images = (await libraryImages(server, 9)).map((assetId) => ({ kind: "asset" as const, assetId }));
    const plan = [
      item("n_var", {
        type: "image.variations",
        inputs: [{ port: "image", to: "references", role: "subject", arity: "single", values: images }],
        calls: [call({ op: "variation", batch: 4 })],
      }),
    ];
    const dry = await server.json(`/api/canvases/${canvas.id}/run`, {
      method: "POST",
      body: { scope: "node", nodeIds: ["n_var"], plan, dryRun: true },
    });
    expect(dry.status).toBe(200);
    expect(canvasRunResponseSchema.parse(dry.body)).toMatchObject({ runId: null, jobs: 36 });
    expect(jobSetsOfRun(server.services.db, "none")).toEqual([]);

    const refused = await server.json(`/api/canvases/${canvas.id}/run`, {
      method: "POST",
      body: { scope: "node", nodeIds: ["n_var"], plan },
    });
    expect(refused.status).toBe(409);
    const error = errorEnvelopeSchema.parse(refused.body).error;
    expect(error).toMatchObject({ code: "conflict", field: "confirmed" });
    expect(error.userMessage).toContain("36 images");
    expect(36).toBeGreaterThan(CANVAS_CONFIRM_JOBS);
  });

  test("a plan that reads from a later node, or a missing canvas, is refused", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { generate, variations } = chain();
    const backwards = await server.json(`/api/canvases/${canvas.id}/run`, {
      method: "POST",
      body: { scope: "all", nodeIds: [], plan: [variations, generate] },
    });
    expect(backwards.status).toBe(400);
    expect(errorEnvelopeSchema.parse(backwards.body).error.field).toBe("plan.0.inputs.0.values.0.nodeId");

    const missing = await server.json(`/api/canvases/${newId()}/run`, {
      method: "POST",
      body: { scope: "all", nodeIds: [], plan: [generate] },
    });
    expect(missing.status).toBe(404);
  });

  test("a model without a key blocks its node, naming the key before anything upstream", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    const { generate, variations } = chain();
    const res = await server.json(`/api/canvases/${canvas.id}/run`, {
      method: "POST",
      body: { scope: "all", nodeIds: [], plan: [generate, variations] },
    });
    const run = canvasRunResponseSchema.parse(res.body);
    // Both nodes use the same model: adding the key is the fix for each.
    expect(run.nodes.map((n) => n.blocked)).toEqual(["no_key", "no_key"]);
    expect(run.jobs).toBe(0);
    const end = await finished(server, run.runId!);
    expect(end.status).toBe("failed");
    expect(end.nodes.map((n) => [n.state, n.blocked])).toEqual([
      ["blocked", "no_key"],
      ["blocked", "no_key"],
    ]);
  });

  test("a node whose images all fail blocks what reads from it", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { generate, variations } = chain();
    const failing = {
      ...generate,
      calls: [call({ prompt: "a harbor #fake:refused-image-safety", batch: 1 })],
    };
    const run = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "all", nodeIds: [], plan: [failing, variations] },
        })
      ).body,
    );
    const end = await finished(server, run.runId!);
    expect(end.status).toBe("failed");
    expect(end.nodes[0]).toMatchObject({ state: "failed", error: { code: "content_refused" } });
    expect(end.nodes[1]).toMatchObject({ state: "blocked", blocked: "upstream_failed" });
  });

  test("a node where some images fail ends failed, keeps what it made and isn't reused", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const plan = [
      item("n_var", {
        type: "image.variations",
        calls: [
          call({ op: "variation", prompt: "a harbor" }),
          call({ op: "variation", prompt: "a harbor #fake:refused-image-safety" }),
        ],
      }),
    ];
    const run = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "node", nodeIds: ["n_var"], plan },
        })
      ).body,
    );
    const end = await finished(server, run.runId!);
    expect(end.nodes[0]).toMatchObject({
      state: "failed",
      done: 2,
      total: 2,
      error: { code: "content_refused" },
    });
    expect(end.nodes[0]!.assetIds).toHaveLength(1);
    expect(end.status).toBe("failed");
  });

  test("a node's settled result goes into the saved canvas without moving its version", async () => {
    server = await startTestServer();
    await saveKey(server);
    const graph = {
      ...(await newCanvas(server)).graph,
      nodes: [
        {
          id: "n_gen",
          type: "image.generate" as const,
          typeVersion: 1,
          position: { x: 0, y: 0 },
          parentId: null,
          collapsed: false,
          title: null,
          params: { model: MODEL, prompt: "A lighthouse at dusk" },
          presetLocks: [],
          result: null,
        },
      ],
    };
    const canvas = await newCanvas(server, { graph });
    const { generate } = chain();
    const run = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "node", nodeIds: ["n_gen"], plan: [generate] },
        })
      ).body,
    );
    const end = await finished(server, run.runId!);
    const saved = (await server.json(`/api/canvases/${canvas.id}`)).body as typeof canvas;
    expect(saved.graphVersion).toBe(1);
    const result = saved.graph.nodes[0]!.result!;
    expect(result).toMatchObject({ state: "done", fingerprint: generate.fingerprint });
    expect(result.assetIds).toEqual(end.nodes[0]!.assetIds);
    expect(result.ranAt).toBe(end.nodes[0]!.finishedAt);
    // Renaming from the index afterwards keeps it: it's the saved canvas, not a later catch-up.
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { name: "Fox", graphVersion: 1 },
    });
    const renamed = (await server.json(`/api/canvases/${canvas.id}`)).body as typeof canvas;
    expect(renamed.graph.nodes[0]!.result?.assetIds).toEqual(result.assetIds);
  });

  test("a later run that fails without an image keeps the saved images beside the error", async () => {
    server = await startTestServer();
    await saveKey(server);
    const node = {
      id: "n_gen",
      type: "image.generate" as const,
      typeVersion: 1,
      position: { x: 0, y: 0 },
      parentId: null,
      collapsed: false,
      title: null,
      params: { model: MODEL, prompt: "A lighthouse at dusk" },
      presetLocks: [],
      result: null,
    };
    const canvas = await newCanvas(server, { graph: { ...(await newCanvas(server)).graph, nodes: [node] } });
    const { generate } = chain();
    const post = async (plan: unknown[]) =>
      finished(
        server!,
        canvasRunResponseSchema.parse(
          (
            await server!.json(`/api/canvases/${canvas.id}/run`, {
              method: "POST",
              body: { scope: "node", nodeIds: ["n_gen"], plan },
            })
          ).body,
        ).runId!,
      );
    const first = await post([generate]);
    const refused = {
      ...generate,
      calls: [call({ prompt: "a harbor #fake:refused", batch: 2 })],
      bypassCache: true,
    };
    const second = await post([refused]);
    expect(second.nodes[0]).toMatchObject({ state: "failed", assetIds: [] });
    const saved = (await server.json(`/api/canvases/${canvas.id}`)).body as typeof canvas;
    expect(saved.graph.nodes[0]!.result).toMatchObject({
      state: "failed",
      error: { code: "content_refused" },
      assetIds: first.nodes[0]!.assetIds,
      jobSetIds: second.nodes[0]!.jobSetIds,
    });
  });

  test("a node already waiting or working in a run can't be sent again", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { generate } = chain();
    const body = { scope: "all", nodeIds: [], plan: [generate] };
    const first = canvasRunResponseSchema.parse(
      (await server.json(`/api/canvases/${canvas.id}/run`, { method: "POST", body })).body,
    );
    const again = await server.json(`/api/canvases/${canvas.id}/run`, { method: "POST", body });
    expect(again.status).toBe(409);
    expect(errorEnvelopeSchema.parse(again.body).error).toMatchObject({
      code: "conflict",
      field: "plan.0.nodeId",
      userMessage: "This node is already running.",
    });
    gate.release();
    await finished(server, first.runId!);
    expect(jobSetsOfRun(server.services.db, first.runId!)).toHaveLength(1);
  });

  test("a plan naming a node locked in the saved canvas is refused before anything is sent", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    const canvas = await newCanvas(server);
    const locked = {
      id: "n_gen",
      type: "image.generate",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      parentId: null,
      collapsed: false,
      title: "Key visual",
      params: { prompt: "A lighthouse at dusk" },
      presetLocks: [],
      result: null,
      locked: true,
    };
    const saved = await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graphVersion: canvas.graphVersion, graph: { ...canvas.graph, nodes: [locked] } },
    });
    expect(saved.status).toBe(200);
    const { generate } = chain();
    const refused = await server.json(`/api/canvases/${canvas.id}/run`, {
      method: "POST",
      body: { scope: "all", nodeIds: [], plan: [generate] },
    });
    expect(refused.status).toBe(409);
    expect(errorEnvelopeSchema.parse(refused.body).error).toMatchObject({
      code: "conflict",
      field: "plan.0.nodeId",
      userMessage: "Key visual is locked, so it didn't run. The canvas may have changed in another tab.",
    });
    gate.release();
    expect(gate.state.calls).toBe(0);
  });

  test("an image that isn't in the library blocks the node and says why", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const plan = [
      item("n_gen", {
        inputs: [
          {
            port: "input_images",
            to: "references",
            role: "subject",
            arity: "multi",
            values: [{ kind: "asset", assetId: newId() }],
          },
        ],
      }),
    ];
    const res = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "node", nodeIds: ["n_gen"], plan, dryRun: true },
        })
      ).body,
    );
    expect(res.nodes[0]).toMatchObject({ blocked: "missing_asset", jobs: 0 });
  });

  test("a result is reused only while what it read is reused too", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    server = await startTestServer({ fetch });
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { generate, variations } = chain();
    const body = { scope: "all", nodeIds: [], plan: [generate, variations] };
    const first = canvasRunResponseSchema.parse(
      (await server.json(`/api/canvases/${canvas.id}/run`, { method: "POST", body })).body,
    );
    const done = await finished(server, first.runId!);
    const cachedOf = (i: number) => ({
      fingerprint: done.nodes[i]!.fingerprint,
      assetIds: done.nodes[i]!.assetIds,
    });
    // ⌥ on Generate makes new images, so Variations runs on them instead of being skipped.
    const dry = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: {
            ...body,
            dryRun: true,
            plan: [
              { ...generate, cached: cachedOf(0), bypassCache: true },
              { ...variations, cached: cachedOf(1) },
            ],
          },
        })
      ).body,
    );
    expect(dry.skipped).toEqual([]);
    expect(dry.jobs).toBe(4);
    // The images a node read come back with it, so the browser can tell when they change.
    expect(done.nodes[1]!.inputs).toEqual([...done.nodes[0]!.assetIds].sort());
  });

  test("a run that would make more than the limit is refused before anything is built", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    // 4 images, then 8 takes of each, then 8 of each of those, then 8 more: 2,340 jobs.
    const takes = () => [call({ op: "variation", batch: 4 }), call({ op: "variation", batch: 4 })];
    const plan = [
      item("n_gen", { calls: [call({ batch: 4 })] }),
      item("n_a", { type: "image.variations", inputs: [fromNode("n_gen")], calls: takes() }),
      item("n_b", { type: "image.variations", inputs: [fromNode("n_a")], calls: takes() }),
      item("n_c", { type: "image.variations", inputs: [fromNode("n_b")], calls: takes() }),
    ];
    for (const dryRun of [true, false]) {
      const res = await server.json(`/api/canvases/${canvas.id}/run`, {
        method: "POST",
        body: { scope: "all", nodeIds: [], plan, dryRun, confirmed: true },
      });
      expect(res.status).toBe(409);
      expect(errorEnvelopeSchema.parse(res.body).error.userMessage).toContain("1,000 images");
    }
  });
});

describe("speeds (§0.3, §0.13)", () => {
  const PRO = "google:gemini-3-pro-image" as const;

  test("each node runs and is priced at its company's speed, and a model without it at Standard", async () => {
    server = await startTestServer();
    await saveKey(server);
    await server.json("/api/providers/google/settings", {
      method: "PATCH",
      body: { values: { speed: "flex" } },
    });
    const canvas = await newCanvas(server);
    const plan = [item("n_pro", { model: PRO, calls: [call({ model: PRO })] }), item("n_nb2")];
    const body = { scope: "all", nodeIds: [], plan };

    const dry = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { ...body, dryRun: true },
        })
      ).body,
    );
    // Pro has Flex, at half its 0.134 Standard price. Nano Banana 2 doesn't, so it prices at Standard.
    const [pro, nb2] = dry.nodes;
    expect([pro!.estimate.max, nb2!.estimate.max]).toEqual([0.067, 0.067]);
    expect(pro!.estimate.basis).toContain("Flex");
    expect(nb2!.estimate.basis).not.toContain("Flex");

    const run = canvasRunResponseSchema.parse(
      (await server.json(`/api/canvases/${canvas.id}/run`, { method: "POST", body })).body,
    );
    expect((await finished(server, run.runId!)).status).toBe("succeeded");
    // Both start at once, so their job sets can land in either order.
    const sets = jobSetsOfRun(server.services.db, run.runId!).sort((a, b) =>
      (a.canvasNodeId ?? "").localeCompare(b.canvasNodeId ?? ""),
    );
    expect(sets.map((s) => [s.canvasNodeId, s.speed, s.costEstimateUsd])).toEqual([
      ["n_nb2", "standard", 0.067],
      ["n_pro", "flex", 0.067],
    ]);
  });

  test("a node at Batch goes as one provider batch, and its frames name the canvas", async () => {
    // The fake batch follows this clock, so the test decides when the company finishes.
    const clock = { now: Date.now() };
    const fetch = createFakeFetch({ delayMs: 0, now: () => clock.now });
    server = await startTestServer({ fetch, queue: { batchPollMs: 15 } });
    await saveKey(server);
    await server.json("/api/providers/google/settings", {
      method: "PATCH",
      body: { values: { speed: "batch" } },
    });
    const canvas = await newCanvas(server);
    const run = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "node", nodeIds: ["n_gen"], plan: [item("n_gen")] },
        })
      ).body,
    );
    const db = server.services.db;
    const [set] = await waitFor(() => {
      const sets = jobSetsOfRun(db, run.runId!);
      return sets.length ? sets : undefined;
    });
    expect(set!.speed).toBe("batch");
    await waitFor(() => getProviderBatchForJobSet(db, set!.id)?.remoteId);
    clock.now += 60_000;
    expect((await finished(server, run.runId!)).status).toBe("succeeded");

    // So the finish notice's Show opens this canvas rather than the Image feed.
    const frames = server.events
      .filter((e) => e.event === "batch.updated")
      .map((e) => e.data as Extract<SseEvent, { event: "batch.updated" }>["data"]);
    expect(frames.at(-1)).toMatchObject({ jobSetId: set!.id, finished: true, state: "succeeded" });
    expect(frames.every((f) => f.canvasId === canvas.id)).toBe(true);
  });

  test("in fake mode a canvas run shows real prices but records $0 and never counts toward spend", async () => {
    server = await startTestServer({ env: { OPENFIELD_FAKE_PROVIDERS: "1" } });
    await saveKey(server);
    const canvas = await newCanvas(server);
    const run = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "node", nodeIds: ["n_gen"], plan: [item("n_gen", { calls: [call({ batch: 2 })] })] },
        })
      ).body,
    );
    expect(run.estimate.max).toBe(0.134);
    const done = await finished(server, run.runId!);
    expect(done.nodes[0]).toMatchObject({ state: "done", costUsd: 0 });
    const rows = server.services.db.$client
      .query<{ cost_usd: number; simulated: number }, []>("SELECT cost_usd, simulated FROM usage_log")
      .all();
    expect(rows).toEqual([
      { cost_usd: 0, simulated: 1 },
      { cost_usd: 0, simulated: 1 },
    ]);
  });
});

describe("stopping a run", () => {
  test("Stop cancels what's in flight and every node that hadn't started", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { generate, variations } = chain();
    const run = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "all", nodeIds: [], plan: [generate, variations] },
        })
      ).body,
    );
    await waitFor(() => gate.state.active > 0);
    const res = await server.json(`/api/canvases/${canvas.id}/runs/${run.runId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(cancelResponseSchema.parse(res.body).canceled).toEqual([run.jobSets[0]!.jobSetId]);
    gate.release();

    const end = await finished(server, run.runId!);
    expect(end.status).toBe("canceled");
    expect(end.nodes.map((n) => n.state)).toEqual(["canceled", "canceled"]);
    // Variations never got a job set.
    expect(jobSetsOfRun(server.services.db, run.runId!)).toHaveLength(1);
    expect(end.nodes[1]!.jobSetIds).toEqual([]);

    const again = await server.json(`/api/canvases/${canvas.id}/runs/${run.runId}/cancel`, {
      method: "POST",
    });
    expect(cancelResponseSchema.parse(again.body)).toEqual({
      canceled: [],
      notCancelable: [run.jobSets[0]!.jobSetId],
    });
    const unknown = await server.json(`/api/canvases/${canvas.id}/runs/${newId()}/cancel`, {
      method: "POST",
    });
    expect(unknown.status).toBe(404);
  });

  test("a node stopped part way keeps the images it made and still says it was stopped", async () => {
    // The first image comes straight back; the second waits until Stop aborts it.
    const inner = createFakeFetch({ delayMs: 0 });
    let generateCalls = 0;
    const fetch: FetchLike = async (input, init) => {
      if (isGenerateCall(input) && ++generateCalls > 1) {
        await new Promise<void>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
        );
      }
      return inner(input, init);
    };
    server = await startTestServer({ fetch });
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { generate } = chain();
    const run = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "node", nodeIds: ["n_gen"], plan: [generate] },
        })
      ).body,
    );
    const { db } = server.services;
    await waitFor(() => assetsForJobSets(db, [run.jobSets[0]!.jobSetId]).length === 1);
    await server.json(`/api/canvases/${canvas.id}/runs/${run.runId}/cancel`, { method: "POST" });

    const end = await finished(server, run.runId!);
    expect(end.nodes[0]).toMatchObject({ state: "canceled", done: 2, total: 2 });
    expect(end.nodes[0]!.assetIds).toHaveLength(1);
    expect(end.status).toBe("canceled");
  });

  test("a node's Cancel stops it and what reads from it, and the rest carries on", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    const canvas = await newCanvas(server);
    const { generate, variations } = chain();
    const other = item("n_other", { calls: [call({ prompt: "A boat at dawn" })] });
    const run = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "all", nodeIds: [], plan: [generate, variations, other] },
        })
      ).body,
    );
    await waitFor(() => gate.state.active > 0);
    // Variations hasn't started: canceling it leaves Generate and the other node running.
    const res = await server.json(`/api/canvases/${canvas.id}/runs/${run.runId}/nodes/n_var/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    gate.release();
    const end = await finished(server, run.runId!);
    expect(end.nodes.map((n) => [n.nodeId, n.state])).toEqual([
      ["n_gen", "done"],
      ["n_var", "canceled"],
      ["n_other", "done"],
    ]);
    expect(end.status).toBe("partial");
    const unknown = await server.json(`/api/canvases/${canvas.id}/runs/${run.runId}/nodes/n_none/cancel`, {
      method: "POST",
    });
    // The run is over: nothing left to cancel.
    expect(unknown.status).toBe(200);
  });
});

describe("crash recovery (§8.4.5)", () => {
  test("a run recorded but never started is picked up on the next boot and finishes", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const home = server.home;
    await server.close({ keepHome: true });
    server = undefined;

    // What the database holds when Openfield stops right after recording Generate's launch.
    const { generate, variations } = chain();
    const runId = newId();
    const key = newId();
    const record: CanvasRunRecord = {
      nodeIds: ["n_gen", "n_var"],
      items: [generate, variations],
      launches: [
        {
          nodeId: "n_gen",
          call: 0,
          source: 0,
          request: {
            ...generate.calls[0]!,
            seed: undefined,
            idempotencyKey: key,
            source: "canvas",
            canvas: { canvasId: canvas.id, nodeId: "n_gen" },
          },
          jobSetId: null,
          error: null,
        },
      ],
      canceled: false,
      canceledNodes: [],
      agent: null,
    };
    const opened = openDb(`${home}/openfield.db`);
    insertCanvasRun(opened.db, { id: runId, canvasId: canvas.id, scope: "all", plan: record, priority: 5 });
    opened.close();

    server = await startTestServer({ home });
    const { db } = server.services;
    const row = await waitFor(() => {
      const r = getCanvasRun(db, runId);
      return r?.finishedAt ? r : undefined;
    });
    expect(row.status).toBe("succeeded");
    const set = getJobSetByIdempotencyKey(db, key)!;
    expect(set.canvasRunId).toBe(runId);
    expect(row.nodes.map((n) => [n.nodeId, n.state, n.assetIds.length])).toEqual([
      ["n_gen", "done", 2],
      ["n_var", "done", 2],
    ]);
    expect(jobSetsOfRun(db, runId)).toHaveLength(3);
  });

  /** Starts Prompt → Generate (2) → Variations and stops Openfield while Generate's images are out. */
  async function stopMidCall(opts: { rerunInterrupted?: boolean } = {}) {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    if (opts.rerunInterrupted === false) {
      await server.json("/api/settings", { method: "PATCH", body: { rerunInterrupted: false } });
    }
    const canvas = await newCanvas(server);
    const { generate, variations } = chain();
    const run = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "all", nodeIds: [], plan: [generate, variations] },
        })
      ).body,
    );
    // Both of Generate's images are with the provider when the stop cuts them off.
    await waitFor(() => gate.state.active === 2);
    const home = server.home;
    await server.close({ keepHome: true });
    return { run, home };
  }

  const settled = (runId: string) =>
    waitFor(() => {
      const r = getCanvasRun(server!.services.db, runId);
      return r?.finishedAt ? r : undefined;
    });

  test("a node caught mid-call runs again once at the next start, says so, and the run finishes", async () => {
    const { run, home } = await stopMidCall();

    const fetch = createFakeFetch({ delayMs: 0 });
    server = await startTestServer({ home, fetch });
    const { db } = server.services;
    const row = await settled(run.runId!);
    expect(row.status).toBe("succeeded");
    expect(row.nodes.map((n) => [n.nodeId, n.state, n.assetIds.length])).toEqual([
      ["n_gen", "done", 2],
      ["n_var", "done", 2],
    ]);
    // §0.4's one-time re-run, like any image: sent once more, and marked as run again.
    const set = run.jobSets[0]!.jobSetId;
    const jobs = jobsOf(db, set);
    expect(jobs.map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
    expect(jobs.every((j) => j.rerunAt !== null && j.attempt === 1)).toBe(true);
    expect(assetsForJobSets(db, [set])).toHaveLength(2);
    // Generate's two again, then Variations' two.
    expect(fetch.calls.filter((c) => isGenerateCall(c.url))).toHaveLength(4);
  });

  test("with running again turned off, a node caught mid-call is interrupted, never sent again, and blocks what depends on it", async () => {
    const { run, home } = await stopMidCall({ rerunInterrupted: false });

    const fetch = createFakeFetch({ delayMs: 0 });
    server = await startTestServer({ home, fetch });
    const { db } = server.services;
    const row = await settled(run.runId!);
    expect(row.status).toBe("failed");
    expect(row.nodes.map((n) => [n.state, n.blocked, n.error?.code ?? null])).toEqual([
      ["failed", null, "unknown"],
      ["blocked", "upstream_failed", null],
    ]);
    expect(row.nodes[0]!.error?.reason).toBe("Openfield stopped before this finished.");
    const set = run.jobSets[0]!.jobSetId;
    expect(jobsOf(db, set).map((j) => [j.status, j.rerunAt])).toEqual([
      ["interrupted", null],
      ["interrupted", null],
    ]);
    // Sending it again could bill twice, so nothing is.
    expect(fetch.calls.filter((c) => isGenerateCall(c.url))).toHaveLength(0);
    expect(assetsForJobSets(db, [set])).toHaveLength(0);
  });

  test("a node on a model that resumes is left at the company, picked up by its id, and never sent twice", async () => {
    const RESUMABLE = "fake:resumable-image" as const;
    const env = { OPENFIELD_FAKE_PROVIDERS: "1", OPENFIELD_FAKE_API_KEY: "fake-test-key" };
    const queue = { poll: { firstMs: 5, factor: 1, capMs: 5 } };
    // The test company's call is queued for 1 s, then running until 4 s, on this clock.
    const clock = { now: Date.now() };
    const fake = createFakeFetch({ delayMs: 0, now: () => clock.now });
    const creates = () => fake.calls.filter((c) => c.method === "POST" && /\/v1\/images$/.test(c.url)).length;

    server = await startTestServer({ fetch: fake, env, queue });
    await saveKey(server);
    const canvas = await newCanvas(server);
    const generate = item("n_gen", { model: RESUMABLE, calls: [call({ model: RESUMABLE })] });
    const { variations } = chain();
    const run = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "all", nodeIds: [], plan: [generate, variations] },
        })
      ).body,
    );
    const set = run.jobSets[0]!.jobSetId;
    await waitFor(() => jobsOf(server!.services.db, set)[0]?.handle ?? undefined);
    const home = server.home;
    await server.close({ keepHome: true });
    // Left running at the company, with its id stored.
    const peek = openDb(`${home}/openfield.db`);
    expect(jobsOf(peek.db, set)[0]).toMatchObject({ status: "running", resumable: true });
    peek.close();

    clock.now += 5_000;
    server = await startTestServer({ home, fetch: fake, env, queue });
    const { db } = server.services;
    const row = await settled(run.runId!);
    expect(row.status).toBe("succeeded");
    expect(row.nodes.map((n) => [n.nodeId, n.state, n.assetIds.length])).toEqual([
      ["n_gen", "done", 1],
      ["n_var", "done", 1],
    ]);
    expect(jobsOf(db, set)[0]).toMatchObject({ status: "succeeded", rerunAt: null });
    expect(jobsOf(db, set)[0]!.resumedAt).not.toBeNull();
    expect(creates()).toBe(1);
  });
});

describe("the run state frames", () => {
  test("every canvas_run.updated frame parses and the last one is terminal", async () => {
    server = await startTestServer();
    await saveKey(server);
    const canvas = await newCanvas(server);
    const run = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "node", nodeIds: ["n_gen"], plan: [item("n_gen", { calls: [call({ batch: 3 })] })] },
        })
      ).body,
    );
    await finished(server, run.runId!);
    const frames = runFrames(server, run.runId!);
    expect(frames[0]!.nodes[0]!.state).toBe("queued");
    expect(frames.at(-1)!.status).toBe("succeeded");
    expect(frames.filter((f) => f.finishedAt !== null)).toHaveLength(1);
  });
});
