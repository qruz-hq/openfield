import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AssetListItem,
  assetBulkResponseSchema,
  assetDetailResponseSchema,
  assetFoldersResponseSchema,
  assetMembershipsResponseSchema,
  assetNeighboursResponseSchema,
  assetSchema,
  assetsListResponseSchema,
  emptyTrashResponseSchema,
  errorEnvelopeSchema,
  favouriteResponseSchema,
  foldersListResponseSchema,
  librarySummaryResponseSchema,
  okResponseSchema,
  t,
} from "@openfield/core";
import { getAsset, softDeleteAssets } from "@openfield/db";
import { ORIGIN, startTestServer, type TestServer } from "./helpers";
import { bulk, eventsOf, minute, newFolder, seedImage, seedImages } from "./library-helpers";

// The Assets library's routes (M3a-04): each view, search with filters on one cursor, the detail
// view for live and trashed images, neighbours, favourites, many-to-many filing, the Trash with
// restore, delete for good and empty trash, the retention purge, and the events other tabs hear.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function list(path: string) {
  const res = await server!.json(path);
  expect(res.status).toBe(200);
  return assetsListResponseSchema.parse(res.body);
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);

async function folders() {
  return foldersListResponseSchema.parse((await server!.json("/api/folders")).body);
}

async function countOf(folderId: string) {
  return (await folders()).find((f) => f.id === folderId)?.count;
}

async function summary() {
  return librarySummaryResponseSchema.parse((await server!.json("/api/library/summary")).body);
}

describe("listings", () => {
  test("All images pages newest first on the cursor, with the total on the first page only", async () => {
    server = await startTestServer();
    const made = await seedImages(server, 5);
    const newest = [...made].reverse().map((a) => a.id);

    const first = await list("/api/assets?limit=2");
    expect(ids(first.items)).toEqual(newest.slice(0, 2));
    expect(first.total).toBe(5);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(`/api/assets?limit=2&cursor=${first.nextCursor}`);
    expect(ids(second.items)).toEqual(newest.slice(2, 4));
    expect(second.total).toBeUndefined();
    const last = await list(`/api/assets?limit=2&cursor=${second.nextCursor}`);
    expect(ids(last.items)).toEqual(newest.slice(4));
    expect(last.nextCursor).toBeNull();

    // Live items never carry deletedAt or the Trash's URL flag.
    expect(first.items[0]).not.toHaveProperty("deletedAt");
    expect(first.items[0]!.thumbUrl).toBe(`/files/thumb/${newest[0]}?h=456`);
    expect((await server.json("/api/assets?cursor=not!a!cursor")).status).toBe(400);
  });

  test("search combines with model, company, date and folder filters, across pages", async () => {
    server = await startTestServer();
    const neonCity = await seedImage(server, { at: 1, prompt: "neon city at night" });
    const neonForest = await seedImage(server, {
      at: 2,
      prompt: "a neon forest",
      provider: "openai",
      model: "gpt-image-1",
    });
    const neonSea = await seedImage(server, { at: 3, prompt: "neon sea" });
    await seedImage(server, { at: 4, prompt: "a quiet lake" });
    // Masks are internal and never listed, whatever they say.
    await seedImage(server, { at: 5, prompt: "neon mask", kind: "mask" });

    const all = await list("/api/assets?q=neon");
    expect(ids(all.items)).toEqual([neonSea.id, neonForest.id, neonCity.id]);
    expect(all.total).toBe(3);
    expect(ids((await list("/api/assets?q=neon&provider=openai")).items)).toEqual([neonForest.id]);
    expect(ids((await list("/api/assets?q=neon&model=gemini-3.1-flash-image")).items)).toEqual([
      neonSea.id,
      neonCity.id,
    ]);
    expect(ids((await list(`/api/assets?q=neon&from=${minute(2)}`)).items)).toEqual([
      neonSea.id,
      neonForest.id,
    ]);

    const acme = await newFolder(server, "Acme");
    await bulk(server, "addFolder", [neonCity.id, neonSea.id], acme);
    const inAcme = await list(`/api/assets?q=neon&folder=${acme}&limit=1`);
    expect(ids(inAcme.items)).toEqual([neonSea.id]);
    expect(inAcme.total).toBe(2);
    const next = await list(`/api/assets?q=neon&folder=${acme}&limit=1&cursor=${inAcme.nextCursor}`);
    expect(ids(next.items)).toEqual([neonCity.id]);
    expect(next.nextCursor).toBeNull();

    // Words that hold nothing searchable find nothing rather than failing.
    const blank = await list("/api/assets?q=%22%22");
    expect(blank.items).toEqual([]);
    expect(blank.total).toBe(0);
    expect((await summary()).counts.all).toBe(4);
  });

  test("the summary counts the sidebar and lists the filter choices", async () => {
    server = await startTestServer();
    const [a, b] = await seedImages(server, 3);
    await seedImage(server, { at: 9, provider: "openai", model: "gpt-image-1" });
    await seedImage(server, { at: 10, kind: "mask" });
    await bulk(server, "favourite", [a!.id]);
    await bulk(server, "delete", [b!.id]);

    const body = await summary();
    expect(body.counts).toEqual({ all: 3, favourites: 1, trash: 1 });
    expect(body.models).toEqual([
      { providerId: "google", modelId: "gemini-3.1-flash-image", count: 2 },
      { providerId: "openai", modelId: "gpt-image-1", count: 1 },
    ]);
    expect(body.providers).toEqual([
      { providerId: "google", count: 2 },
      { providerId: "openai", count: 1 },
    ]);
  });
});

