import { join } from "node:path";
import {
  CANVAS_AUTO_VERSION_MS,
  CANVAS_PREVIEW_MAX_NODES,
  type CanvasConflictResponse,
  type CanvasCreateBody,
  type CanvasDetail,
  type CanvasPatchBody,
  type CanvasPatchResponse,
  type CanvasPreviewResponse,
  type CanvasPreviewTheme,
  type CanvasRunNodeState,
  type CanvasSummary,
  type CanvasTemplate,
  type CanvasVersion,
  type CanvasVersionCreateBody,
  type CanvasVersionDetail,
  newId,
  t,
} from "@openfield/core";
import { CANVAS_SCHEMA_VERSION, type CanvasDocument, resultOfRunNode } from "@openfield/core/canvas";
import {
  type CanvasRow,
  type Db,
  deleteCanvas,
  getAssets,
  getCanvas,
  getCanvasVersion,
  insertCanvas,
  insertCanvasVersion,
  listCanvases,
  listCanvasVersions,
  listFolders,
  newestCanvasVersion,
  pruneVersions,
  saveCanvas,
  setCanvasPreview,
  setCanvasResults,
  updateFolder,
} from "@openfield/db";
import type { HomePaths } from "../config/home";
import { probeImage } from "../files/probe";
import { ApiFailure, envelope } from "../http/errors";
import type { Logger } from "../log/logger";
import {
  canvasPreviewUrl,
  previewTakenAt,
  toCanvasDetail,
  toCanvasSummary,
  toCanvasVersion,
  toCanvasVersionDetail,
} from "../mappers/canvas";
import type { ModelService } from "../services/models";
import type { SettingsService } from "../services/settings";
import {
  defaultModel,
  documentAssetIds,
  documentCounts,
  emptyDocument,
  fillModels,
  pickCover,
  readDocument,
  sameContent,
  stamp,
} from "./documents";
import { copyPreview, removeDocumentFile, removePreview, writeDocumentFile, writePreview } from "./files";
import { BUNDLED_TEMPLATES_DIR, CanvasTemplates } from "./templates";

// Canvas documents (M4-01, M4-11, M4-14, M4-15): the index, autosave with optimistic
// concurrency, version history, templates and card previews. Runs live in ./runs.

const NAME_MAX = 200;

export interface CanvasServiceDeps {
  db: Db;
  paths: HomePaths;
  models: ModelService;
  settings: SettingsService;
  logger: Logger;
  /** Where the bundled templates live. Tests point it elsewhere. */
  templatesDir?: string;
}

export class CanvasService {
  readonly templates: CanvasTemplates;

  constructor(private readonly deps: CanvasServiceDeps) {
    this.templates = new CanvasTemplates(
      {
        bundled: deps.templatesDir ?? BUNDLED_TEMPLATES_DIR,
        user: join(deps.paths.root, "canvases", "templates"),
      },
      deps.logger,
    );
  }

  list(name?: string): CanvasSummary[] {
    const rows = listCanvases(this.deps.db, name ? { name } : {});
    const covers = rows.map((r) => r.coverAssetId).filter((id): id is string => id !== null);
    const live = new Set(getAssets(this.deps.db, covers).map((a) => a.id));
    return rows.map((row) => toCanvasSummary(row, this.deps.paths, live));
  }

