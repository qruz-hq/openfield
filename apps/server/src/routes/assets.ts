import { zValidator } from "@hono/zod-validator";
import {
  type Asset,
  type AssetBulkResponse,
  type AssetDetailResponse,
  type AssetMembershipsResponse,
  type AssetNeighboursResponse,
  type AssetsListQuery,
  type AssetsListResponse,
  assetBulkBodySchema,
  assetDeleteQuerySchema,
  assetFolderParamSchema,
  type assetFoldersResponseSchema,
  assetMembershipsBodySchema,
  assetNeighboursQuerySchema,
  assetsListQuerySchema,
  type favouriteResponseSchema,
  idParamSchema,
  type OkResponse,
  t,
} from "@openfield/core";
import {
  type AssetRow,
  assetNeighbours,
  childrenOf,
  type FeedItem,
  folderMemberships,
  foldersOfAssetWithCounts,
  getAsset,
  getJobSet,
  isFavourite,
  type LibraryFilter,
  libraryPage,
  referencesOf,
  rerunJobIds,
} from "@openfield/db";
import { type Context, Hono } from "hono";
import type { z } from "zod";
import type { Env } from "../context";
import { attachment } from "../files/names";
import { envelope, notFound, onInvalid } from "../http/errors";
import { toAsset, toFolder } from "../mappers/asset";
import { toJobSet } from "../mappers/job";
import { ancestorsOf, toListItems } from "../services/library";

// The library's images (§8.3, M3a-04): every view, search and filter on one cursor, the detail
// view's payload and neighbours, the Trash, favourites, filing and the bulk actions. Changes go
// out on the event stream from the library service, so other open tabs follow along.

/** The zip's exact size in bytes, and how many images are in it. */
export const ZIP_BYTES_HEADER = "x-openfield-zip-bytes";
export const ZIP_COUNT_HEADER = "x-openfield-zip-count";

type FavouriteResponse = z.infer<typeof favouriteResponseSchema>;
type AssetFoldersResponse = z.infer<typeof assetFoldersResponseSchema>;

