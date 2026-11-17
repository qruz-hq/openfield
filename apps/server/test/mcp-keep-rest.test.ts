import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { editOpParamsSchema } from "@openfield/core";
import { getAsset, getCanvas } from "@openfield/db";
import { saveKey, startTestServer, type TestServer } from "./helpers";
import { call, connectAgent, turnOnAgents } from "./mcp-helpers";
import { quarterMask, texture } from "./pixels";

// Keep the rest after an edit, through /mcp: an Edit node blended again for free when only how it
// keeps the rest changes, and an edited image adjusted or its model's result saved. Fake companies
// answer every call, and their results never line up, so the mask alone decides (fellBack).

let server: TestServer | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
  await server?.close();
  server = undefined;
});

async function ready() {
  const s = await startTestServer();
  server = s;
  await saveKey(s);
  await turnOnAgents(s);
  const c = await connectAgent(s);
  client = c;
  return { server: s, client: c };
}

// biome-ignore lint/suspicious/noExplicitAny: tool answers are free-form JSON; each test checks what it needs.
type Json = Record<string, any>;
const j = (r: { json: unknown }) => r.json as Json;

async function files(s: TestServer) {
  const photo = join(s.home, "tmp", "photo.png");
  const mask = join(s.home, "tmp", "mask.png");
  writeFileSync(photo, await texture(640, 480));
  writeFileSync(mask, await quarterMask(640, 480));
  return { photo, mask };
}

/** Upload, then a masked Edit, then a Generate reading the edit, all run once. */
async function ranEdit(s: TestServer, c: Client) {
  const { photo, mask } = await files(s);
  const imported = j(await call(c, "import_image", { source: photo })).assetId as string;
  const canvasId = j(await call(c, "create_canvas", { name: "Door" })).canvasId as string;
  const built = j(
    await call(c, "edit_canvas", {
      canvas: canvasId,
      edits: [
        { op: "add_node", as: "u", type: "image.upload", params: { assetIds: [imported] } },
        { op: "add_node", as: "e", type: "image.edit", params: { prompt: "a red door" } },
        { op: "add_node", as: "g", type: "image.generate", params: { prompt: "at night" } },
        { connect: "u.images", to: "e.image" },
        { connect: "e.images", to: "g.input_images" },
      ],
    }),
  );
  const { e, g } = built.created as { e: string; g: string };
  expect((await call(c, "set_node_mask", { canvas: canvasId, id: e, mask })).isError).toBe(false);
  const ran = j(await call(c, "run_canvas", { canvas: canvasId }));
  expect(ran.status).toBe("succeeded");
  const node = (id: string) => ran.nodes.find((n: Json) => n.nodeId === id);
  return { canvasId, e, g, edited: node(e).images[0].assetId as string };
}

const stateOf = async (c: Client, canvasId: string, id: string) =>
  j(await call(c, "get_canvas", { canvas: canvasId })).nodes.find((n: Json) => n.id === id).state;

const recordOf = (s: TestServer, id: string) =>
  editOpParamsSchema.parse(getAsset(s.services.db, id)!.opParams!.edit).keepRest!;

describe("an Edit node after it ran", () => {
  test("changing only how it keeps the rest blends its image again, for free, and it stays done", async () => {
    const { server: s, client: c } = await ready();
    const { canvasId, e, g, edited } = await ranEdit(s, c);
    const before = getAsset(s.services.db, edited)!;

    const updated = await call(c, "update_node", {
      canvas: canvasId,
      id: e,
      params: { expandPx: 20, featherPx: 0, keepRestMode: "mask", sensitivity: 70 },
    });
    expect(updated.isError).toBe(false);
    expect(j(updated).keepRest).toEqual([
      `${e}: blended its images again with the new settings, for free, so it's still done. The nodes after it are out of date until they run again.`,
    ]);
    // The same image, rewritten in place.
    const after = getAsset(s.services.db, edited)!;
    expect(after.sha256).not.toBe(before.sha256);
    expect(recordOf(s, edited)).toMatchObject({ mode: "mask", sensitivity: 70, revision: 1 });
    expect(await stateOf(c, canvasId, e)).toBe("done");
    expect(await stateOf(c, canvasId, g)).toBe("stale");
    // A Run makes only what reads it again: the edit itself isn't billed twice.
    expect(j(await call(c, "run_canvas", { canvas: canvasId, dryRun: true }))).toMatchObject({
      images: 1,
      upToDate: [e],
    });
  });

  test("turning it off, or changing the prompt too, waits for the next Run", async () => {
    const { server: s, client: c } = await ready();
    const { canvasId, e, edited } = await ranEdit(s, c);
    const sha = getAsset(s.services.db, edited)!.sha256;

    const off = j(await call(c, "update_node", { canvas: canvasId, id: e, params: { keepOriginal: false } }));
    expect(off.keepRest[0]).toStartWith(`${e}: Keep the rest is off now, so the node is out of date`);
    expect(await stateOf(c, canvasId, e)).toBe("stale");

    await call(c, "update_node", { canvas: canvasId, id: e, params: { keepOriginal: true } });
    expect(await stateOf(c, canvasId, e)).toBe("done");
    const both = j(
      await call(c, "update_node", {
        canvas: canvasId,
        id: e,
        params: { prompt: "a blue door", featherPx: 2 },
      }),
    );
    expect(both.keepRest).toBeUndefined();
    expect(await stateOf(c, canvasId, e)).toBe("stale");
    expect(getAsset(s.services.db, edited)!.sha256).toBe(sha);
  });

  test("its image changes with the node, not on its own, and not at all once it's locked", async () => {
    const { server: s, client: c } = await ready();
    const { canvasId, e, edited } = await ranEdit(s, c);
    const direct = await call(c, "adjust_edit", { assetId: edited, featherPx: 0 });
    expect(direct.isError).toBe(true);
    expect(direct.text).toContain(`Edit node ${e} on the canvas "Door" made this image.`);

    const detail = s.services.canvases.get(canvasId);
    const nodes = detail.graph.nodes.map((n) => (n.id === e ? { ...n, locked: true } : n));
    expect(
      s.services.canvases.save(canvasId, {
        graphVersion: detail.graphVersion,
        graph: { ...detail.graph, nodes },
      }).ok,
    ).toBe(true);
    const version = getCanvas(s.services.db, canvasId)!.graphVersion;
    const sha = getAsset(s.services.db, edited)!.sha256;
    expect(
      (await call(c, "update_node", { canvas: canvasId, id: e, params: { featherPx: 0 } })).isError,
    ).toBe(true);
    const locked = await call(c, "adjust_edit", { assetId: edited, featherPx: 0 });
    expect(locked.text).toContain("is on a locked node");
    expect(getCanvas(s.services.db, canvasId)!.graphVersion).toBe(version);
    expect(getAsset(s.services.db, edited)!.sha256).toBe(sha);
    // Saving the model's result leaves the locked node as it is.
    expect((await call(c, "save_model_result", { assetId: edited })).isError).toBe(false);
  });
});

