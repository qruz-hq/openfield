import type { CanvasGraph, CanvasRunRecord } from "@openfield/core/canvas";
import {
  ACTIVE_JOB_STATES,
  CANVAS_AUTO_VERSIONS_KEPT,
  type CanvasVersionKind,
  type JobSetState,
} from "@openfield/core/constants";
import type { CanvasRunNodeState } from "@openfield/core/schemas";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Executor } from "../client";
import type {
  CanvasRow,
  CanvasRunRow,
  CanvasVersionRow,
  JobSetRow,
  NewCanvasRow,
  NewCanvasRunRow,
  NewCanvasVersionRow,
} from "../rows";
import { canvases, canvasRuns, canvasVersions, jobSets } from "../schema";
import { type Draft, nowIso } from "./_util";

// Canvases, their versions and their runs (§7.8, §8.2). The graph column holds the whole
// document; node_count and cover_asset_id are kept beside it so the index never parses a graph.

/** A canvas row without its graph, for the index. */
export type CanvasListRow = Omit<CanvasRow, "graph">;
/** A version row without its graph, for the history list. */
export type CanvasVersionListRow = Omit<CanvasVersionRow, "graph">;

const { graph: _g, ...listColumns } = getTableColumns(canvases);
const { graph: _vg, ...versionListColumns } = getTableColumns(canvasVersions);