describe("the detail view", () => {
  test("answers with folders and favourite, and for an image in the Trash too", async () => {
    server = await startTestServer();
    const image = await seedImage(server, { prompt: "a red door" });
    const acme = await newFolder(server, "Acme");
    await bulk(server, "addFolder", [image.id], acme);
    await bulk(server, "favourite", [image.id]);

    const live = assetDetailResponseSchema.parse((await server.json(`/api/assets/${image.id}`)).body);
    expect(live.asset.deletedAt).toBeNull();
    expect(live.isFavourite).toBe(true);
    expect(live.folders.map((f) => [f.name, f.count])).toEqual([["Acme", 1]]);
    expect(live.folders[0]).not.toHaveProperty("childCount");

    await bulk(server, "delete", [image.id]);
    const trashed = assetDetailResponseSchema.parse((await server.json(`/api/assets/${image.id}`)).body);
    expect(trashed.asset.deletedAt).not.toBeNull();
    expect(trashed.asset.fileUrl).toBe(`/files/asset/${image.id}?trash=1`);
    // The folders Restore puts it back in, with their live counts.
    expect(trashed.folders.map((f) => [f.name, f.count])).toEqual([["Acme", 0]]);
    expect(trashed.isFavourite).toBe(true);
    expect((await server.json("/api/assets/01K6BQ8A1C4D7E9F0000000000")).status).toBe(404);
  });

  test("neighbours follow the listing it was opened from", async () => {
    server = await startTestServer();
    const [a, b, c, d, e] = await seedImages(server, 5);
    const acme = await newFolder(server, "Acme");
    await bulk(server, "addFolder", [a!.id, c!.id, e!.id], acme);

    const around = async (id: string, query = "") => {
      const res = await server!.json(`/api/assets/${id}/neighbours${query}`);
      expect(res.status).toBe(200);
      const body = assetNeighboursResponseSchema.parse(res.body);
      return [body.previous?.id ?? null, body.next?.id ?? null];
    };
    expect(await around(c!.id)).toEqual([d!.id, b!.id]);
    expect(await around(c!.id, `?folder=${acme}`)).toEqual([e!.id, a!.id]);
    expect(await around(e!.id, `?folder=${acme}`)).toEqual([null, c!.id]);
    expect(await around(a!.id, `?folder=${acme}`)).toEqual([c!.id, null]);

    // The Trash steps by deletion time, newest deletion first.
    const { db } = server.services;
    softDeleteAssets(db, [b!.id], minute(30));
    softDeleteAssets(db, [d!.id], minute(20));
    expect(await around(b!.id, "?trash=1")).toEqual([null, d!.id]);
    const trash = await list("/api/assets?trash=1");
    expect(ids(trash.items)).toEqual([b!.id, d!.id]);
    expect(trash.items[0]!.deletedAt).toBe(minute(30));
    expect(trash.items[0]!.thumbUrl).toBe(`/files/thumb/${b!.id}?h=456&trash=1`);

    expect((await server.json("/api/assets/01K6BQ8A1C4D7E9F0000000000/neighbours")).status).toBe(404);
  });
});

