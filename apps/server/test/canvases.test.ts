import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANVAS_AUTO_VERSION_MS,
  CANVAS_PREVIEW_MAX_NODES,
  canvasConflictResponseSchema,
  canvasDetailSchema,
  canvasesListResponseSchema,
  canvasPatchResponseSchema,
  canvasPreviewResponseSchema,
  canvasTemplatesResponseSchema,
  canvasVersionDetailSchema,
  canvasVersionSchema,
  canvasVersionsResponseSchema,
  errorEnvelopeSchema,
  newId,
  okResponseSchema,
} from "@openfield/core";
import { type CanvasDocument, canvasDocumentSchema } from "@openfield/core/canvas";
import { getCanvas, listCanvasVersions, pruneVersions } from "@openfield/db";
import { image, libraryImages, MODEL, newCanvas } from "./canvas-helpers";
import { saveKey, startTestServer, type TestServer } from "./helpers";

// Canvas documents (M4-01, M4-11, M4-14, M4-15): every response parsed with its core schema.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A small graph: a prompt wired into a generator. */
function withNodes(doc: CanvasDocument, text = "a lighthouse"): CanvasDocument {
  return {
    ...doc,
    nodes: [
      {
        id: "n_prompt",
        type: "prompt",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        size: { w: 296, h: 151 },
        parentId: null,
        collapsed: false,
        title: null,
        params: { text },
        presetLocks: [],
        result: null,
      },
      {
        id: "n_gen",
        type: "image.generate",
        typeVersion: 1,
        position: { x: 400, y: 0 },
        parentId: null,
        collapsed: false,
        title: null,
        params: { prompt: "" },
        presetLocks: [],
        result: null,
      },
    ],
    edges: [
      {
        id: "e_1",
        source: "n_prompt",
        sourceHandle: "text",
        target: "n_gen",
        targetHandle: "prompt",
        order: 0,
        kind: "data",
      },
    ],
  };
}

