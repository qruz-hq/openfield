import { z } from "zod";
import { LIBRARY_DATE_PRESETS, LIBRARY_VIEWS, type LibraryDatePreset, type LibraryView } from "./constants";
import { formatLocale } from "./i18n/locale";
import { t } from "./i18n/messages";
import { type ModelKey, safeParseModelKey } from "./ids";
import type { Folder } from "./schemas/asset";
import { modelKeySchema, providerIdSchema } from "./schemas/common";

/** The library's own type filter (§0.16): images, videos, or left out for both. Never "audio". */
export type LibraryModality = "image" | "video";
const libraryModalitySchema = z.enum(["image", "video"]);

// The Assets library's shared logic (§2.8): the folder tree the client builds from the flat
// GET /api/folders list, what a library view asks the server for, and date groups. Pure, so the
// web app, the server and the tests all agree on it.

// Folder tree

export interface FolderNode {
  folder: Folder;
  /** 0 at the top level. The sidebar indents 4 + 20 × depth. */
  depth: number;
  parent: FolderNode | null;
  /** Sorted like the sidebar. */
  children: FolderNode[];
  /** Direct subfolders, for "8 images · 2 folders". Images are folder.count. */
  childCount: number;
}

export interface FolderTree {
  roots: FolderNode[];
  byId: ReadonlyMap<string, FolderNode>;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** "Shoot 2" before "Shoot 10", case ignored (§2.8). sortOrder wins when someone set one. */
export function compareFolders(a: Folder, b: Folder): number {
  return a.sortOrder - b.sortOrder || collator.compare(a.name, b.name) || a.id.localeCompare(b.id);
}

/**
 * Builds the tree from the flat list. A folder whose parent isn't in the list sits at the top
 * level, and so does one caught in a loop, so a bad row can never hide folders.
 */
export function buildFolderTree(folders: readonly Folder[]): FolderTree {
  const byId = new Map<string, FolderNode>();
  for (const folder of folders) {
    byId.set(folder.id, { folder, depth: 0, parent: null, children: [], childCount: 0 });
  }
  const roots: FolderNode[] = [];
  for (const node of byId.values()) {
    const parent = node.folder.parentId ? byId.get(node.folder.parentId) : undefined;
    if (parent && !reaches(parent, node, byId)) {
      node.parent = parent;
      parent.children.push(node);
    } else roots.push(node);
  }
  const place = (nodes: FolderNode[], depth: number) => {
    nodes.sort((a, b) => compareFolders(a.folder, b.folder));
    for (const node of nodes) {
      node.depth = depth;
      node.childCount = node.children.length;
      place(node.children, depth + 1);
    }
  };
  place(roots, 0);
  return { roots, byId };
}

/** Whether walking up the parentIds from `from` meets `target`: linking them would make a loop. */
function reaches(from: FolderNode, target: FolderNode, byId: Map<string, FolderNode>): boolean {
  const seen = new Set<string>();
  let id: string | null = from.folder.id;
  while (id && !seen.has(id)) {
    if (id === target.folder.id) return true;
    seen.add(id);
    id = byId.get(id)?.folder.parentId ?? null;
  }
  return false;
}

/** Depth-first, in sidebar order. Children of a collapsed folder are skipped. */
export function visibleFolders(
  tree: FolderTree,
  isExpanded: (id: string) => boolean = () => true,
): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (nodes: readonly FolderNode[]) => {
    for (const node of nodes) {
      out.push(node);
      if (node.children.length > 0 && isExpanded(node.folder.id)) walk(node.children);
    }
  };
  walk(tree.roots);
  return out;
}

/** The folder and its ancestors, top level first: the breadcrumb. Empty for an unknown id. */
export function folderPath(tree: FolderTree, id: string): FolderNode[] {
  const out: FolderNode[] = [];
  for (let node = tree.byId.get(id) ?? null; node; node = node.parent) out.unshift(node);
  return out;
}