describe("favourites", () => {
  test("the toggle, the bulk action and the Favorites view, with events for other tabs", async () => {
    server = await startTestServer();
    const [a, b] = await seedImages(server, 2);

    const put = await server.json(`/api/assets/${a!.id}/favourite`, { method: "PUT" });
    expect(favouriteResponseSchema.parse(put.body)).toEqual({ isFavourite: true });
    expect(ids((await list("/api/assets?favourite=1")).items)).toEqual([a!.id]);

    const from = server.events.length;
    const res = await bulk(server, "favourite", [a!.id, b!.id]);
    // a was already a favourite, so Undo must only unfavourite b.
    expect(assetBulkResponseSchema.parse(res.body)).toEqual({ affected: 1, changed: [b!.id] });
    const updated = eventsOf<{ asset: AssetListItem }>(server, "asset.updated", from);
    expect(updated.map((e) => [e.asset.id, e.asset.isFavourite])).toEqual([[b!.id, true]]);

    const off = await server.json(`/api/assets/${a!.id}/favourite`, { method: "DELETE" });
    expect(favouriteResponseSchema.parse(off.body)).toEqual({ isFavourite: false });
    expect((await bulk(server, "unfavourite", [a!.id, b!.id])).body.changed).toEqual([b!.id]);
    expect((await list("/api/assets?favourite=1")).items).toEqual([]);

    // Only live images can be favourited.
    await bulk(server, "delete", [a!.id]);
    expect((await server.json(`/api/assets/${a!.id}/favourite`, { method: "PUT" })).status).toBe(404);
    expect((await bulk(server, "favourite", [a!.id])).body.changed).toEqual([]);
  });
});

describe("filing", () => {
  test("an image sits in several folders, and Remove from folder takes it out of one only", async () => {
    server = await startTestServer();
    const images = await seedImages(server, 3);
    const three = ids(images);
    const acme = await newFolder(server, "Acme");
    const spring = await newFolder(server, "Spring");

    const from = server.events.length;
    const added = await bulk(server, "addFolder", three, acme);
    expect(added.body).toEqual({ affected: 3, changed: three });
    await bulk(server, "addFolder", three, spring);
    expect(eventsOf(server, "folder.updated", from)).toEqual([
      { folderId: acme, deleted: false },
      { folderId: spring, deleted: false },
    ]);
    // Already there: nothing to add, nothing to undo.
    expect((await bulk(server, "addFolder", three, acme)).body).toEqual({ affected: 0, changed: [] });

    const memberships = assetMembershipsResponseSchema.parse(
      (await server.json("/api/assets/memberships", { method: "POST", body: { ids: [three[0], three[1]] } }))
        .body,
    );
    expect(memberships.folders.sort((x, y) => x.folderId.localeCompare(y.folderId))).toEqual(
      [
        { folderId: acme, count: 2 },
        { folderId: spring, count: 2 },
      ].sort((x, y) => x.folderId.localeCompare(y.folderId)),
    );

    // AC-2.5.2: out of Acme, still in Spring and in All images, the Trash untouched.
    const removed = await bulk(server, "removeFolder", three, acme);
    expect(removed.body).toEqual({ affected: 3, changed: three });
    expect(await countOf(acme)).toBe(0);
    expect(await countOf(spring)).toBe(3);
    expect((await list(`/api/assets?folder=${spring}`)).total).toBe(3);
    expect((await list("/api/assets")).total).toBe(3);
    expect((await summary()).counts.trash).toBe(0);
  });

  test("one image at a time: PUT keeps its other folders, DELETE removes only this one", async () => {
    server = await startTestServer();
    const image = await seedImage(server);
    const acme = await newFolder(server, "Acme");
    const spring = await newFolder(server, "Spring");

    await server.json(`/api/assets/${image.id}/folders/${acme}`, { method: "PUT" });
    const both = await server.json(`/api/assets/${image.id}/folders/${spring}`, { method: "PUT" });
    expect(assetFoldersResponseSchema.parse(both.body).folders.map((f) => f.name)).toEqual([
      "Acme",
      "Spring",
    ]);
    const again = await server.json(`/api/assets/${image.id}/folders/${spring}`, { method: "PUT" });
    expect(assetFoldersResponseSchema.parse(again.body).folders).toHaveLength(2);

    const one = await server.json(`/api/assets/${image.id}/folders/${acme}`, { method: "DELETE" });
    expect(assetFoldersResponseSchema.parse(one.body).folders.map((f) => f.name)).toEqual(["Spring"]);

    const gone = "01K6BQ8A1C4D7E9F0000000000";
    const unknownFolder = await server.json(`/api/assets/${image.id}/folders/${gone}`, { method: "PUT" });
    expect(unknownFolder.status).toBe(404);
    expect(errorEnvelopeSchema.parse(unknownFolder.body).error.userMessage).toBe(t("assets.folder.gone"));
    expect((await server.json(`/api/assets/${gone}/folders/${acme}`, { method: "PUT" })).status).toBe(404);
  });

  test("an unknown folder is 404 and a folder action without one is 400", async () => {
    server = await startTestServer();
    const [image] = await seedImages(server, 1);
    const unknown = await bulk(server, "addFolder", [image!.id], "01K6BQ8A1C4D7E9F0000000000");
    expect(unknown.status).toBe(404);
    expect(errorEnvelopeSchema.parse(unknown.body).error).toMatchObject({
      code: "not_found",
      userMessage: t("assets.folder.gone"),
    });
    const missing = await bulk(server, "removeFolder", [image!.id]);
    expect(missing.status).toBe(400);
    expect(errorEnvelopeSchema.parse(missing.body).error.field).toBe("folderId");
    expect((await bulk(server, "archive", [image!.id])).status).toBe(400);
    expect((await bulk(server, "delete", [])).status).toBe(400);
    const tooMany = Array.from({ length: 5001 }, () => image!.id);
    expect((await bulk(server, "delete", tooMany)).status).toBe(400);
  });
});