export const assetsRoutes = new Hono<Env>()
  .get("/assets", zValidator("query", assetsListQuerySchema, onInvalid), (c) => {
    const q = c.req.valid("query");
    const { db } = c.var.svc;
    const page = libraryPage(db, { ...filterOf(q), cursor: q.cursor, limit: q.limit });
    const body: AssetsListResponse = {
      items: toListItems(db, page.items),
      ...(page.total !== undefined && { total: page.total }),
      nextCursor: page.nextCursor,
    };
    return c.json(body satisfies AssetsListResponse, 200);
  })
  // Before /assets/:id, so "bulk" and "memberships" are never read as ids.
  .post("/assets/bulk", zValidator("json", assetBulkBodySchema, onInvalid), async (c) => {
    const { ids, action, folderId } = c.req.valid("json");
    const { library } = c.var.svc;
    let changed: string[] | null;
    switch (action) {
      case "download": {
        const zip = library.zip(ids);
        if (!zip) return notFound(c, "Those images");
        // Bun sends a streamed body chunked and drops Content-Length, so the size for the
        // progress toast rides in a header of its own too.
        return new Response(zip.stream, {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-length": String(zip.length),
            [ZIP_BYTES_HEADER]: String(zip.length),
            [ZIP_COUNT_HEADER]: String(zip.count),
            "content-disposition": attachment(zip.name),
            "cache-control": "no-store",
          },
        });
      }
      case "delete":
        changed = library.trash(ids);
        break;
      case "restore":
        changed = library.restore(ids);
        break;
      case "purge":
        changed = (await library.purge(ids)).changed;
        break;
      case "favourite":
      case "unfavourite":
        changed = library.setFavourites(ids, action === "favourite");
        break;
      case "addFolder":
        changed = library.addToFolder(folderId!, ids);
        break;
      case "removeFolder":
        changed = library.removeFromFolder(folderId!, ids);
        break;
    }
    if (changed === null) return folderGone(c);
    return c.json({ affected: changed.length, changed } satisfies AssetBulkResponse, 200);
  })
  .post("/assets/memberships", zValidator("json", assetMembershipsBodySchema, onInvalid), (c) => {
    const folders = folderMemberships(c.var.svc.db, c.req.valid("json").ids);
    return c.json({ folders } satisfies AssetMembershipsResponse, 200);
  })
  // Answers for an image in the Trash too, so the Trash has a detail view (§4.0).
  .get("/assets/:id", zValidator("param", idParamSchema, onInvalid), (c) => {
    const { db } = c.var.svc;
    const row = getAsset(db, c.req.valid("param").id, { includeDeleted: true });
    if (!row) return notFound(c, "That image");
    const references = referencesOf(db, row.id);
    const ancestors = ancestorsOf(db, row);
    const children = childrenOf(db, row.id);
    const reruns = rerunJobIds(
      db,
      [row, ...references, ...ancestors, ...children].map((a) => a.jobId),
    );
    const wire = (a: AssetRow) => toAsset(a, isFavourite(db, a.id), reruns.has(a.jobId ?? ""));
    const jobSet = row.jobSetId ? getJobSet(db, row.jobSetId) : undefined;
    const asset = wire(row);
    const body: AssetDetailResponse = {
      asset,
      jobSet: jobSet ? toJobSet(jobSet) : null,
      params: row.params,
      references: references.map(wire),
      lineage: { ancestors: ancestors.map(wire), children: children.map(wire) },
      // For an image in the Trash, the folders Restore puts it back in.
      folders: foldersOfAssetWithCounts(db, row.id).map(toFolder),
      isFavourite: asset.isFavourite,
    };
    return c.json(body satisfies AssetDetailResponse, 200);
  })
  .get(
    "/assets/:id/neighbours",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("query", assetNeighboursQuerySchema, onInvalid),
    (c) => {
      const { db } = c.var.svc;
      const around = assetNeighbours(db, filterOf(c.req.valid("query")), c.req.valid("param").id);
      if (!around) return notFound(c, "That image");
      const wire = (item: FeedItem | null) => (item ? toListItems(db, [item])[0]! : null);
      const body: AssetNeighboursResponse = { previous: wire(around.previous), next: wire(around.next) };
      return c.json(body satisfies AssetNeighboursResponse, 200);
    },
  )
  // Delete moves it to the Trash; ?hard=1 deletes it for good at once (§8.6).
  .delete(
    "/assets/:id",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("query", assetDeleteQuerySchema, onInvalid),
    async (c) => {
      const { db, library } = c.var.svc;
      const { id } = c.req.valid("param");
      if (!getAsset(db, id, { includeDeleted: true })) return notFound(c, "That image");
      if (c.req.valid("query").hard) await library.purge([id], { includeLive: true });
      else library.trash([id]);
      return c.json({ ok: true } satisfies OkResponse, 200);
    },
  )
  .post("/assets/:id/restore", zValidator("param", idParamSchema, onInvalid), (c) => {
    const { db, library } = c.var.svc;
    const { id } = c.req.valid("param");
    if (!getAsset(db, id, { includeDeleted: true })) return notFound(c, "That image");
    library.restore([id]);
    const row = getAsset(db, id)!;
    const asset: Asset = toAsset(row, isFavourite(db, id), rerunJobIds(db, [row.jobId]).has(row.jobId ?? ""));
    return c.json(asset satisfies Asset, 200);
  })
  .put("/assets/:id/favourite", zValidator("param", idParamSchema, onInvalid), (c) => {
    const { db, library } = c.var.svc;
    const { id } = c.req.valid("param");
    // Only a live image can be favourited.
    if (!getAsset(db, id)) return notFound(c, "That image");
    library.setFavourites([id], true);
    return c.json({ isFavourite: true } satisfies FavouriteResponse, 200);
  })
  .delete("/assets/:id/favourite", zValidator("param", idParamSchema, onInvalid), (c) => {
    const { db, library } = c.var.svc;
    const { id } = c.req.valid("param");
    if (!getAsset(db, id, { includeDeleted: true })) return notFound(c, "That image");
    library.setFavourites([id], false);
    return c.json({ isFavourite: false } satisfies FavouriteResponse, 200);
  })
  // Adding keeps every other folder; removing takes it out of this one only (§0.7).
  .put("/assets/:id/folders/:folderId", zValidator("param", assetFolderParamSchema, onInvalid), (c) => {
    const { db, library } = c.var.svc;
    const { id, folderId } = c.req.valid("param");
    if (!getAsset(db, id)) return notFound(c, "That image");
    if (library.addToFolder(folderId, [id]) === null) return folderGone(c);
    const body: AssetFoldersResponse = { folders: foldersOfAssetWithCounts(db, id).map(toFolder) };
    return c.json(body satisfies AssetFoldersResponse, 200);
  })
  .delete("/assets/:id/folders/:folderId", zValidator("param", assetFolderParamSchema, onInvalid), (c) => {
    const { db, library } = c.var.svc;
    const { id, folderId } = c.req.valid("param");
    if (!getAsset(db, id, { includeDeleted: true })) return notFound(c, "That image");
    if (library.removeFromFolder(folderId, [id]) === null) return folderGone(c);
    const body: AssetFoldersResponse = { folders: foldersOfAssetWithCounts(db, id).map(toFolder) };
    return c.json(body satisfies AssetFoldersResponse, 200);
  });

/** A listing's filters, shared by the page and the detail view's neighbours. */
export function filterOf(q: Omit<AssetsListQuery, "cursor" | "limit">): LibraryFilter {
  return {
    folderId: q.folder,
    favouritesOnly: q.favourite,
    trash: q.trash,
    text: q.q,
    modelId: q.model,
    providerId: q.provider,
    kind: q.kind,
    from: q.from,
    to: q.to,
    modality: q.modality,
  };
}

export const folderGone = (c: Context) =>
  c.json(
    envelope("not_found", "That folder doesn't exist", {
      field: "folderId",
      userMessage: t("assets.folder.gone"),
    }),
    404,
  );