/** Every folder inside this one, at any depth, not counting itself. */
export function folderDescendants(node: FolderNode): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (n: FolderNode) => {
    for (const child of n.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/**
 * What moving `folderId` under `targetId` (null: the top level) would do. "inside" is the folder
 * itself or one of its subfolders, which the server refuses; "current" is where it already is.
 */
export function moveTarget(
  tree: FolderTree,
  folderId: string,
  targetId: string | null,
): "allowed" | "current" | "inside" {
  const node = tree.byId.get(folderId);
  if (!node) return "allowed";
  if ((node.parent?.folder.id ?? null) === targetId) return "current";
  if (targetId === null) return "allowed";
  for (let at = tree.byId.get(targetId) ?? null; at; at = at.parent) {
    if (at === node) return "inside";
  }
  return "allowed";
}

/**
 * "Find a folder": the ids to show, which are the folders whose name contains the words, plus
 * their ancestors so each match keeps its place. Null when there's nothing to filter by.
 */
export function matchFolders(tree: FolderTree, query: string): Set<string> | null {
  const needle = query.trim();
  if (!needle) return null;
  const search = new Intl.Collator(undefined, { sensitivity: "base", usage: "search" });
  const contains = (name: string) => {
    for (let i = 0; i + needle.length <= name.length; i++) {
      if (search.compare(name.slice(i, i + needle.length), needle) === 0) return true;
    }
    return false;
  };
  const shown = new Set<string>();
  for (const node of tree.byId.values()) {
    if (!contains(node.folder.name)) continue;
    for (let at: FolderNode | null = node; at && !shown.has(at.folder.id); at = at.parent) {
      shown.add(at.folder.id);
    }
  }
  return shown;
}

// Library views and their queries

/** What a library view shows. Everything but the view rides in the URL (§2.1). */
export interface LibraryQuery {
  view: LibraryView;
  /** The open folder, when view is "folder". */
  folderId?: string;
  /** Search words. */
  q?: string;
  /** `<providerId>:<modelId>` */
  model?: ModelKey;
  /** The Company filter. */
  provider?: string;
  date?: LibraryDatePreset;
  /** The Type filter: images, videos, or left out for both. */
  modality?: LibraryModality;
}

/** A value the URL can't carry is dropped, never an error: a stale link still opens. */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

/** `?q=&model=&provider=&date=&modality=` on the /assets routes (§2.1). */
export const libraryUrlParamsSchema = z.object({
  q: lenient(z.string().trim().min(1).max(500)),
  model: lenient(modelKeySchema),
  provider: lenient(providerIdSchema),
  date: lenient(z.enum(LIBRARY_DATE_PRESETS)),
  modality: lenient(libraryModalitySchema),
});

/** Reads the view's words and filters from the URL. `params` is a URLSearchParams. */
export function parseLibraryUrl(
  view: LibraryView,
  params: { get(name: string): string | null },
  folderId?: string,
): LibraryQuery {
  const read = (key: string) => params.get(key) ?? undefined;
  const parsed = libraryUrlParamsSchema.parse({
    q: read("q"),
    model: read("model"),
    provider: read("provider"),
    date: read("date"),
    modality: read("modality"),
  });
  const query: LibraryQuery = { view };
  if (view === "folder" && folderId) query.folderId = folderId;
  // The Trash has no search or filters (§2.8).
  if (view === "trash") return query;
  if (parsed.q) query.q = parsed.q;
  if (parsed.model) query.model = parsed.model;
  if (parsed.provider) query.provider = parsed.provider;
  if (parsed.date) query.date = parsed.date;
  if (parsed.modality) query.modality = parsed.modality;
  return query;
}

const VIEW_PATHS: Record<Exclude<LibraryView, "folder">, string> = {
  all: "/assets",
  favourites: "/assets/favourites",
  trash: "/assets/trash",
};

/** The route for a view with its words and filters, e.g. "/assets/folder/01K…?q=neon". */
export function libraryHref(query: LibraryQuery): string {
  const path =
    query.view === "folder" && query.folderId
      ? `/assets/folder/${query.folderId}`
      : VIEW_PATHS[query.view === "folder" ? "all" : query.view];
  if (query.view === "trash") return path;
  const params: [string, string | undefined][] = [
    ["q", query.q?.trim()],
    ["model", query.model],
    ["provider", query.provider],
    ["date", query.date],
    ["modality", query.modality],
  ];
  const search = params
    .filter((p): p is [string, string] => Boolean(p[1]))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return search ? `${path}?${search}` : path;
}

/** Whether any filter (not the words) is set, for "Clear all" and the no-results copy. */
export const hasLibraryFilters = (query: LibraryQuery): boolean =>
  Boolean(query.model || query.provider || query.date || query.modality);

/**
 * Where a Date filter starts: midnight in the viewer's time zone. "Last 7 days" is today and the
 * six days before it; "Last 12 months" starts on this date a year ago.
 */
export function libraryDateFrom(preset: LibraryDatePreset, now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  // Built from parts, so a daylight-saving change in between still lands on local midnight.
  const start: Record<LibraryDatePreset, Date> = {
    today: new Date(y, m, d),
    "7d": new Date(y, m, d - 6),
    "30d": new Date(y, m, d - 29),
    "12m": new Date(y - 1, m, d),
  };
  return start[preset].toISOString();
}

/** The GET /api/assets query string for a view. Values are strings, as a URL sends them. */
export interface LibraryListParams {
  folder?: string;
  favourite?: "1";
  trash?: "1";
  q?: string;
  model?: string;
  provider?: string;
  from?: string;
  modality?: LibraryModality;
}

export function libraryListParams(query: LibraryQuery, now: Date = new Date()): LibraryListParams {
  if (query.view === "trash") return { trash: "1" };
  const params: LibraryListParams = {};
  if (query.view === "folder" && query.folderId) params.folder = query.folderId;
  if (query.view === "favourites") params.favourite = "1";
  const q = query.q?.trim();
  if (q) params.q = q;
  const model = query.model ? safeParseModelKey(query.model) : null;
  if (model) {
    params.model = model.modelId;
    params.provider = model.providerId;
  }
  // Both set and different companies: the server finds nothing, which is the honest answer.
  if (query.provider) params.provider = query.provider;
  if (query.date) params.from = libraryDateFrom(query.date, now);
  if (query.modality) params.modality = query.modality;
  return params;
}

export const isLibraryView = (value: string): value is LibraryView =>
  (LIBRARY_VIEWS as readonly string[]).includes(value);

// Date groups

/** "2026-09-24" in the viewer's time zone: the key a card's date group uses. */
export function localDayKey(value: string | Date): string {
  const at = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export interface DayGroup<T> {
  /** localDayKey of every item in it. */
  day: string;
  items: T[];
}

/**
 * Consecutive items that share a local day, in list order. The library groups by created time and
 * the Trash by deletion time; either way the list is already newest first.
 */
export function groupByDay<T>(items: readonly T[], at: (item: T) => string): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const day = localDayKey(at(item));
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

/** "Today", "Yesterday", "September 21", or "September 21, 2025" in an earlier year. */
export function dayHeading(day: string, now: Date = new Date()): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (daysAgo === 0) return t("assets.groups.today");
  if (daysAgo === 1) return t("assets.groups.yesterday");
  return new Intl.DateTimeFormat(formatLocale(), {
    month: "long",
    day: "numeric",
    ...(y === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}