  /** A blank canvas, a copy of a template, or an imported document. */
  create(body: CanvasCreateBody): CanvasDetail {
    if (body.templateId && body.graph) {
      throw new ApiFailure(400, "bad_request", "Send a template or a document, not both", {
        field: "templateId",
      });
    }
    const id = newId();
    const at = new Date().toISOString();
    let doc: CanvasDocument;
    let name: string;
    if (body.templateId) {
      const template = this.templates.get(body.templateId);
      if (!template) {
        throw new ApiFailure(400, "bad_request", `No template ${body.templateId}`, {
          field: "templateId",
          userMessage: t("canvas.errors.templateMissing"),
        });
      }
      doc = structuredClone(template.graph);
      name = body.name ?? template.name;
    } else if (body.graph) {
      doc = body.graph;
      name = body.name ?? (body.graph.name.trim() || t("canvas.names.untitled"));
    } else {
      doc = emptyDocument(id, "", at);
      name = body.name ?? t("canvas.names.untitled");
    }
    // A preview path from another library means nothing here.
    doc = stamp(
      { ...doc, meta: { ...doc.meta, previewPath: null } },
      { id, name, updatedAt: at, createdAt: at },
    );
    doc = fillModels(doc, defaultModel(this.deps.models, this.deps.settings));
    const row = insertCanvas(this.deps.db, {
      id,
      name,
      graph: doc,
      graphVersion: 1,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      nodeCount: doc.nodes.length,
      coverAssetId: pickCover(this.deps.db, doc),
      createdAt: at,
      updatedAt: at,
    });
    this.#writeThrough(doc);
    return toCanvasDetail(row, doc);
  }

  /** Opening a canvas: the document in the current shape, and the images it names that aren't here. */
  get(id: string): CanvasDetail {
    const row = this.#row(id);
    const doc = readDocument(row.graph);
    return {
      ...toCanvasDetail(row, doc),
      missingAssetIds: this.#missingAssets(doc),
      previewAt: previewTakenAt(row, this.deps.paths),
    };
  }

  /**
   * Autosave (§7.8). Rejected with the server's copy when another tab saved first. Snapshots the
   * new content when the newest automatic snapshot is at least five minutes old.
   */
  save(
    id: string,
    body: CanvasPatchBody,
  ): { ok: true; saved: CanvasPatchResponse } | { ok: false; conflict: CanvasConflictResponse } {
    const { db } = this.deps;
    const at = new Date().toISOString();
    const result = db.transaction((tx) => {
      const row = getCanvas(tx, id);
      if (!row) return { kind: "missing" as const };
      const before = readDocument(row.graph);
      if (row.graphVersion !== body.graphVersion) {
        // Two tabs that both wrote the same run results into their copies aren't a conflict: the
        // save would change nothing.
        const same = (body.name ?? row.name) === row.name && (!body.graph || sameContent(body.graph, before));
        return same ? { kind: "unchanged" as const, row } : { kind: "conflict" as const, row };
      }
      const name = body.name ?? row.name;
      const next = stamp(body.graph ?? before, { id, name, updatedAt: at, createdAt: row.createdAt });
      const saved = saveCanvas(tx, id, body.graphVersion, {
        graph: next,
        name,
        nodeCount: next.nodes.length,
        coverAssetId: pickCover(db, next),
        at,
      });
      if (!saved.ok) return { kind: "conflict" as const, row: saved.current ?? row };
      if (name !== row.name) this.#renameFolder(row, name);
      if (!sameContent(before, next) && this.#autoSnapshotDue(id, at)) {
        this.#snapshot(id, next, "auto", null, at);
        pruneVersions(tx, id);
      }
      return { kind: "saved" as const, row: saved.row, doc: next };
    });
    if (result.kind === "missing") throw this.#missing();
    if (result.kind === "unchanged") {
      return { ok: true, saved: { graphVersion: result.row.graphVersion, updatedAt: result.row.updatedAt } };
    }
    if (result.kind === "conflict") {
      const current = result.row;
      return {
        ok: false,
        conflict: {
          ...envelope("conflict", `graphVersion is ${current.graphVersion}`, {
            field: "graphVersion",
            userMessage: t("errors.transport.conflict"),
          }),
          canvas: toCanvasDetail(current, readDocument(current.graph)),
        },
      };
    }
    this.#writeThrough(result.doc);
    return { ok: true, saved: { graphVersion: result.row.graphVersion, updatedAt: result.row.updatedAt } };
  }

