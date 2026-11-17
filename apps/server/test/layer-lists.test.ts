import { afterEach, describe, expect, test } from "bun:test";
import {
  type AssetListItem,
  type AssetsListResponse,
  type JobSetAccepted,
  newId,
  type UploadResponse,
  uploadResponseSchema,
} from "@openfield/core";
import { createFakeFetch } from "@openfield/providers/server";
import { completed, startTestServer, type TestServer } from "./helpers";
import { texture } from "./pixels";

// How a layer split shows in lists: browsing (the feed, All images) shows the base alone with how
// many layers it has, while search and folders list the layers too, each marked as one. The base
// that arrives live on job.output carries its count as well.

const PRO = "byteplus:dola-seedream-5-0-pro-260628";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(): Promise<TestServer> {
  const s = await startTestServer({ fetch: createFakeFetch({ delayMs: 0 }) });
  const res = await s.json("/api/settings/keys/byteplus", {
    method: "PUT",
    body: { apiKey: "ark-test-key" },
  });
  if (res.status !== 200) throw new Error(`Saving the key failed: ${JSON.stringify(res.body)}`);
  return s;
}

async function split(s: TestServer) {
  const form = new FormData();
  form.append("file", new File([await texture(1024, 1024)], "photo"));
  const uploaded = await s.request("/api/uploads", { method: "POST", body: form });
  const source: UploadResponse["asset"] = uploadResponseSchema.parse(await uploaded.json()).asset;
  const res = await s.json<JobSetAccepted>("/api/layers", {
    method: "POST",
    body: { idempotencyKey: newId(), model: PRO, image: source.id, size: "1K" },
  });
  expect(res.status).toBe(202);
  await completed(s, res.body.jobSet.id);
  return { source, runId: res.body.jobSet.id };
}

const list = async (s: TestServer, query: string) => {
  const res = await s.json<AssetsListResponse>(`/api/assets?${query}`);
  expect(res.status).toBe(200);
  return res.body;
};

describe("a layer split in lists", () => {
  test("All images shows the base with its count; search lists each layer as one", async () => {
    server = await start();
    const { source, runId } = await split(server);

    const all = await list(server, "modality=image");
    const base = all.items.find((a) => a.jobSetId === runId);
    expect(all.items.map((a) => a.id)).toEqual([base!.id, source.id]);
    expect(all.total).toBe(2);
    // The fake makes three layers.
    expect(base?.layer).toEqual({ role: "base", count: 3 });
    expect(all.items.find((a) => a.id === source.id)?.layer).toBeUndefined();

    const summary = await server.json<{ counts: { all: number } }>("/api/library/summary");
    expect(summary.body.counts.all).toBe(2);

    // Each layer is found by its own words (the fake's: "Part 1 of the picture").
    const found = await list(server, "q=picture&modality=image");
    expect(found.items).toHaveLength(3);
    for (const layer of found.items) expect(layer.layer).toEqual({ role: "layer" });
  });

  test("the base arrives live with its count, and a trashed layer leaves the count", async () => {
    server = await start();
    const { runId } = await split(server);
    const output = server.events.find(
      (e) => e.event === "job.output" && (e.data as { jobSetId: string }).jobSetId === runId,
    );
    const live = (output?.data as { asset: AssetListItem } | undefined)?.asset;
    expect(live).toBeDefined();
    if (!live) return;
    expect(live.layer).toEqual({ role: "base", count: 3 });

    const all = await list(server, "");
    const stack = await server.json<{ layers: { asset: { id: string }; role: string }[] }>(
      `/api/layers/${runId}`,
    );
    const first = stack.body.layers.find((l) => l.role === "layer")!.asset.id;
    const del = await server.request(`/api/assets/${first}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = await list(server, "");
    expect(after.items.find((a) => a.id === live.id)?.layer).toEqual({ role: "base", count: 2 });
    expect(all.items.find((a) => a.id === live.id)?.layer?.count).toBe(3);

    // Open tabs hear the base's new count without a reload, and again when the layer comes back.
    const baseUpdates = () =>
      server!.events
        .filter((e) => e.event === "asset.updated")
        .map((e) => (e.data as { asset: AssetListItem }).asset)
        .filter((a) => a.id === live.id);
    expect(baseUpdates().at(-1)?.layer).toEqual({ role: "base", count: 2 });
    const restored = await server.request(`/api/assets/${first}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect(baseUpdates().at(-1)?.layer).toEqual({ role: "base", count: 3 });
  });

  test("a layer's detail says it's a layer, and its neighbours in All images skip layers", async () => {
    server = await start();
    const { source, runId } = await split(server);
    const stack = await server.json<{ layers: { asset: { id: string }; role: string }[] }>(
      `/api/layers/${runId}`,
    );
    const base = stack.body.layers.find((l) => l.role === "base")!.asset.id;
    const layer = stack.body.layers.find((l) => l.role === "layer")!.asset.id;
    const detail = await server.json<{ asset: AssetListItem }>(`/api/assets/${layer}`);
    expect(detail.body.asset.layer).toEqual({ role: "layer" });
    const around = await server.json<{ previous: AssetListItem | null; next: AssetListItem | null }>(
      `/api/assets/${base}/neighbours`,
    );
    expect(around.body.previous).toBeNull();
    expect(around.body.next?.id).toBe(source.id);
  });
});
