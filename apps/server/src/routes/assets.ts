import { zValidator } from "@hono/zod-validator";
import {
  type AssetDetailResponse,
  type AssetsListResponse,
  assetsListQuerySchema,
  type Folder,
  idParamSchema,
} from "@openfield/core";
import {
  type AssetRow,
  childrenOf,
  type Db,
  type FeedQuery,
  feedPage,
  foldersOfAsset,
  getAsset,
  getJobSet,
  isFavourite,
  listFolders,
  referencesOf,
  rerunJobIds,
  searchAssets,
} from "@openfield/db";
import { Hono } from "hono";
import type { Env } from "../context";
import { notFound, onInvalid } from "../http/errors";
import { toAsset, toAssetListItem } from "../mappers/asset";
import { toJobSet } from "../mappers/job";

const MAX_ANCESTORS = 100;

export const assetsRoutes = new Hono<Env>()
  .get("/assets", zValidator("query", assetsListQuerySchema, onInvalid), (c) => {
    const q = c.req.valid("query");
    const filter: FeedQuery = {
      cursor: q.cursor,
      limit: q.limit,
      folderId: q.folder,
      favouritesOnly: q.favourite,
      modelId: q.model,
      providerId: q.provider,
      kind: q.kind,
      from: q.from,
      to: q.to,
      modality: q.modality,
    };
    const page = q.q?.trim()
      ? searchAssets(c.var.svc.db, { ...filter, text: q.q })
      : feedPage(c.var.svc.db, filter);
    const reruns = rerunJobIds(
      c.var.svc.db,
      page.items.map((a) => a.jobId),
    );
    const body: AssetsListResponse = {
      items: page.items.map((a) => toAssetListItem(a, a.isFavourite, reruns.has(a.jobId ?? ""))),
      nextCursor: page.nextCursor,
    };
    return c.json(body satisfies AssetsListResponse, 200);
  })
  .get("/assets/:id", zValidator("param", idParamSchema, onInvalid), (c) => {
    const { db } = c.var.svc;
    const row = getAsset(db, c.req.valid("param").id);
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
    const body: AssetDetailResponse = {
      asset: wire(row),
      jobSet: jobSet ? toJobSet(jobSet) : null,
      params: row.params,
      references: references.map(wire),
      lineage: { ancestors: ancestors.map(wire), children: children.map(wire) },
      folders: foldersFor(db, row.id),
      isFavourite: isFavourite(db, row.id),
    };
    return c.json(body satisfies AssetDetailResponse, 200);
  });

/** Parent, grandparent, … up to the root. A hard-deleted parent ends the walk (§0.7 tombstone). */
function ancestorsOf(db: Db, asset: AssetRow): AssetRow[] {
  const out: AssetRow[] = [];
  let parentId = asset.parentAssetId;
  while (parentId && out.length < MAX_ANCESTORS) {
    const parent = getAsset(db, parentId);
    if (!parent) break;
    out.push(parent);
    parentId = parent.parentAssetId;
  }
  return out;
}

function foldersFor(db: Db, assetId: string): Folder[] {
  const ids = new Set(foldersOfAsset(db, assetId).map((f) => f.id));
  return listFolders(db)
    .filter((f) => ids.has(f.id))
    .map((f) => ({
      id: f.id,
      name: f.name,
      color: f.color,
      parentId: f.parentId,
      sortOrder: f.sortOrder,
      count: f.count,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }));
}
