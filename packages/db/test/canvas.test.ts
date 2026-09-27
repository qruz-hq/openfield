import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newId } from "@openfield/core";
import { CANVAS_SCHEMA, type CanvasDocument } from "@openfield/core/canvas";
import {
  activeCanvasRuns,
  canvasRunsSince,
  deleteCanvas,
  getCanvas,
  insertCanvas,
  insertCanvasRun,
  insertCanvasVersion,
  listCanvases,
  listCanvasVersions,
  newestCanvasVersion,
  type OpenDb,
  openDb,
  pruneVersions,
  saveCanvas,
  updateCanvasRun,
} from "../src";

// Canvas query helpers (§8.2): the version check in one statement, pruning that only touches
// automatic snapshots, and the run lists recovery and the editor read.

let opened: OpenDb;
const db = () => opened.db;
beforeEach(() => {
  opened = openDb(":memory:");
});
afterEach(() => opened.close());

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 24, 12, minutes)).toISOString();

function doc(id: string, name = "Untitled"): CanvasDocument {
  return {
    schema: CANVAS_SCHEMA,
    id,
    name,
    createdAt: at(0),
    updatedAt: at(0),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    comments: [],
    meta: {},
  };
}

function canvas(name = "Untitled", minutes = 0) {
  const id = newId();
  return insertCanvas(db(), {
    id,
    name,
    graph: doc(id, name),
    createdAt: at(minutes),
    updatedAt: at(minutes),
  });
}

describe("canvases", () => {
  test("a save only lands on the version it was based on, and bumps it", () => {
    const row = canvas();
    const save = { graph: doc(row.id, "Renamed"), name: "Renamed", nodeCount: 3, coverAssetId: null };
    const first = saveCanvas(db(), row.id, 1, save);
    expect(first.ok && first.row.graphVersion).toBe(2);
    const stale = saveCanvas(db(), row.id, 1, { ...save, name: "Lost" });
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.current?.name).toBe("Renamed");
    expect(getCanvas(db(), row.id)).toMatchObject({ name: "Renamed", nodeCount: 3, graphVersion: 2 });
  });

  test("the index lists live canvases, last edited first, and searches names", () => {
    const old = canvas("Harbor 50%", 1);
    const recent = canvas("Lighthouse", 5);
    const gone = canvas("Harbor gone", 9);
    deleteCanvas(db(), gone.id);
    expect(listCanvases(db()).map((c) => c.id)).toEqual([recent.id, old.id]);
    expect(listCanvases(db(), { name: "HARBOR" }).map((c) => c.id)).toEqual([old.id]);
    expect(listCanvases(db(), { name: "50%" }).map((c) => c.id)).toEqual([old.id]);
    expect(listCanvases(db(), { name: "_" })).toEqual([]);
    expect("graph" in listCanvases(db())[0]!).toBe(false);
  });
});

describe("versions", () => {
  test("pruning keeps the newest snapshots the app took and every named one", () => {
    const row = canvas();
    const kinds = ["auto", "named", "auto", "before_delete", "auto"] as const;
    for (const [i, kind] of kinds.entries()) {
      insertCanvasVersion(db(), {
        id: newId(),
        canvasId: row.id,
        graph: doc(row.id),
        kind,
        createdAt: at(i),
      });
    }
    expect(newestCanvasVersion(db(), row.id, "auto")?.createdAt).toBe(at(4));
    expect(pruneVersions(db(), row.id, 2)).toBe(2);
    expect(listCanvasVersions(db(), row.id).map((v) => v.kind)).toEqual(["auto", "before_delete", "named"]);
  });
});

describe("runs", () => {
  test("active runs, and those finished after a time, oldest first", () => {
    const row = canvas();
    const plan = { nodeIds: [], items: [], launches: [], canceled: false, canceledNodes: [], agent: null };
    const run = (minutes: number) =>
      insertCanvasRun(db(), { id: newId(), canvasId: row.id, scope: "all", plan, createdAt: at(minutes) });
    const done = run(1);
    const active = run(2);
    const older = run(0);
    updateCanvasRun(db(), done.id, { status: "succeeded", finishedAt: at(10) });
    updateCanvasRun(db(), older.id, { status: "failed", finishedAt: at(3) });

    expect(activeCanvasRuns(db()).map((r) => r.id)).toEqual([active.id]);
    expect(canvasRunsSince(db(), row.id).map((r) => r.id)).toEqual([active.id]);
    expect(canvasRunsSince(db(), row.id, at(5)).map((r) => r.id)).toEqual([done.id, active.id]);
    expect(canvasRunsSince(db(), row.id, at(0)).map((r) => r.id)).toEqual([older.id, done.id, active.id]);
  });
});