  /**
   * Delete (§7.3): the canvas with its versions, runs and card picture. The images it made stay in
   * the library, in its folder.
   */
  remove(id: string): void {
    const row = deleteCanvas(this.deps.db, id);
    if (!row) throw this.#missing();
    removePreview(this.deps.paths, row.previewPath);
    removeDocumentFile(this.deps.paths, id);
  }

  /**
   * Nodes a run settled, written into the saved canvas for nodes that are still there. Not an
   * edit: the version token stays, so open tabs keep saving (they write the same results).
   */
  writeRunResults(id: string, settled: ReadonlyMap<string, CanvasRunNodeState>, at: string): void {
    const { db } = this.deps;
    const doc = db.transaction((tx) => {
      const row = getCanvas(tx, id);
      if (!row) return null;
      const before = readDocument(row.graph);
      let changed = false;
      const nodes = before.nodes.map((node) => {
        const state = settled.get(node.id);
        const result = state ? resultOfRunNode(state, at, node.result) : null;
        if (!result) return node;
        changed = true;
        return { ...node, result };
      });
      if (!changed) return null;
      const next = { ...before, nodes };
      setCanvasResults(tx, id, next, pickCover(tx, next));
      return next;
    });
    if (doc) this.#writeThrough(doc);
  }

  /** A copy with results kept, named "{name} copy". Versions stay with the original. */
  duplicate(id: string): CanvasDetail {
    const source = this.#row(id);
    const newCanvasId = newId();
    const at = new Date().toISOString();
    const name = t("canvas.names.copy", { name: source.name }).slice(0, NAME_MAX);
    const doc = stamp(readDocument(source.graph), { id: newCanvasId, name, updatedAt: at, createdAt: at });
    const row = insertCanvas(this.deps.db, {
      id: newCanvasId,
      name,
      graph: doc,
      graphVersion: 1,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      nodeCount: source.nodeCount,
      coverAssetId: source.coverAssetId,
      previewPath: copyPreview(this.deps.paths, source.previewPath, newCanvasId),
      createdAt: at,
      updatedAt: at,
    });
    this.#writeThrough(doc);
    return toCanvasDetail(row, doc);
  }

  // Versions (§7.8, M4-11)

  versions(id: string): CanvasVersion[] {
    this.#row(id);
    return listCanvasVersions(this.deps.db, id).map(toCanvasVersion);
  }

  /** Save version, or the safety snapshot before a big delete, an import or a template. */
  createVersion(id: string, body: CanvasVersionCreateBody): CanvasVersion {
    const row = this.#row(id);
    const kind = body.kind ?? "named";
    const version = this.#snapshot(id, readDocument(row.graph), kind, body.label ?? null);
    if (kind !== "named") pruneVersions(this.deps.db, id);
    return toCanvasVersion(version);
  }

  version(id: string, versionId: string): CanvasVersionDetail {
    this.#row(id);
    const version = getCanvasVersion(this.deps.db, id, versionId);
    if (!version) throw new ApiFailure(404, "not_found", "That version doesn't exist", { field: "vid" });
    return toCanvasVersionDetail(version, readDocument(version.graph));
  }

  /** Snapshots what's there now, then puts the version back, so restoring never loses work. */
  restore(id: string, versionId: string): CanvasDetail {
    const { db } = this.deps;
    const at = new Date().toISOString();
    const result = db.transaction((tx) => {
      const row = getCanvas(tx, id);
      if (!row) throw this.#missing();
      const version = getCanvasVersion(tx, id, versionId);
      if (!version) throw new ApiFailure(404, "not_found", "That version doesn't exist", { field: "vid" });
      this.#snapshot(id, readDocument(row.graph), "before_restore", null, at);
      pruneVersions(tx, id);
      const doc = stamp(readDocument(version.graph), {
        id,
        name: row.name,
        updatedAt: at,
        createdAt: row.createdAt,
      });
      const saved = saveCanvas(tx, id, row.graphVersion, {
        graph: doc,
        name: row.name,
        nodeCount: doc.nodes.length,
        coverAssetId: pickCover(db, doc),
        at,
      });
      if (!saved.ok) throw new ApiFailure(409, "conflict", "The canvas changed while restoring");
      return { row: saved.row, doc };
    });
    this.#writeThrough(result.doc);
    return toCanvasDetail(result.row, result.doc);
  }