describe("the Trash", () => {
  test("Delete keeps folders and favourite, and Restore puts the image back (AC-4.0.2)", async () => {
    server = await startTestServer();
    const [image, other] = await seedImages(server, 2);
    const acme = await newFolder(server, "Acme");
    await bulk(server, "addFolder", [image!.id], acme);
    await bulk(server, "favourite", [image!.id]);

    let from = server.events.length;
    expect((await bulk(server, "delete", [image!.id, image!.id])).body).toEqual({
      affected: 1,
      changed: [image!.id],
    });
    expect(eventsOf(server, "asset.deleted", from)).toEqual([{ assetIds: [image!.id], hard: false }]);
    expect(ids((await list("/api/assets")).items)).toEqual([other!.id]);
    expect((await list(`/api/assets?folder=${acme}`)).items).toEqual([]);
    expect((await list("/api/assets?favourite=1")).items).toEqual([]);
    expect(await countOf(acme)).toBe(0);
    expect((await summary()).counts).toEqual({ all: 1, favourites: 0, trash: 1 });
    // Already in the Trash: nothing more to do.
    expect((await bulk(server, "delete", [image!.id])).body.changed).toEqual([]);

    // Its files answer only when asked for the Trash's copy.
    expect((await server.request(`/files/asset/${image!.id}`)).status).toBe(404);
    expect((await server.request(`/files/asset/${image!.id}?trash=1`)).status).toBe(200);
    expect((await server.request(`/files/thumb/${image!.id}?h=200`)).status).toBe(404);
    expect((await server.request(`/files/thumb/${image!.id}?h=200&trash=1`)).status).toBe(200);

    from = server.events.length;
    expect((await bulk(server, "restore", [image!.id, other!.id])).body).toEqual({
      affected: 1,
      changed: [image!.id],
    });
    expect(eventsOf<{ asset: AssetListItem }>(server, "asset.updated", from).map((e) => e.asset.id)).toEqual([
      image!.id,
    ]);
    expect(eventsOf(server, "folder.updated", from)).toEqual([{ folderId: acme, deleted: false }]);
    expect(ids((await list(`/api/assets?folder=${acme}`)).items)).toEqual([image!.id]);
    expect(ids((await list("/api/assets?favourite=1")).items)).toEqual([image!.id]);
    expect((await summary()).counts).toEqual({ all: 2, favourites: 1, trash: 0 });
  });

  test("the single-image routes: DELETE to the Trash and POST restore", async () => {
    server = await startTestServer();
    const image = await seedImage(server);
    const del = await server.json(`/api/assets/${image.id}`, { method: "DELETE" });
    expect(okResponseSchema.parse(del.body)).toEqual({ ok: true });
    expect(getAsset(server.services.db, image.id)).toBeUndefined();

    const restored = await server.json(`/api/assets/${image.id}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    const asset = assetSchema.parse(restored.body);
    expect(asset.deletedAt).toBeNull();
    expect(asset.fileUrl).toBe(`/files/asset/${image.id}`);
    const gone = "01K6BQ8A1C4D7E9F0000000000";
    expect((await server.json(`/api/assets/${gone}`, { method: "DELETE" })).status).toBe(404);
    expect((await server.json(`/api/assets/${gone}/restore`, { method: "POST" })).status).toBe(404);
  });

  test("Delete for good removes the file and thumbnails only once nothing else uses them", async () => {
    server = await startTestServer();
    const original = await seedImage(server);
    const file = join(server.home, original.path);
    // The same bytes uploaded again share the file and the thumbnails (§8.5.1).
    const upload = new FormData();
    upload.append("file", new File([await Bun.file(file).bytes()], "again.png"));
    const again = (await (await server.request("/api/uploads", { method: "POST", body: upload })).json()) as {
      asset: { id: string };
    };
    expect(getAsset(server.services.db, again.asset.id)!.path).toBe(original.path);
    expect((await server.request(`/files/thumb/${original.id}?h=200`)).status).toBe(200);
    const thumbDir = join(server.home, "thumbs", original.sha256.slice(0, 2));
    const thumbsOf = () => readdirSync(thumbDir).filter((n) => n.startsWith(`${original.sha256}@`));
    expect(thumbsOf().length).toBeGreaterThan(0);

    // Only images in the Trash can be deleted for good through the bulk route.
    expect((await bulk(server, "purge", [original.id])).body.changed).toEqual([]);
    await bulk(server, "delete", [original.id]);
    const from = server.events.length;
    expect((await bulk(server, "purge", [original.id])).body).toEqual({
      affected: 1,
      changed: [original.id],
    });
    expect(eventsOf(server, "asset.deleted", from)).toEqual([{ assetIds: [original.id], hard: true }]);
    expect(getAsset(server.services.db, original.id, { includeDeleted: true })).toBeUndefined();
    expect(existsSync(file)).toBe(true);
    expect(thumbsOf().length).toBeGreaterThan(0);

    // DELETE ?hard=1 deletes a live image for good at once; now nothing else uses the file.
    const hard = await server.json(`/api/assets/${again.asset.id}?hard=1`, { method: "DELETE" });
    expect(hard.status).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect(thumbsOf()).toEqual([]);
    expect(eventsOf(server, "asset.deleted").at(-1)).toEqual({ assetIds: [again.asset.id], hard: true });
  });

  test("Empty trash deletes everything in the Trash for good and nothing else", async () => {
    server = await startTestServer();
    const images = await seedImages(server, 4);
    const trashed = images.slice(0, 3);
    await bulk(server, "delete", ids(trashed));

    expect(
      (await server.json("/api/maintenance/empty-trash", { method: "POST", body: { all: true } })).status,
    ).toBe(400);
    const res = await server.json("/api/maintenance/empty-trash", { method: "POST", body: {} });
    expect(res.status).toBe(200);
    expect(emptyTrashResponseSchema.parse(res.body)).toEqual({
      affected: 3,
      reclaimedBytes: trashed.reduce((sum, a) => sum + a.bytes, 0),
    });
    for (const image of trashed) expect(existsSync(join(server.home, image.path))).toBe(false);
    expect(existsSync(join(server.home, images[3]!.path))).toBe(true);
    expect((await summary()).counts).toEqual({ all: 1, favourites: 0, trash: 0 });
    const empty = await server.json("/api/maintenance/empty-trash", { method: "POST", body: {} });
    expect(empty.body).toEqual({ affected: 0, reclaimedBytes: 0 });
  });

  test("the trash never empties itself unless a retention is set", async () => {
    server = await startTestServer();
    const [old, recent] = await seedImages(server, 2);
    const { db, library } = server.services;
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    softDeleteAssets(db, [old!.id], daysAgo(100));
    softDeleteAssets(db, [recent!.id], daysAgo(2));

    // The default is never.
    expect(await library.purgeExpired()).toBe(0);
    expect((await summary()).counts.trash).toBe(2);

    await server.json("/api/settings", { method: "PATCH", body: { trashRetentionDays: 30 } });
    expect(await library.purgeExpired()).toBe(1);
    expect(getAsset(db, old!.id, { includeDeleted: true })).toBeUndefined();
    expect(getAsset(db, recent!.id, { includeDeleted: true })).toBeDefined();
    expect(existsSync(join(server.home, old!.path))).toBe(false);
  });
});

describe("downloads", () => {
  test("a single original comes as an attachment with a readable name", async () => {
    server = await startTestServer();
    const image = await seedImage(server, { at: 7 });
    const res = await server.request(`/files/asset/${image.id}?download=1`);
    expect(res.status).toBe(200);
    const shortId = image.id.slice(-6).toLowerCase();
    expect(res.headers.get("content-disposition")).toMatch(
      new RegExp(`^attachment; filename="openfield_\\d{8}-\\d{4}_gemini-3\\.1-flash-image_${shortId}\\.png"`),
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      await Bun.file(join(server.home, image.path)).bytes(),
    );
    // Without it, the viewer gets the file inline as before.
    expect((await server.request(`/files/asset/${image.id}`)).headers.get("content-disposition")).toBeNull();
  });
});

describe("guards", () => {
  test("every library route refuses a request without the token, from another site or host", async () => {
    server = await startTestServer();
    const image = await seedImage(server);
    const folder = await newFolder(server, "Acme");
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/assets?trash=1"],
      ["GET", `/api/assets/${image.id}`],
      ["GET", `/api/assets/${image.id}/neighbours`],
      ["POST", "/api/assets/bulk", { ids: [image.id], action: "delete" }],
      ["POST", "/api/assets/memberships", { ids: [image.id] }],
      ["DELETE", `/api/assets/${image.id}`],
      ["POST", `/api/assets/${image.id}/restore`],
      ["PUT", `/api/assets/${image.id}/favourite`],
      ["PUT", `/api/assets/${image.id}/folders/${folder}`],
      ["GET", "/api/library/summary"],
      ["GET", "/api/folders"],
      ["POST", "/api/folders", { name: "Sneaky" }],
      ["PATCH", `/api/folders/${folder}`, { name: "Renamed" }],
      ["DELETE", `/api/folders/${folder}`],
      ["POST", "/api/maintenance/empty-trash", {}],
      ["GET", `/files/asset/${image.id}?trash=1&download=1`],
    ];
    for (const [method, path, body] of routes) {
      const init = {
        method,
        ...(body !== undefined && {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
      };
      expect((await server.request(path, { ...init, session: false })).status).toBe(403);
      const withHeaders = (extra: Record<string, string>) => ({
        ...init,
        headers: { ...(body !== undefined && { "content-type": "application/json" }), ...extra },
      });
      expect((await server.request(path, withHeaders({ origin: "https://evil.example" }))).status).toBe(403);
      expect((await server.request(path, withHeaders({ "sec-fetch-site": "cross-site" }))).status).toBe(403);
      expect((await server.request(path, withHeaders({ host: "evil.example:4317" }))).status).toBe(403);
    }
    // Nothing got through.
    expect(getAsset(server.services.db, image.id)).toBeDefined();
    expect((await folders()).map((f) => f.name)).toEqual(["Acme"]);
    // The app's own origin is fine.
    expect((await server.request("/api/library/summary", { headers: { origin: ORIGIN } })).status).toBe(200);
  });
});
