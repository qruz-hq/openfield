import type { EdgeRelation, FileState } from "@openfield/core/constants";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../client";
import type { AssetRow } from "../rows";
import { assetEdges, assets } from "../schema";
import { nowIso } from "./_util";

// Reference edges and the few lineage reads the server's Info tab and boot checks need.

export interface EdgeDraft {
  parentAssetId: string;
  childAssetId: string;
  relation: EdgeRelation;
  ordinal?: number;
}

/** Records which images a new image was made from, in reference order. */
export function insertAssetEdges(db: Executor, edges: readonly EdgeDraft[], at = nowIso()): void {
  if (edges.length === 0) return;
  db.insert(assetEdges)
    .values(edges.map((e, i) => ({ ...e, ordinal: e.ordinal ?? i, createdAt: at })))
    .onConflictDoNothing()
    .run();
}

/** The live images an asset used as references, in the order they were given. */
export function referencesOf(db: Executor, childAssetId: string): AssetRow[] {
  return db
    .select({ asset: assets })
    .from(assetEdges)
    .innerJoin(assets, eq(assets.id, assetEdges.parentAssetId))
    .where(
      and(
        eq(assetEdges.childAssetId, childAssetId),
        eq(assetEdges.relation, "reference"),
        isNull(assets.deletedAt),
      ),
    )
    .orderBy(asc(assetEdges.ordinal))
    .all()
    .map((r) => r.asset);
}

/** Live images made directly from this one. */
export function childrenOf(db: Executor, parentAssetId: string): AssetRow[] {
  return db
    .select()
    .from(assets)
    .where(and(eq(assets.parentAssetId, parentAssetId), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt))
    .all();
}

/** Every asset's file and state, for the boot check that marks missing files (§8.4.5). */
export function assetFiles(db: Executor): { id: string; path: string; fileState: FileState }[] {
  return db.select({ id: assets.id, path: assets.path, fileState: assets.fileState }).from(assets).all();
}

/** Marks many assets at once, e.g. every file the boot check couldn't find. */
export function setFileStates(
  db: Executor,
  ids: readonly string[],
  fileState: FileState,
  at = nowIso(),
): void {
  if (ids.length === 0) return;
  db.update(assets)
    .set({ fileState, updatedAt: at })
    .where(inArray(assets.id, [...ids]))
    .run();
}
