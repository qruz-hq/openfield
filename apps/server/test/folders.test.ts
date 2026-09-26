import { afterEach, describe, expect, test } from "bun:test";
import {
  canvasRunResponseSchema,
  errorEnvelopeSchema,
  folderDeleteResponseSchema,
  folderSchema,
  foldersListResponseSchema,
  newId,
  t,
} from "@openfield/core";
import { addFolder, getAsset, getCanvas, getFolder } from "@openfield/db";
import { finished, item, newCanvas } from "./canvas-helpers";
import { saveKey, startTestServer, type TestServer } from "./helpers";
import { bulk, eventsOf, newFolder, seedImages } from "./library-helpers";

// Folders (M3a-03, M3a-14): created at the top level or inside another, renamed, moved anywhere
// but into themselves, deleted with everything inside them but never an image, at any depth, and
// the canvas's own folder kept by id through all of it.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function folders() {
  const res = await server!.json("/api/folders");
  expect(res.status).toBe(200);
  return foldersListResponseSchema.parse(res.body);
}

const patch = (id: string, body: unknown) => server!.json(`/api/folders/${id}`, { method: "PATCH", body });

/** A chain of `depth` folders straight in the database, top first. Routes do the interesting part. */
function chain(depth: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < depth; i++) {
    const id = newId();
    addFolder(server!.services.db, { id, name: `Level ${i}`, parentId: ids[i - 1] ?? null });
    ids.push(id);
  }
  return ids;
}

describe("creating", () => {
  test("at the top level or inside another folder; the list is flat with direct counts", async () => {
    server = await startTestServer();
    const from = server.events.length;
    const res = await server.json("/api/folders", { method: "POST", body: { name: "  Clients  " } });
    expect(res.status).toBe(201);
    const clients = folderSchema.parse(res.body);
    expect(clients).toMatchObject({ name: "Clients", parentId: null, count: 0, color: null });

    const acme = folderSchema.parse(
      (await server.json("/api/folders", { method: "POST", body: { name: "Acme", parentId: clients.id } }))
        .body,
    );
    expect(acme.parentId).toBe(clients.id);
    // Names need not be unique.
    const twin = await server.json("/api/folders", {
      method: "POST",
      body: { name: "Acme", parentId: clients.id },
    });
    expect(twin.status).toBe(201);

    const images = await seedImages(server, 2);
    await bulk(server, "addFolder", [images[0]!.id, images[1]!.id], acme.id);
    const list = await folders();
    expect(list.map((f) => [f.name, f.parentId, f.count])).toEqual([
      ["Acme", clients.id, 2],
      ["Acme", clients.id, 0],
      ["Clients", null, 0],
    ]);
    expect(list[0]).not.toHaveProperty("childCount");
    expect(eventsOf(server, "folder.updated", from).slice(0, 3)).toEqual([
      { folderId: clients.id, deleted: false },
      { folderId: acme.id, deleted: false },
      { folderId: (twin.body as { id: string }).id, deleted: false },
    ]);
  });

  test("an unknown parent is 404, and a bad name is 400", async () => {
    server = await startTestServer();
    const orphan = await server.json("/api/folders", {
      method: "POST",
      body: { name: "Lost", parentId: "01K6BQ8A1C4D7E9F0000000000" },
    });
    expect(orphan.status).toBe(404);
    expect(errorEnvelopeSchema.parse(orphan.body).error).toMatchObject({
      code: "not_found",
      field: "parentId",
      userMessage: t("assets.folder.gone"),
    });
    expect((await server.json("/api/folders", { method: "POST", body: { name: "   " } })).status).toBe(400);
    expect(
      (await server.json("/api/folders", { method: "POST", body: { name: "x".repeat(201) } })).status,
    ).toBe(400);
    expect(
      (await server.json("/api/folders", { method: "POST", body: { name: "A", parentId: "nope" } })).status,
    ).toBe(400);
    expect(await folders()).toEqual([]);
  });
});