describe("an edited image", () => {
  async function maskedEdit(s: TestServer, c: Client, edit: Record<string, unknown> = {}) {
    const { photo, mask } = await files(s);
    const made = j(
      await call(c, "generate_image", { prompt: "a red door", edit: { image: photo, mask, ...edit } }),
    );
    expect(made.status).toBe("succeeded");
    return made;
  }

  test("generate_image takes how to keep the rest, and get_asset reads it back", async () => {
    const { server: s, client: c } = await ready();
    const made = await maskedEdit(s, c, { keepRestMode: "mask", sensitivity: 80 });
    expect(made.edit).toMatchObject({ keepRestMode: "mask", sensitivity: 80 });
    expect(made.edit.note).toEndWith("Openfield then puts back the original everywhere outside the mask.");
    const id = made.images[0].assetId as string;
    expect(recordOf(s, id)).toMatchObject({ mode: "mask", sensitivity: 80, start: "mask" });
    const details = j(await call(c, "get_asset", { assetId: id, preview: false }));
    expect(details.keepRest).toMatchObject({
      available: true,
      on: true,
      mode: "mask",
      sensitivity: 80,
      expandPx: 4,
      featherPx: 8,
      startsFrom: "mask",
      touchedUp: false,
    });
  });

  test("adjust_edit blends it again in place, and save_model_result saves the model's own result once", async () => {
    const { server: s, client: c } = await ready();
    const made = await maskedEdit(s, c);
    const id = made.images[0].assetId as string;
    const sha = getAsset(s.services.db, id)!.sha256;

    const adjusted = j(await call(c, "adjust_edit", { assetId: id, expandPx: 24, featherPx: 0 }));
    expect(adjusted).toMatchObject({ assetId: id, changed: true, keepRest: { expandPx: 24, featherPx: 0 } });
    expect(getAsset(s.services.db, id)!.sha256).not.toBe(sha);
    const same = j(await call(c, "adjust_edit", { assetId: id, expandPx: 24, featherPx: 0 }));
    expect(same).toMatchObject({
      changed: false,
      note: "These settings make the same image, so nothing was rewritten.",
    });

    const saved = j(await call(c, "save_model_result", { assetId: id }));
    expect(saved.madeFrom).toBe(id);
    expect(getAsset(s.services.db, saved.assetId)).toMatchObject({ kind: "edited" });
    const again = j(await call(c, "save_model_result", { assetId: id }));
    expect(again).toMatchObject({
      assetId: saved.assetId,
      note: "It was saved already, so that image came back.",
    });
    expect(j(await call(c, "get_asset", { assetId: id, preview: false })).keepRest.modelResultSavedAs).toBe(
      saved.assetId,
    );
  });

  test("an image that isn't an edit says so", async () => {
    const { server: s, client: c } = await ready();
    const { photo } = await files(s);
    const id = j(await call(c, "import_image", { source: photo })).assetId as string;
    expect(j(await call(c, "get_asset", { assetId: id, preview: false })).keepRest).toBeUndefined();
    const refused = await call(c, "adjust_edit", { assetId: id, featherPx: 0 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Only edits made with a painted area or with marks can be adjusted.");
  });
});
