import { join } from "node:path";
import {
  applyOps,
  type CanvasOp,
  CanvasOpError,
  compileEdits,
  compileRun,
  type DocSlice,
  EditError,
  type EngineContext,
  fromDocument,
  limitProblem,
  lockedTargets,
  lockProblem,
  nodeTitle,
  specRegistry,
  toDocument,
  toWireOps,
} from "@openfield/canvas";
import {
  CANVAS_AUTO_VERSION_MS,
  CANVAS_PREVIEW_MAX_NODES,
  type CanvasActor,
  type CanvasConflictResponse,
  type CanvasCreateBody,
  type CanvasDetail,
  type CanvasEditsResponse,
  type CanvasPatchBody,
  type CanvasPatchResponse,
  type CanvasPreviewResponse,
  type CanvasPreviewTheme,
  type CanvasRunNodeState,
  type CanvasSpendResponse,
  type CanvasSummary,
  type CanvasTemplate,
  type CanvasVersion,
  type CanvasVersionCreateBody,
  type CanvasVersionDetail,
  canvasRunPlanItemSchema,
  DEFAULT_CURRENCY,
  type MessageKey,
  newId,
  t,
} from "@openfield/core";
import {
  CANVAS_SCHEMA_VERSION,
  type CanvasDocument,
  type CanvasEdit,
  type CanvasViewport,
  canvasDocumentSchema,
  resultOfRunNode,
} from "@openfield/core/canvas";
import {
  type CanvasRow,
  canvasSpend,
  type Db,
  deleteCanvas,
  getAssets,
  getCanvas,
  getCanvasVersion,
  getFolder,
  insertCanvas,
  insertCanvasVersion,
  listCanvases,
  listCanvasVersions,
  newestCanvasVersion,
  pruneVersions,
  saveCanvas,
  saveCanvasLayout,
  setCanvasPreview,
  setCanvasResults,
  updateFolder,
} from "@openfield/db";
import type { HomePaths } from "../config/home";
import type { EventHub } from "../events/hub";
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
  sameEdits,
  stamp,
} from "./documents";
import { copyPreview, removeDocumentFile, removePreview, writeDocumentFile, writePreview } from "./files";
import { BUNDLED_TEMPLATES_DIR, CanvasTemplates } from "./templates";

// Canvas documents (M4-01, M4-11, M4-14, M4-15): the index, autosave with optimistic
// concurrency, version history, templates and card previews. Runs live in ./runs.

const NAME_MAX = 200;
/** Recent versions of a canvas kept in memory, so an agent can hear what changed since the one it read. */
const VERSIONS_REMEMBERED = 32;
/** Canvases whose recent versions are kept, the least recently changed going first. */
const CANVASES_REMEMBERED = 64;

export interface CanvasServiceDeps {
  db: Db;
  paths: HomePaths;
  models: ModelService;
  settings: SettingsService;
  logger: Logger;
  /** Tells other tabs when the canvas's folder follows a rename, and sends live edits (§7.11). */
  events?: EventHub;
  /** The engine's view of models and settings, for edits that add nodes with their defaults. */
  engineContext: () => EngineContext;
  /** Nodes queued or running in this canvas's runs: they can't be deleted or leave their frame. */
  busyNodes?: (canvasId: string) => ReadonlySet<string>;
  /** Where the bundled templates live. Tests point it elsewhere. */
  templatesDir?: string;
}

type Built = {
  ops: CanvasOp[];
  doc: DocSlice;
  touched: string[];
  aliases: Record<string, string>;
  notes?: string[];
};