  // Previews (M4-15)

  /**
   * The browser renders the card, once per theme; this keeps it. Past the node limit the cover
   * image is used instead.
   */
  setPreview(id: string, png: Uint8Array, theme: CanvasPreviewTheme = "light"): CanvasPreviewResponse {
    const row = this.#row(id);
    if (probeImage(png)?.mime !== "image/png") {
      throw new ApiFailure(400, "bad_request", "The preview must be a PNG image");
    }
    if (row.nodeCount > CANVAS_PREVIEW_MAX_NODES) {
      throw new ApiFailure(400, "bad_request", `Over ${CANVAS_PREVIEW_MAX_NODES} nodes`, {
        userMessage: t("canvas.errors.previewTooBig", { max: CANVAS_PREVIEW_MAX_NODES }),
      });
    }
    const path = writePreview(this.deps.paths, id, png, theme);
    setCanvasPreview(this.deps.db, id, path);
    return { previewUrl: canvasPreviewUrl(id, Date.now()) };
  }

  /** The stored preview's path, relative to the library, for GET /files/canvas-preview/:id. */
  previewPath(id: string): string | null {
    return getCanvas(this.deps.db, id)?.previewPath ?? null;
  }

  listTemplates(): CanvasTemplate[] {
    return this.templates.list();
  }

  // Internals

  #row(id: string): CanvasRow {
    const row = getCanvas(this.deps.db, id);
    if (!row) throw this.#missing();
    return row;
  }

  #missing(): ApiFailure {
    return new ApiFailure(404, "not_found", "That canvas doesn't exist", { field: "id" });
  }

  /** Images the document names that aren't in the library, or whose file is gone. */
  #missingAssets(doc: CanvasDocument): string[] {
    const ids = documentAssetIds(doc);
    if (!ids.length) return [];
    const here = new Set(
      getAssets(this.deps.db, ids)
        .filter((a) => a.fileState === "ok")
        .map((a) => a.id),
    );
    return ids.filter((assetId) => !here.has(assetId));
  }

  /** The canvas's library folder follows a rename, unless the person already renamed the folder. */
  #renameFolder(row: CanvasRow, name: string): void {
    if (!row.folderId) return;
    const folder = listFolders(this.deps.db).find((f) => f.id === row.folderId);
    if (folder?.name === row.name) updateFolder(this.deps.db, folder.id, { name });
  }

  #autoSnapshotDue(id: string, at: string): boolean {
    const newest = newestCanvasVersion(this.deps.db, id, "auto");
    return !newest || Date.parse(at) - Date.parse(newest.createdAt) >= CANVAS_AUTO_VERSION_MS;
  }

  #snapshot(
    id: string,
    doc: CanvasDocument,
    kind: CanvasVersion["kind"],
    label: string | null,
    at = new Date().toISOString(),
  ) {
    const { nodeCount, edgeCount } = documentCounts(doc);
    return insertCanvasVersion(this.deps.db, {
      id: newId(),
      canvasId: id,
      graph: doc,
      label,
      kind,
      nodeCount,
      edgeCount,
      coverAssetId: pickCover(this.deps.db, doc),
      createdAt: at,
    });
  }

  /** "Also save canvases as files" (§7.8). A failed copy is logged; the save itself stands. */
  #writeThrough(doc: CanvasDocument): void {
    if (!this.deps.settings.get().canvasFileWriteThrough) return;
    try {
      writeDocumentFile(this.deps.paths, doc);
    } catch (error) {
      this.deps.logger.warn("Couldn't save the canvas file", { canvasId: doc.id, error });
    }
  }
}