describe("renaming and moving", () => {
  test("rename, move inside another folder, and back to the top level", async () => {
    server = await startTestServer();
    const clients = await newFolder(server, "Clients");
    const acme = await newFolder(server, "Acme");

    const renamed = await patch(acme, { name: " Acme Corp " });
    expect(folderSchema.parse(renamed.body).name).toBe("Acme Corp");
    const moved = await patch(acme, { parentId: clients });
    expect(folderSchema.parse(moved.body).parentId).toBe(clients);
    // Leaving parentId out keeps it where it is.
    expect(folderSchema.parse((await patch(acme, { color: "#E9E3D8" })).body)).toMatchObject({
      parentId: clients,
      color: "#E9E3D8",
    });
    const top = await patch(acme, { parentId: null });
    expect(folderSchema.parse(top.body).parentId).toBeNull();
    expect(
      eventsOf(server, "folder.updated").filter((e) => (e as { folderId: string }).folderId === acme),
    ).toHaveLength(5);

    expect((await patch(acme, { name: "" })).status).toBe(400);
    expect((await patch(acme, { owner: "me" })).status).toBe(400);
    expect((await patch("01K6BQ8A1C4D7E9F0000000000", { name: "Ghost" })).status).toBe(404);
    const lostParent = await patch(acme, { parentId: "01K6BQ8A1C4D7E9F0000000000" });
    expect(lostParent.status).toBe(404);
    expect(errorEnvelopeSchema.parse(lostParent.body).error.field).toBe("parentId");
  });

  test("a move into itself or anything inside it is 409, at depth 1 and 5, and changes nothing", async () => {
    server = await startTestServer();
    const [top, , , , , deep] = chain(6);
    const before = await folders();
    const from = server.events.length;

    for (const target of [top!, before.find((f) => f.parentId === top)!.id, deep!]) {
      const res = await patch(top!, { parentId: target, name: "Renamed too" });
      expect(res.status).toBe(409);
      expect(errorEnvelopeSchema.parse(res.body).error).toMatchObject({
        code: "conflict",
        field: "parentId",
        userMessage: t("assets.folder.insideItself"),
      });
    }
    // Refused whole: the rename that came with it didn't happen either.
    expect(await folders()).toEqual(before);
    expect(eventsOf(server, "folder.updated", from)).toEqual([]);
  });

  test("two moves racing to make a loop together: the second one gets 409", async () => {
    server = await startTestServer();
    const a = await newFolder(server, "A");
    const b = await newFolder(server, "B");
    const [first, second] = await Promise.all([patch(a, { parentId: b }), patch(b, { parentId: a })]);
    expect([first.status, second.status]).toEqual([200, 409]);
    const list = await folders();
    expect(list.find((f) => f.id === a)!.parentId).toBe(b);
    expect(list.find((f) => f.id === b)!.parentId).toBeNull();
  });
});