/** Live canvases, last edited first. `q` matches the name, case-insensitive. */
export function listCanvases(db: Executor, q: { name?: string } = {}): CanvasListRow[] {
  const pattern = q.name ? `%${q.name.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return db
    .select(listColumns)
    .from(canvases)
    .where(
      and(
        isNull(canvases.deletedAt),
        pattern ? sql`${canvases.name} LIKE ${pattern} ESCAPE '\\' COLLATE NOCASE` : undefined,
      ),
    )
    .orderBy(desc(canvases.updatedAt), desc(canvases.id))
    .all();
}

export function getCanvas(
  db: Executor,
  id: string,
  opts: { includeDeleted?: boolean } = {},
): CanvasRow | undefined {
  return db
    .select()
    .from(canvases)
    .where(and(eq(canvases.id, id), opts.includeDeleted ? undefined : isNull(canvases.deletedAt)))
    .get();
}

export function insertCanvas(db: Executor, row: Draft<NewCanvasRow, "createdAt" | "updatedAt">): CanvasRow {
  const at = row.createdAt ?? nowIso();
  return db
    .insert(canvases)
    .values({ ...row, createdAt: at, updatedAt: row.updatedAt ?? at })
    .returning()
    .get();
}

export interface CanvasSave {
  graph: CanvasGraph;
  name: string;
  nodeCount: number;
  coverAssetId: string | null;
  at?: string;
}

/**
 * Autosave with optimistic concurrency (§7.8): writes only if graph_version still equals
 * `expected`, and bumps it. On a mismatch nothing changes and the current row comes back.
 */
export function saveCanvas(
  db: Executor,
  id: string,
  expected: number,
  save: CanvasSave,
): { ok: true; row: CanvasRow } | { ok: false; current: CanvasRow | undefined } {
  const at = save.at ?? nowIso();
  const row = db
    .update(canvases)
    .set({
      graph: save.graph,
      name: save.name,
      nodeCount: save.nodeCount,
      coverAssetId: save.coverAssetId,
      graphVersion: sql`${canvases.graphVersion} + 1`,
      updatedAt: at,
    })
    .where(and(eq(canvases.id, id), eq(canvases.graphVersion, expected), isNull(canvases.deletedAt)))
    .returning()
    .get();
  return row ? { ok: true, row } : { ok: false, current: getCanvas(db, id) };
}

/**
 * A save that only moves the view or corrects the size a card measured for itself: written only if
 * graph_version still equals `expected`, and not an edit, so graph_version and updated_at stay.
 * Agents and other tabs holding that version go on editing and saving on top of it.
 */
export function saveCanvasLayout(
  db: Executor,
  id: string,
  expected: number,
  graph: CanvasGraph,
): { ok: true; row: CanvasRow } | { ok: false; current: CanvasRow | undefined } {
  const row = db
    .update(canvases)
    .set({ graph })
    .where(and(eq(canvases.id, id), eq(canvases.graphVersion, expected), isNull(canvases.deletedAt)))
    .returning()
    .get();
  return row ? { ok: true, row } : { ok: false, current: getCanvas(db, id) };
}

/**
 * Writes the results a canvas run settled into the saved document. Not an edit: graph_version and
 * updated_at stay, so an open tab's next save (which carries the same results) isn't refused.
 */
export function setCanvasResults(
  db: Executor,
  id: string,
  graph: CanvasGraph,
  coverAssetId: string | null,
): boolean {
  const row = db
    .update(canvases)
    .set({ graph, coverAssetId })
    .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
    .returning({ id: canvases.id })
    .get();
  return row !== undefined;
}

/** Deletes a canvas with its versions and runs (§7.3). Its images stay in the library. */
export function deleteCanvas(db: Executor, id: string): CanvasRow | undefined {
  return db.delete(canvases).where(eq(canvases.id, id)).returning().get();
}

/** Card image bookkeeping. Doesn't touch graph_version: a preview isn't an edit. */
export function setCanvasPreview(db: Executor, id: string, previewPath: string | null): void {
  db.update(canvases).set({ previewPath }).where(eq(canvases.id, id)).run();
}

export function setCanvasFolder(db: Executor, id: string, folderId: string | null): void {
  db.update(canvases).set({ folderId }).where(eq(canvases.id, id)).run();
}

// Versions

export function insertCanvasVersion(
  db: Executor,
  row: Draft<NewCanvasVersionRow, "createdAt">,
): CanvasVersionRow {
  return db
    .insert(canvasVersions)
    .values({ ...row, createdAt: row.createdAt ?? nowIso() })
    .returning()
    .get();
}

/** Newest first, without the graphs. */
export function listCanvasVersions(db: Executor, canvasId: string): CanvasVersionListRow[] {
  return db
    .select(versionListColumns)
    .from(canvasVersions)
    .where(eq(canvasVersions.canvasId, canvasId))
    .orderBy(desc(canvasVersions.createdAt), desc(canvasVersions.id))
    .all();
}

export function getCanvasVersion(db: Executor, canvasId: string, id: string): CanvasVersionRow | undefined {
  return db
    .select()
    .from(canvasVersions)
    .where(and(eq(canvasVersions.canvasId, canvasId), eq(canvasVersions.id, id)))
    .get();
}

export function newestCanvasVersion(
  db: Executor,
  canvasId: string,
  kind?: CanvasVersionKind,
): CanvasVersionListRow | undefined {
  return db
    .select(versionListColumns)
    .from(canvasVersions)
    .where(and(eq(canvasVersions.canvasId, canvasId), kind ? eq(canvasVersions.kind, kind) : undefined))
    .orderBy(desc(canvasVersions.createdAt), desc(canvasVersions.id))
    .limit(1)
    .get();
}

/**
 * Keeps the newest `keep` snapshots the app took by itself (automatic ones and the safety copies
 * before a delete, import, template or restore). Named versions stay for good (§7.8). Returns how
 * many went.
 */
export function pruneVersions(db: Executor, canvasId: string, keep = CANVAS_AUTO_VERSIONS_KEPT): number {
  const unnamed = ne(canvasVersions.kind, "named");
  const kept = db
    .select({ id: canvasVersions.id })
    .from(canvasVersions)
    .where(and(eq(canvasVersions.canvasId, canvasId), unnamed))
    .orderBy(desc(canvasVersions.createdAt), desc(canvasVersions.id))
    .limit(keep)
    .all()
    .map((r) => r.id);
  return db
    .delete(canvasVersions)
    .where(
      and(
        eq(canvasVersions.canvasId, canvasId),
        unnamed,
        kept.length ? notInArray(canvasVersions.id, kept) : undefined,
      ),
    )
    .returning({ id: canvasVersions.id })
    .all().length;
}

// Runs

export function insertCanvasRun(db: Executor, row: Draft<NewCanvasRunRow, "createdAt">): CanvasRunRow {
  return db
    .insert(canvasRuns)
    .values({ ...row, createdAt: row.createdAt ?? nowIso() })
    .returning()
    .get();
}

export function getCanvasRun(db: Executor, id: string): CanvasRunRow | undefined {
  return db.select().from(canvasRuns).where(eq(canvasRuns.id, id)).get();
}

export type CanvasRunPatch = Partial<{
  status: JobSetState;
  finishedAt: string | null;
  plan: CanvasRunRecord;
  nodes: CanvasRunNodeState[];
}>;

export function updateCanvasRun(db: Executor, id: string, patch: CanvasRunPatch): CanvasRunRow | undefined {
  return db.update(canvasRuns).set(patch).where(eq(canvasRuns.id, id)).returning().get();
}

const activeRun = inArray(canvasRuns.status, [...ACTIVE_JOB_STATES]);

/** Every unfinished run, oldest first, for crash recovery (§8.4.5). */
export function activeCanvasRuns(db: Executor): CanvasRunRow[] {
  return db.select().from(canvasRuns).where(activeRun).orderBy(asc(canvasRuns.createdAt)).all();
}

/** A canvas's unfinished runs, plus those that finished after `since`, oldest first. */
export function canvasRunsSince(db: Executor, canvasId: string, since?: string): CanvasRunRow[] {
  return db
    .select()
    .from(canvasRuns)
    .where(
      and(
        eq(canvasRuns.canvasId, canvasId),
        since ? or(activeRun, gt(canvasRuns.finishedAt, since)) : activeRun,
      ),
    )
    .orderBy(asc(canvasRuns.createdAt))
    .all();
}

/** The job sets a run created, oldest first. */
export function jobSetsOfRun(db: Executor, runId: string): JobSetRow[] {
  return db
    .select()
    .from(jobSets)
    .where(eq(jobSets.canvasRunId, runId))
    .orderBy(asc(jobSets.createdAt), asc(jobSets.id))
    .all();
}