export class CanvasService {
  readonly templates: CanvasTemplates;
  /** Agent sessions that saved a version before their first change, per canvas. */
  readonly #agentSaved = new Set<string>();
  /** Each canvas's recent documents by graphVersion, as each version was first saved. */
  readonly #recent = new Map<string, Map<number, CanvasDocument>>();

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
    this.#remember(id, row.graphVersion, doc);
    this.#writeThrough(doc);
    return toCanvasDetail(row, doc);
  }

  /**
   * The document as it was when it reached `graphVersion`, while that version is recent enough to
   * be remembered, else null.
   */
  documentAt(id: string, graphVersion: number): CanvasDocument | null {
    return this.#recent.get(id)?.get(graphVersion) ?? null;
  }

  /**
   * Opening a canvas: the document in the current shape, the images it names that aren't here, and
   * the size of those that are.
   */
  /** What this canvas's runs have cost, by Spending's rules (the canvas's spend pill). */
  spend(id: string): CanvasSpendResponse {
    this.#row(id);
    const row = canvasSpend(this.deps.db, id);
    const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
    return {
      usd: round(row.usd),
      images: row.images,
      usdDiscarded: round(row.usdDiscarded),
      currency: DEFAULT_CURRENCY,
    };
  }

  get(id: string): CanvasDetail {
    const row = this.#row(id);
    const doc = readDocument(row.graph);
    const { missing, sizes } = this.#assets(doc);
    return {
      ...toCanvasDetail(row, doc),
      missingAssetIds: missing,
      assetSizes: sizes,
      previewAt: previewTakenAt(row, this.deps.paths),
    };
  }

  /**
   * Autosave (§7.8). Rejected with the server's copy when another tab saved first. Snapshots the
   * new content when the newest automatic snapshot is at least five minutes old. A save that only
   * moves the view or corrects a card's measured size keeps the version (sameEdits), so it never
   * turns an agent's or another tab's next change into a conflict.
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
      if (name === row.name && body.graph && sameEdits(body.graph, before)) {
        const next = stamp(body.graph, { id, name, updatedAt: row.updatedAt, createdAt: row.createdAt });
        const saved = saveCanvasLayout(tx, id, body.graphVersion, next);
        if (!saved.ok) return { kind: "conflict" as const, row: saved.current ?? row };
        return { kind: "saved" as const, row: saved.row, doc: next };
      }
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
      this.#remember(id, saved.row.graphVersion, next);
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
      this.#remember(id, saved.row.graphVersion, doc);
      return { row: saved.row, doc };
    });
    this.#writeThrough(result.doc);
    return toCanvasDetail(result.row, result.doc);
  }

  // Live edits (§7.11)

  /**
   * Edits from an agent or a script, compiled against the saved canvas with the editor's own rules,
   * saved as the next version of the document and sent to every open tab as the ops to replay. With
   * graphVersion, a canvas that changed since is a 409, like autosave.
   */
  edit(
    id: string,
    edits: readonly CanvasEdit[],
    actor: CanvasActor,
    opts: { graphVersion?: number } = {},
  ): CanvasEditsResponse {
    const ctx = this.deps.engineContext();
    return this.#change(id, actor, opts, (slice, viewport, before) => {
      try {
        // Image cards count at their images' shape, as the library knows it.
        const images = this.#assets(before).sizes;
        return compileEdits(slice, edits, { specs: specRegistry, ctx, viewport, images });
      } catch (error) {
        if (!(error instanceof EditError)) throw error;
        throw new ApiFailure(400, "bad_request", error.message, {
          field: `edits.${error.index}`,
          userMessage: error.message,
        });
      }
    });
  }

  /** The editor's own document ops, applied as they are. */
  applyOps(
    id: string,
    ops: readonly CanvasOp[],
    actor: CanvasActor,
    opts: { graphVersion?: number } = {},
  ): CanvasEditsResponse {
    return this.#change(id, actor, opts, (slice) => {
      try {
        const { doc } = applyOps(slice, ops);
        return { ops: [...ops], doc, touched: touchedBy(ops, doc), aliases: {} };
      } catch (error) {
        if (!(error instanceof CanvasOpError)) throw error;
        throw new ApiFailure(400, "bad_request", error.message, {
          userMessage: t("canvas.edits.cantApply", { reason: error.message }),
        });
      }
    });
  }

  /**
   * Before an agent session's first change to a canvas (an edit or a run), the canvas as it was is
   * saved as a version, "Before Claude Code", so the person can go back. The version's id, or null
   * when this session already has one here.
   */
  saveAgentVersion(id: string, actor: CanvasActor): string | null {
    if (actor.kind !== "agent" || this.#agentSaved.has(agentKey(actor, id))) return null;
    const row = this.#row(id);
    const version = this.#agentVersion(id, actor, readDocument(row.graph));
    this.#agentSaved.add(agentKey(actor, id));
    return version;
  }

  #change(
    id: string,
    actor: CanvasActor,
    opts: { graphVersion?: number },
    build: (slice: DocSlice, viewport: CanvasViewport, before: CanvasDocument) => Built,
  ): CanvasEditsResponse {
    const { db } = this.deps;
    const at = new Date().toISOString();
    const result = db.transaction((tx) => {
      const row = getCanvas(tx, id);
      if (!row) throw this.#missing();
      if (opts.graphVersion !== undefined && opts.graphVersion !== row.graphVersion) throw this.#stale(row);
      const before = readDocument(row.graph);
      const { slice, viewport, meta } = fromDocument(before);
      // The canvases.name column is the name of record; the document copy follows it.
      const built = build({ ...slice, name: row.name }, viewport, before);
      if (!built.ops.length) return { kind: "unchanged" as const, row, built };
      this.#checkNotRunning(id, built.ops);
      this.#checkLocks(slice, built.doc);
      const name = built.doc.name.trim() || row.name;
      const next = stamp(toDocument(built.doc, meta, viewport, at), {
        id,
        name,
        updatedAt: at,
        createdAt: row.createdAt,
      });
      this.#checkDocument(next, built.touched);
      this.#checkLimits(built.doc, built.touched);
      this.#checkRunnable(built.doc, built.touched);
      const versionId = this.#agentVersion(id, actor, before, at);
      const saved = saveCanvas(tx, id, row.graphVersion, {
        graph: next,
        name,
        nodeCount: next.nodes.length,
        coverAssetId: pickCover(db, next),
        at,
      });
      if (!saved.ok) throw this.#stale(saved.current ?? row);
      this.#remember(id, saved.row.graphVersion, next);
      if (name !== row.name) this.#renameFolder(row, name);
      if (this.#autoSnapshotDue(id, at)) {
        this.#snapshot(id, next, "auto", null, at);
        pruneVersions(tx, id);
      }
      return { kind: "saved" as const, row, saved: saved.row, next, built, versionId };
    });

    if (result.kind === "unchanged") {
      return {
        graphVersion: result.row.graphVersion,
        updatedAt: result.row.updatedAt,
        ops: [],
        touched: [],
        aliases: result.built.aliases,
        versionId: null,
      };
    }
    if (actor.kind === "agent") this.#agentSaved.add(agentKey(actor, id));
    this.#writeThrough(result.next);
    const { built, versionId } = result;
    const notes = built.notes ?? [];
    const ops = toWireOps(built.ops);
    this.deps.events?.publish("canvas.updated", {
      canvasId: id,
      fromVersion: result.row.graphVersion,
      graphVersion: result.saved.graphVersion,
      updatedAt: result.saved.updatedAt,
      ops,
      touched: built.touched,
      actor,
      versionId,
    });
    if (actor.kind === "agent") {
      this.deps.events?.publish("agent.activity", {
        canvasId: id,
        actor,
        nodeIds: built.touched,
        kind: "editing",
        at,
        versionId,
      });
    }
    return {
      graphVersion: result.saved.graphVersion,
      updatedAt: result.saved.updatedAt,
      ops,
      touched: built.touched,
      aliases: built.aliases,
      versionId,
      ...(notes.length > 0 && { notes }),
    };
  }

  #agentVersion(id: string, actor: CanvasActor, before: CanvasDocument, at?: string): string | null {
    if (actor.kind !== "agent" || this.#agentSaved.has(agentKey(actor, id))) return null;
    const label = t("canvas.agents.versionLabel", { name: actor.name });
    // Named, so it's kept like a version the person saved themselves (§7.8).
    const version = this.#snapshot(id, before, "named", label, at);
    return version.id;
  }

  /** Locked nodes stay as they are when an agent or a script changes the canvas (lockProblem). */
  #checkLocks(before: DocSlice, after: DocSlice): void {
    const problem = lockProblem(before, after, specRegistry);
    if (!problem) return;
    throw new ApiFailure(409, "conflict", `${problem.nodeId} is locked`, {
      field: `nodes.${problem.nodeId}`,
      userMessage: problem.message,
    });
  }

  /**
   * Every touched node's settings within the limits the editor keeps to (NODE_LIMITS): the words
   * of a Prompt node, how many prompts or models Variations takes. Past one, the edit is refused and
   * says which, instead of being cut short without a word.
   */
  #checkLimits(slice: DocSlice, touched: readonly string[]): void {
    for (const id of touched) {
      const node = slice.nodes[id];
      if (!node) continue;
      const problem = limitProblem(node.type, slice.params[id] ?? {});
      if (problem) {
        throw new ApiFailure(400, "bad_request", problem, { field: `nodes.${id}`, userMessage: problem });
      }
    }
  }

  /**
   * What the edits touched has to be something a run can send. A run plan has limits of its own (a
   * caption's length, how many requests, a prompt's length with the words coming in), so the touched
   * nodes are compiled as a run would compile them and each plan item is checked against those.
   */
  #checkRunnable(slice: DocSlice, touched: readonly string[]): void {
    const nodeIds = touched.filter((id) => slice.nodes[id]);
    if (!nodeIds.length) return;
    // Fingerprints only decide what's up to date; every touched node is compiled here.
    const fingerprints = Object.fromEntries(slice.order.map((id) => [id, PLACEHOLDER_FINGERPRINT]));
    const outcome = compileRun({
      doc: slice,
      registry: specRegistry,
      ctx: this.deps.engineContext(),
      fingerprints,
      request: { scope: "selection", nodeIds, bypassCache: true },
    });
    if (outcome.kind !== "plan") return;
    for (const { item } of outcome.items) {
      const parsed = canvasRunPlanItemSchema.safeParse(item);
      if (parsed.success) continue;
      const frame = slice.nodes[item.nodeId];
      const node = frame ? nodeTitle(frame, specRegistry) : item.nodeId;
      const reason = planIssue(parsed.error.issues[0]);
      throw new ApiFailure(400, "bad_request", `${node}: ${reason}`, {
        field: `nodes.${item.nodeId}`,
        userMessage: t("canvas.edits.wontRun", { node, reason }),
      });
    }
  }

  /** A node with a run in flight can't be deleted or taken out of its frame (§7.7). */
  #checkNotRunning(id: string, ops: readonly CanvasOp[]): void {
    const busy = this.deps.busyNodes?.(id);
    if (!busy?.size) return;
    const locked = [...new Set(lockedTargets(ops).filter((nodeId) => busy.has(nodeId)))];
    if (!locked.length) return;
    throw new ApiFailure(409, "conflict", `${locked.join(", ")} running`, {
      userMessage: t("canvas.edits.running", { count: locked.length }),
    });
  }

  /**
   * The document the edits leave must be one the editor opens. Only what the edits touched is
   * checked: an older canvas can carry settings this build reads leniently.
   */
  #checkDocument(doc: CanvasDocument, touched: readonly string[]): void {
    const parsed = canvasDocumentSchema.safeParse(doc);
    if (!parsed.success) {
      const mine = new Set(touched);
      const issue = parsed.error.issues.find((i) => {
        const [key, index] = i.path;
        if (key !== "nodes" || typeof index !== "number") return true;
        return mine.has(doc.nodes[index]?.id ?? "");
      });
      if (issue) {
        throw new ApiFailure(400, "bad_request", issue.message, {
          userMessage: t("canvas.edits.invalid", { reason: issue.message }),
        });
      }
    }
    // Images a node was given have to be in this library.
    const named = doc.nodes.flatMap((node) => {
      const ids = touched.includes(node.id) ? node.params.assetIds : undefined;
      return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [];
    });
    if (!named.length) return;
    const here = new Set(
      getAssets(this.deps.db, named)
        .filter((a) => a.fileState === "ok")
        .map((a) => a.id),
    );
    const missing = named.find((assetId) => !here.has(assetId));
    if (missing) {
      throw new ApiFailure(400, "bad_request", `No asset ${missing}`, {
        userMessage: t("canvas.edits.missingAsset", { id: missing }),
      });
    }
  }

  #stale(row: CanvasRow): ApiFailure {
    return new ApiFailure(409, "conflict", `graphVersion is ${row.graphVersion}`, {
      field: "graphVersion",
      userMessage: t("errors.transport.conflict"),
    });
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

  /** Images the document names that aren't in the library (or whose file is gone), and the size of the rest. */
  #assets(doc: CanvasDocument): { missing: string[]; sizes: Record<string, { w: number; h: number }> } {
    const ids = documentAssetIds(doc);
    const sizes: Record<string, { w: number; h: number }> = {};
    if (!ids.length) return { missing: [], sizes };
    const here = new Set<string>();
    for (const a of getAssets(this.deps.db, ids)) {
      if (a.fileState !== "ok") continue;
      here.add(a.id);
      if (a.width > 0 && a.height > 0) sizes[a.id] = { w: a.width, h: a.height };
    }
    return { missing: ids.filter((assetId) => !here.has(assetId)), sizes };
  }

  /** The canvas's library folder follows a rename, unless the person already renamed the folder. */
  #renameFolder(row: CanvasRow, name: string): void {
    if (!row.folderId) return;
    const folder = getFolder(this.deps.db, row.folderId);
    if (folder?.name !== row.name) return;
    updateFolder(this.deps.db, folder.id, { name });
    this.deps.events?.publish("folder.updated", { folderId: folder.id, deleted: false });
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

  #remember(id: string, graphVersion: number, doc: CanvasDocument): void {
    const versions = this.#recent.get(id) ?? new Map<number, CanvasDocument>();
    this.#recent.delete(id);
    this.#recent.set(id, versions);
    if (!versions.has(graphVersion)) versions.set(graphVersion, doc);
    for (const old of versions.keys()) {
      if (versions.size <= VERSIONS_REMEMBERED) break;
      versions.delete(old);
    }
    for (const old of this.#recent.keys()) {
      if (this.#recent.size <= CANVASES_REMEMBERED) break;
      this.#recent.delete(old);
    }
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

const agentKey = (actor: Extract<CanvasActor, { kind: "agent" }>, canvasId: string) =>
  `${actor.sessionId}\u0000${canvasId}`;

/** Nodes a list of document ops adds or changes, that are still there after them. */
function touchedBy(ops: readonly CanvasOp[], doc: DocSlice): string[] {
  const ids: string[] = [];
  for (const op of ops) {
    const id =
      op.op === "addNode"
        ? op.node.id
        : op.op === "addEdge"
          ? op.edge.target
          : "id" in op && op.op !== "deleteEdge" && op.op !== "reconnectEdge" && op.op !== "setEdgeOrder"
            ? op.id
            : null;
    if (id && doc.nodes[id] && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Stands in for a node's fingerprint when a plan is compiled only to check it. */
const PLACEHOLDER_FINGERPRINT = `sha256:${"0".repeat(64)}`;

/** What a run plan calls the fields it limits, in the words of the node they come from. */
const PLAN_FIELDS: Readonly<Record<string, MessageKey>> = {
  prompt: "canvas.edits.planFields.prompt",
  negativePrompt: "canvas.edits.planFields.negativePrompt",
  label: "canvas.edits.planFields.label",
  calls: "canvas.edits.planFields.calls",
  values: "canvas.edits.planFields.values",
  inputs: "canvas.edits.planFields.inputs",
};

/** A run plan's limit, said about the node that went past it. */
function planIssue(
  issue:
    | { code: string; path: PropertyKey[]; message: string; maximum?: unknown; origin?: unknown }
    | undefined,
): string {
  if (!issue) return t("canvas.edits.planGeneric");
  const key = [...issue.path].reverse().find((k): k is string => typeof k === "string");
  const known = key ? PLAN_FIELDS[key] : undefined;
  if (issue.code !== "too_big" || typeof issue.maximum !== "number" || !key) return issue.message;
  const field = known ? t(known) : key;
  return issue.origin === "array"
    ? t("canvas.edits.planTooMany", { field, max: issue.maximum })
    : t("canvas.edits.planTooLong", { field, max: issue.maximum });
}
