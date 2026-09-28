import { nodeTitle, specRegistry } from "@openfield/canvas";
import { canonicalJson, type MessageKey, t } from "@openfield/core";
import type { CanvasDocument, CanvasNode } from "@openfield/core/canvas";

// What changed on a canvas since an agent last had it, in a line it can read at a glance: "2 nodes
// resized, the view moved, Key visual renamed". Edits apply to the canvas as it is now, so this is
// how an agent hears about what the person (or another agent) did in between.

/** Two names are said, more are counted. */
const NAMED_MAX = 2;

export function changesSince(before: CanvasDocument, after: CanvasDocument): string | null {
  const was = new Map(before.nodes.map((n) => [n.id, n]));
  const now = new Map(after.nodes.map((n) => [n.id, n]));
  const whereWas = positions(before);
  const whereNow = positions(after);
  const lists: Record<string, CanvasNode[]> = {
    added: [],
    removed: [],
    renamed: [],
    settings: [],
    moved: [],
    resized: [],
    images: [],
    locked: [],
    unlocked: [],
  };
  for (const node of after.nodes) {
    const old = was.get(node.id);
    if (!old) {
      lists.added!.push(node);
      continue;
    }
    if (old.title !== node.title) lists.renamed!.push(node);
    if (canonicalJson(old.params) !== canonicalJson(node.params)) lists.settings!.push(node);
    const a = whereWas.get(node.id)!;
    const b = whereNow.get(node.id)!;
    if (a.x !== b.x || a.y !== b.y || old.parentId !== node.parentId) lists.moved!.push(node);
    if (canonicalJson(old.size ?? null) !== canonicalJson(node.size ?? null)) lists.resized!.push(node);
    if (canonicalJson(old.result?.assetIds ?? []) !== canonicalJson(node.result?.assetIds ?? []))
      lists.images!.push(node);
    if (!old.locked && node.locked) lists.locked!.push(node);
    if (old.locked && !node.locked) lists.unlocked!.push(node);
  }
  for (const node of before.nodes) if (!now.has(node.id)) lists.removed!.push(node);

  const parts: string[] = [];
  for (const [kind, nodes] of Object.entries(lists)) {
    if (nodes.length) parts.push(t(`canvas.agents.since.${kind}` as MessageKey, { nodes: named(nodes) }));
  }
  const edgeKey = (e: CanvasDocument["edges"][number]) =>
    `${e.source}.${e.sourceHandle}>${e.target}.${e.targetHandle}`;
  const edgesWere = new Set(before.edges.map(edgeKey));
  const edgesNow = new Set(after.edges.map(edgeKey));
  const linked = after.edges.filter((e) => !edgesWere.has(edgeKey(e))).length;
  const unlinked = before.edges.filter((e) => !edgesNow.has(edgeKey(e))).length;
  if (linked) parts.push(t("canvas.agents.since.linked", { count: linked }));
  if (unlinked) parts.push(t("canvas.agents.since.unlinked", { count: unlinked }));
  if (before.name !== after.name) parts.push(t("canvas.agents.since.canvasRenamed", { name: after.name }));
  if (canonicalJson(before.viewport) !== canonicalJson(after.viewport))
    parts.push(t("canvas.agents.since.view"));
  return parts.length ? t("canvas.agents.since.lead", { changes: parts.join(", ") }) : null;
}

function named(nodes: readonly CanvasNode[]): string {
  if (nodes.length > NAMED_MAX) return t("canvas.agents.since.nodes", { count: nodes.length });
  const names = nodes.map((n) => nodeTitle(n, specRegistry));
  return names.length === 2 ? t("canvas.agents.since.pair", { a: names[0]!, b: names[1]! }) : names[0]!;
}

/** Where each node sits on the pane: its own position plus its frames'. */
function positions(doc: CanvasDocument): Map<string, { x: number; y: number }> {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const out = new Map<string, { x: number; y: number }>();
  const at = (id: string, depth = 0): { x: number; y: number } => {
    const known = out.get(id);
    if (known) return known;
    const node = byId.get(id)!;
    const parent =
      node.parentId && byId.has(node.parentId) && depth < 64 ? at(node.parentId, depth + 1) : null;
    const point = { x: node.position.x + (parent?.x ?? 0), y: node.position.y + (parent?.y ?? 0) };
    out.set(id, point);
    return point;
  };
  for (const node of doc.nodes) at(node.id);
  return out;
}