describe("deleting", () => {
  test("takes every folder inside it and their memberships, never an image", async () => {
    server = await startTestServer();
    const clients = await newFolder(server, "Clients");
    const acme = await newFolder(server, "Acme", clients);
    const spring = await newFolder(server, "Spring 2026", acme);
    const elsewhere = await newFolder(server, "Portfolio");
    const images = await seedImages(server, 3);
    const three = images.map((i) => i.id);
    await bulk(server, "addFolder", three, spring);
    await bulk(server, "addFolder", [three[0]!], elsewhere);

    const from = server.events.length;
    const res = await server.json(`/api/folders/${clients}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(folderDeleteResponseSchema.parse(res.body)).toEqual({
      ok: true,
      deletedIds: [clients, acme, spring],
    });
    expect(eventsOf(server, "folder.updated", from)).toEqual([
      { folderId: clients, deleted: true },
      { folderId: acme, deleted: true },
      { folderId: spring, deleted: true },
    ]);
    expect((await folders()).map((f) => [f.name, f.count])).toEqual([["Portfolio", 1]]);
    for (const id of three) expect(getAsset(server.services.db, id)).toBeDefined();

    expect((await server.json(`/api/folders/${clients}`, { method: "DELETE" })).status).toBe(404);
  });

  test("no depth limit: 1,200 levels list, refuse a loop, move and delete in one go", async () => {
    server = await startTestServer();
    const ids = chain(1200);
    const list = await folders();
    expect(list).toHaveLength(1200);

    const [top, second] = [ids[0]!, ids[1]!];
    const deepest = ids.at(-1)!;
    expect((await patch(top, { parentId: deepest })).status).toBe(409);
    // The deepest folder comes up to the top level, then the rest goes at once.
    expect(folderSchema.parse((await patch(deepest, { parentId: null })).body).parentId).toBeNull();
    const res = await server.json(`/api/folders/${second}`, { method: "DELETE" });
    const { deletedIds } = folderDeleteResponseSchema.parse(res.body);
    expect(deletedIds).toHaveLength(1198);
    expect(deletedIds[0]).toBe(second);
    expect((await folders()).map((f) => f.id).sort()).toEqual([top, deepest].sort());
  });
});

describe("the canvas's folder", () => {
  test("canvas runs keep filing into it after a rename and a move, and make a new one if it's deleted", async () => {
    server = await startTestServer();
    await saveKey(server);
    const { db } = server.services;
    const canvas = await newCanvas(server, { name: "Harbor study" });
    const run = async () => {
      const res = await server!.json(`/api/canvases/${canvas.id}/run`, {
        method: "POST",
        body: { scope: "node", nodeIds: ["n_gen"], plan: [item("n_gen")] },
      });
      const started = canvasRunResponseSchema.parse(res.body);
      const done = await finished(server!, started.runId!);
      return done.nodes[0]!.assetIds;
    };

    const first = await run();
    const folderId = getCanvas(db, canvas.id)!.folderId!;
    expect(getFolder(db, folderId)).toMatchObject({ name: "Harbor study", parentId: null, count: 1 });

    // The person renames it and files it under a client: runs follow the id.
    const clients = await newFolder(server, "Clients");
    await patch(folderId, { name: "Harbor (final)", parentId: clients });
    const second = await run();
    expect(getFolder(db, folderId)).toMatchObject({ name: "Harbor (final)", parentId: clients, count: 2 });
    const filed = await server.json(`/api/assets?folder=${folderId}`);
    expect((filed.body as { items: { id: string }[] }).items.map((i) => i.id).sort()).toEqual(
      [...first, ...second].sort(),
    );

    // Deleting its parent deletes it too; the next run makes a fresh one at the top level.
    await server.json(`/api/folders/${clients}`, { method: "DELETE" });
    expect(getCanvas(db, canvas.id)!.folderId).toBeNull();
    const from = server.events.length;
    const third = await run();
    const fresh = getCanvas(db, canvas.id)!.folderId!;
    expect(fresh).not.toBe(folderId);
    expect(getFolder(db, fresh)).toMatchObject({ name: "Harbor study", parentId: null, count: 1 });
    expect(eventsOf(server, "folder.updated", from)).toContainEqual({ folderId: fresh, deleted: false });
    expect((await server.json(`/api/assets?folder=${fresh}`)).body).toMatchObject({
      items: [{ id: third[0] }],
    });
  });

  test("renaming the canvas renames its folder only while the person hasn't renamed it", async () => {
    server = await startTestServer();
    await saveKey(server);
    const { db } = server.services;
    const canvas = await newCanvas(server, { name: "Draft" });
    const res = await server.json(`/api/canvases/${canvas.id}/run`, {
      method: "POST",
      body: { scope: "node", nodeIds: ["n_gen"], plan: [item("n_gen")] },
    });
    await finished(server, canvasRunResponseSchema.parse(res.body).runId!);
    const folderId = getCanvas(db, canvas.id)!.folderId!;

    const from = server.events.length;
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { name: "Harbor", graphVersion: 1 },
    });
    expect(getFolder(db, folderId)!.name).toBe("Harbor");
    expect(eventsOf(server, "folder.updated", from)).toEqual([{ folderId, deleted: false }]);

    await patch(folderId, { name: "My own name" });
    const detail = await server.json<{ graphVersion: number }>(`/api/canvases/${canvas.id}`);
    await server.json(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      body: { name: "Harbor 2", graphVersion: detail.body.graphVersion },
    });
    expect(getFolder(db, folderId)!.name).toBe("My own name");
  });
});