describe("canvas documents", () => {
  test("create, open, list, rename and delete", async () => {
    server = await startTestServer();
    const created = await newCanvas(server);
    expect(created).toMatchObject({ name: "Untitled", graphVersion: 1 });
    expect(created.graph).toMatchObject({ id: created.id, name: "Untitled", nodes: [], edges: [] });

    const opened = await server.json(`/api/canvases/${created.id}`);
    expect(canvasDetailSchema.parse(opened.body)).toEqual({
      ...created,
      missingAssetIds: [],
      assetSizes: {},
      previewAt: null,
    });

    const named = await newCanvas(server, { name: "Harbor study" });
    const list = canvasesListResponseSchema.parse((await server.json("/api/canvases")).body);
    // Last edited first.
    expect(list.map((c) => c.id)).toEqual([named.id, created.id]);
    expect(list[0]).toMatchObject({
      name: "Harbor study",
      nodeCount: 0,
      previewUrl: null,
      coverAssetId: null,
    });
    const found = canvasesListResponseSchema.parse((await server.json("/api/canvases?q=harbor")).body);
    expect(found.map((c) => c.id)).toEqual([named.id]);
    // A LIKE wildcard in the search is taken literally.
    expect(canvasesListResponseSchema.parse((await server.json("/api/canvases?q=%25")).body)).toEqual([]);

    const renamed = await server.json(`/api/canvases/${created.id}`, {
      method: "PATCH",
      body: { name: "Lighthouse", graphVersion: 1 },
    });
    expect(canvasPatchResponseSchema.parse(renamed.body).graphVersion).toBe(2);
    const after = canvasDetailSchema.parse((await server.json(`/api/canvases/${created.id}`)).body);
    // The name column and the document agree.
    expect([after.name, after.graph.name]).toEqual(["Lighthouse", "Lighthouse"]);

    await server.json(`/api/canvases/${created.id}/versions`, { method: "POST", body: { label: "Keep" } });
    const deleted = await server.json(`/api/canvases/${created.id}`, { method: "DELETE" });
    okResponseSchema.parse(deleted.body);
    expect((await server.json(`/api/canvases/${created.id}`)).status).toBe(404);
    // Gone for good, versions with it (§7.3).
    expect(getCanvas(server.services.db, created.id, { includeDeleted: true })).toBeUndefined();
    expect(listCanvasVersions(server.services.db, created.id)).toEqual([]);
    expect(canvasesListResponseSchema.parse((await server.json("/api/canvases")).body)).toHaveLength(1);
    expect((await server.json(`/api/canvases/${created.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("opening names the images that aren't here and gives the size of those that are", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    const [here] = await libraryImages(server, 1);
    const gone = newId();
    const graph = withNodes(canvas.graph);
    graph.nodes.push({
      ...graph.nodes[1]!,
      id: "n_upload",
      type: "image.upload",
      params: { assetIds: [here!, gone] },
    });
    await server.json(`/api/canvases/${canvas.id}`, { method: "PATCH", body: { graph, graphVersion: 1 } });
    const opened = canvasDetailSchema.parse((await server.json(`/api/canvases/${canvas.id}`)).body);
    expect(opened.missingAssetIds).toEqual([gone]);
    // Image cards open at the image's exact shape (32×24 here), not a thumbnail's rounded one.
    expect(opened.assetSizes).toEqual({ [here!]: { w: 32, h: 24 } });
  });

  test("autosave rejects a stale graphVersion with the server's copy", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    const graph = withNodes(canvas.graph);
    const saved = await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph, graphVersion: 1 },
    });
    expect(saved.status).toBe(200);
    expect(canvasPatchResponseSchema.parse(saved.body).graphVersion).toBe(2);

    // A second tab still on version 1.
    const stale = await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph: canvas.graph, graphVersion: 1 },
    });
    expect(stale.status).toBe(409);
    const conflict = canvasConflictResponseSchema.parse(stale.body);
    expect(conflict.error).toMatchObject({ code: "conflict", field: "graphVersion" });
    expect(conflict.canvas.graphVersion).toBe(2);
    expect(conflict.canvas.graph.nodes.map((n) => n.id)).toEqual(["n_prompt", "n_gen"]);

    // A tab on version 1 whose copy says the same (both wrote a run's results) isn't a conflict.
    const same = await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph: { ...graph, viewport: { x: 40, y: 0, zoom: 1 } }, graphVersion: 1 },
    });
    expect(same.status).toBe(200);
    expect(canvasPatchResponseSchema.parse(same.body).graphVersion).toBe(2);
    expect(getCanvas(server.services.db, canvas.id)!.nodeCount).toBe(2);
  });

  test("the server keeps the id and name, whatever the document says", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server, { name: "Mine" });
    const res = await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph: { ...canvas.graph, id: newId(), name: "Someone else's" }, graphVersion: 1 },
    });
    expect(res.status).toBe(200);
    const after = canvasDetailSchema.parse((await server.json(`/api/canvases/${canvas.id}`)).body);
    expect(after.graph).toMatchObject({ id: canvas.id, name: "Mine" });
  });

  test("a new canvas and an import get the default model on their generators", async () => {
    server = await startTestServer();
    await saveKey(server);
    await server.json("/api/settings", { method: "PATCH", body: { defaultModel: MODEL } });
    const imported = await newCanvas(server, {
      graph: withNodes(
        canvasDocumentSchema.parse({
          schema: "openfield.canvas/1",
          id: newId(),
          name: "From a file",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [],
          edges: [],
          meta: { previewPath: "canvases/previews/elsewhere.png" },
        }),
      ),
    });
    expect(imported.name).toBe("From a file");
    expect(imported.graph.nodes[1]!.params.model).toBe(MODEL);
    // A preview path from another library is dropped.
    expect(imported.graph.meta.previewPath).toBeNull();

    const both = await server.json("/api/canvases", {
      method: "POST",
      body: { templateId: "storyboard", graph: imported.graph },
    });
    expect(both.status).toBe(400);
  });

  test("duplicate keeps results and names the copy", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server, { name: "Harbor" });
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph: withNodes(canvas.graph), graphVersion: 1 },
    });
    const res = await server.json(`/api/canvases/${canvas.id}/duplicate`, { method: "POST" });
    expect(res.status).toBe(201);
    const copy = canvasDetailSchema.parse(res.body);
    expect(copy.id).not.toBe(canvas.id);
    expect(copy).toMatchObject({ name: "Harbor copy", graphVersion: 1 });
    expect(copy.graph.id).toBe(copy.id);
    expect(copy.graph.nodes).toHaveLength(2);
  });

  test("unknown ids are 404 and bad bodies are 400", async () => {
    server = await startTestServer();
    expect((await server.json(`/api/canvases/${newId()}`)).status).toBe(404);
    const canvas = await newCanvas(server);
    const bad = await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph: { ...canvas.graph, nodes: [{ id: "x" }] }, graphVersion: 1 },
    });
    expect(bad.status).toBe(400);
    expect(errorEnvelopeSchema.parse(bad.body).error.code).toBe("bad_request");
  });
});

describe("version history (M4-11)", () => {
  test("save, list, preview and restore, with a snapshot before restoring", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    const first = withNodes(canvas.graph, "first idea");
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph: first, graphVersion: 1 },
    });
    // The first real change starts the automatic history.
    let versions = canvasVersionsResponseSchema.parse(
      (await server.json(`/api/canvases/${canvas.id}/versions`)).body,
    );
    expect(versions.map((v) => [v.kind, v.nodeCount, v.edgeCount])).toEqual([["auto", 2, 1]]);

    const named = await server.json(`/api/canvases/${canvas.id}/versions`, {
      method: "POST",
      body: { label: "Before the big change" },
    });
    expect(named.status).toBe(201);
    const version = canvasVersionSchema.parse(named.body);
    expect(version).toMatchObject({ kind: "named", label: "Before the big change" });

    // A later edit within five minutes makes no automatic snapshot.
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph: withNodes(canvas.graph, "second idea"), graphVersion: 2 },
    });
    versions = canvasVersionsResponseSchema.parse(
      (await server.json(`/api/canvases/${canvas.id}/versions`)).body,
    );
    expect(versions.map((v) => v.kind)).toEqual(["named", "auto"]);

    const preview = canvasVersionDetailSchema.parse(
      (await server.json(`/api/canvases/${canvas.id}/versions/${version.id}`)).body,
    );
    expect(preview.graph.nodes[0]!.params.text).toBe("first idea");

    const restored = await server.json(`/api/canvases/${canvas.id}/versions/${version.id}/restore`, {
      method: "POST",
    });
    const detail = canvasDetailSchema.parse(restored.body);
    expect(detail.graphVersion).toBe(4);
    expect(detail.graph.nodes[0]!.params.text).toBe("first idea");
    versions = canvasVersionsResponseSchema.parse(
      (await server.json(`/api/canvases/${canvas.id}/versions`)).body,
    );
    expect(versions[0]!.kind).toBe("before_restore");
    const safety = canvasVersionDetailSchema.parse(
      (await server.json(`/api/canvases/${canvas.id}/versions/${versions[0]!.id}`)).body,
    );
    expect(safety.graph.nodes[0]!.params.text).toBe("second idea");

    expect((await server.json(`/api/canvases/${canvas.id}/versions/${newId()}`)).status).toBe(404);
  });

  test("safety snapshots keep their kind, are pruned with the automatic ones, and named ones stay", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    const kinds = ["before_delete", "named", "before_import", "before_template"] as const;
    for (const kind of kinds) {
      const res = await server.json(`/api/canvases/${canvas.id}/versions`, {
        method: "POST",
        body: { kind },
      });
      expect(res.status).toBe(201);
      expect(canvasVersionSchema.parse(res.body).kind).toBe(kind);
    }
    // Only the server takes automatic and before-restore snapshots.
    for (const kind of ["auto", "before_restore"]) {
      const res = await server.json(`/api/canvases/${canvas.id}/versions`, {
        method: "POST",
        body: { kind },
      });
      expect(res.status).toBe(400);
    }
    expect(pruneVersions(server.services.db, canvas.id, 1)).toBe(2);
    expect(
      listCanvasVersions(server.services.db, canvas.id)
        .map((v) => v.kind)
        .sort(),
    ).toEqual(["before_template", "named"]);
  });

  test("an automatic snapshot waits five minutes after the last one", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph: withNodes(canvas.graph, "a"), graphVersion: 1 },
    });
    // Age the snapshot past the gap.
    const old = new Date(Date.now() - CANVAS_AUTO_VERSION_MS - 1000).toISOString();
    server.services.db.$client.run("UPDATE canvas_versions SET created_at = ?", [old]);
    // Moving the view alone isn't a change worth a snapshot.
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: {
        graph: { ...withNodes(canvas.graph, "a"), viewport: { x: 5, y: 5, zoom: 2 } },
        graphVersion: 2,
      },
    });
    expect(listCanvasVersions(server.services.db, canvas.id)).toHaveLength(1);
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph: withNodes(canvas.graph, "b"), graphVersion: 3 },
    });
    expect(listCanvasVersions(server.services.db, canvas.id)).toHaveLength(2);
  });
});

describe("templates (M4-14)", () => {
  test("the bundled templates list, and one opens as a runnable canvas", async () => {
    server = await startTestServer();
    await saveKey(server);
    // No default set: the first model that can run.
    const templates = canvasTemplatesResponseSchema.parse((await server.json("/api/canvas-templates")).body);
    expect(templates.map((t) => [t.id, t.source, t.name])).toEqual([
      ["compare-two-styles", "bundled", "Compare two styles"],
      ["from-a-reference", "bundled", "Start from a reference"],
      ["storyboard", "bundled", "Storyboard"],
    ]);
    const canvas = await newCanvas(server, { templateId: "storyboard" });
    expect(canvas.name).toBe("Storyboard");
    expect(canvas.graph.id).toBe(canvas.id);
    const generators = canvas.graph.nodes.filter((n) => n.type === "image.generate");
    expect(generators).toHaveLength(4);
    expect(generators.every((n) => n.params.model === "google:gemini-3-pro-image")).toBe(true);

    const missing = await server.json("/api/canvases", { method: "POST", body: { templateId: "nope" } });
    expect(missing.status).toBe(400);
    expect(errorEnvelopeSchema.parse(missing.body).error.userMessage).toBe(
      "That template isn't available anymore.",
    );
  });

  test("a template dropped into the library shows up; a broken one is left out", async () => {
    server = await startTestServer();
    const dir = join(server.home, "canvases", "templates");
    const canvas = await newCanvas(server, { name: "My flow" });
    await Bun.write(join(dir, "my-flow.ofcanvas.json"), JSON.stringify(canvas.graph));
    await Bun.write(join(dir, "broken.ofcanvas.json"), "{ nope");
    const templates = canvasTemplatesResponseSchema.parse((await server.json("/api/canvas-templates")).body);
    expect(templates.filter((t) => t.source === "user").map((t) => [t.id, t.name])).toEqual([
      ["user-my-flow", "My flow"],
    ]);
  });
});

describe("previews (M4-15)", () => {
  test("the browser's PNG is kept and served behind the session guard", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    const png = await image();
    const res = await server.request(`/api/canvases/${canvas.id}/preview`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: png,
    });
    expect(res.status).toBe(200);
    const { previewUrl } = canvasPreviewResponseSchema.parse(await res.json());
    expect(previewUrl).toStartWith(`/files/canvas-preview/${canvas.id}?v=`);

    const list = canvasesListResponseSchema.parse((await server.json("/api/canvases")).body);
    expect(list[0]!.previewUrl).toStartWith(`/files/canvas-preview/${canvas.id}?v=`);
    const file = await server.request(list[0]!.previewUrl!);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(png));
    expect((await server.request(list[0]!.previewUrl!, { session: false })).status).toBe(403);

    const notPng = await server.request(`/api/canvases/${canvas.id}/preview`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: "not an image",
    });
    expect(notPng.status).toBe(400);
  });

  test("deleting a canvas deletes its card picture", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    await server.request(`/api/canvases/${canvas.id}/preview`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: await image(),
    });
    const file = join(server.home, "canvases", "previews", `${canvas.id}.png`);
    expect(existsSync(file)).toBe(true);
    await server.json(`/api/canvases/${canvas.id}`, { method: "DELETE" });
    expect(existsSync(file)).toBe(false);
  });

  test("past the node limit the card falls back to its cover image", async () => {
    server = await startTestServer();
    const canvas = await newCanvas(server);
    await server.request(`/api/canvases/${canvas.id}/preview`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: await image(),
    });
    const many = {
      ...canvas.graph,
      nodes: Array.from({ length: CANVAS_PREVIEW_MAX_NODES + 1 }, (_, i) => ({
        ...withNodes(canvas.graph).nodes[0]!,
        id: `n_${i}`,
      })),
      edges: [],
    };
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph: many, graphVersion: 1 },
    });
    const list = canvasesListResponseSchema.parse((await server.json("/api/canvases")).body);
    expect(list[0]).toMatchObject({ nodeCount: CANVAS_PREVIEW_MAX_NODES + 1, previewUrl: null });
    const refused = await server.request(`/api/canvases/${canvas.id}/preview`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: await image(),
    });
    expect(refused.status).toBe(400);
  });
});

describe("saving canvases as files (§7.8)", () => {
  test("with the setting on, each save writes the document beside the library", async () => {
    server = await startTestServer();
    await server.json("/api/settings", { method: "PATCH", body: { canvasFileWriteThrough: true } });
    const canvas = await newCanvas(server);
    const file = join(server.home, "canvases", `${canvas.id}.json`);
    expect(existsSync(file)).toBe(true);
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { graph: withNodes(canvas.graph), graphVersion: 1 },
    });
    expect(canvasDocumentSchema.parse(JSON.parse(readFileSync(file, "utf8"))).nodes).toHaveLength(2);
    await server.json(`/api/canvases/${canvas.id}`, { method: "DELETE" });
    expect(existsSync(file)).toBe(false);
  });
});
