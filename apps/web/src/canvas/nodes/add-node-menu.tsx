import { t } from "@openfield/core";
import { cn, SearchInput, surfaceVariants } from "@openfield/ui";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { checkConnection } from "../engine/connect";
import { useCanvasEngineContext } from "../engine/engine-store";
import { useCanvasStoreApi, useUi } from "../store/context";
import { newEdgeId } from "../store/graph";
import { applyOps, type CanvasOp, type Size } from "../store/ops";
import type { AddMenuState } from "../store/types";
import { markOpenPicker, OPENS_AT_ONCE } from "./picker-intent";
import { type MenuGroup, type NodeDefinition, nodeRegistry } from "./registry";
import { nodeWrapper } from "./shell/focus";
import { railLayout } from "./shell/ports";
import { VARIATIONS_BOX } from "./variations/spec";

// Canvas / Add node menu (design CnYWZ, 320 wide): search, then References, Image and Utilities.
// Opened at a point (double-click, A, the + tool) it adds the node there. Opened by dropping a
// connection on empty pane (design t5qM2) it lists what connects first, and places the new node so
// its fitting port lands on the drop point, with the edge, in one undo entry (§7.6).

const WIDTH = 320;
const MARGIN = 12;

const GROUP_LABEL: Record<MenuGroup | "connects" | "other", () => string> = {
  references: () => t("canvas.nodes.addMenu.groups.references"),
  image: () => t("canvas.nodes.addMenu.groups.image"),
  utilities: () => t("canvas.nodes.addMenu.groups.utilities"),
  connects: () => t("canvas.nodes.addMenu.connects"),
  other: () => t("canvas.nodes.addMenu.other"),
};

/** The box a node gets before React Flow measures it, for placing its ports on the drop point. */
const boxOf = (def: NodeDefinition): Size =>
  def.size ?? (def.type === "image.variations" ? VARIATIONS_BOX : { w: 0, h: 0 });

/**
 * How well a node type matches what was typed, lower is better, null for no match: its name
 * exactly, then its name's start, a word in its name, anywhere in its name, its description or
 * keywords, and last the letters of its name in order ("gnr" finds Generate).
 */
export function matchScore(def: Pick<NodeDefinition, "label" | "description" | "keywords">, needle: string) {
  const name = t(def.label).toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.split(/\s+/).some((word) => word.startsWith(needle))) return 2;
  if (name.includes(needle)) return 3;
  if ([t(def.description), ...(def.keywords ?? [])].some((s) => s.toLowerCase().includes(needle))) return 4;
  let at = 0;
  for (const ch of name) if (ch === needle[at]) at++;
  return at === needle.length ? 5 : null;
}

export function AddNodeMenu() {
  const menu = useUi((ui) => ui.addMenu);
  return menu ? <AddNodePanel menu={menu} /> : null;
}

function AddNodePanel({ menu }: { menu: AddMenuState }) {
  const store = useCanvasStoreApi();
  const ctx = useCanvasEngineContext();
  const panel = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; top: number }>({
    left: menu.screenPosition.x,
    top: menu.screenPosition.y,
  });
  // Above the toolbar, the panel may not grow past the space there is.
  const maxHeight = menu.above ? `${Math.max(160, menu.screenPosition.y - MARGIN)}px` : undefined;

  // No query: the catalogue's groups. A query: one list, best match first, so ↵ adds what was
  // typed ("Prompt" adds Prompt, not the Generate node that mentions prompts).
  const groups = useMemo(() => {
    const all = nodeRegistry.menu(ctx, menu.pending);
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    const ranked = all
      .flatMap((g, groupIndex) =>
        g.items.map((def, i) => ({ def, score: matchScore(def, needle), groupIndex, i })),
      )
      .filter((m) => m.score !== null)
      .sort((a, b) => a.score! - b.score! || a.groupIndex - b.groupIndex || a.i - b.i)
      .map((m) => m.def);
    return ranked.length ? [{ group: null, items: ranked }] : [];
  }, [ctx, menu.pending, query]);
  const flat = groups.flatMap((g) => g.items);

  // Opened by a key, so focus goes back where it was on Esc, or to the node just added.
  const [returnTo] = useState(() => document.activeElement);
  const closing = useRef<{ kind: "escape" } | { kind: "insert"; id: string } | null>(null);
  useEffect(
    () => () => {
      const how = closing.current;
      if (how?.kind === "escape" && returnTo instanceof HTMLElement && returnTo.isConnected) {
        returnTo.focus({ preventScroll: true });
      } else if (how?.kind === "insert") {
        const id = how.id;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => nodeWrapper(id)?.focus({ preventScroll: true })),
        );
      }
    },
    [returnTo],
  );

  // Keep the whole panel on screen. Opened from the toolbar, it grows up from above it.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const height = el.offsetHeight;
    const { x, y } = menu.screenPosition;
    setPlace({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - WIDTH - MARGIN)),
      top: menu.above
        ? Math.max(MARGIN, y - height)
        : Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)),
    });
  }, [menu.screenPosition, menu.above]);

  // A press anywhere else closes it, the pending connection with it.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) store.getState().actions.closeAddMenu();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [store]);

  const activeType = flat[active]?.type;
  useEffect(() => {
    if (activeType)
      document.getElementById(`of-add-node-${activeType}`)?.scrollIntoView({ block: "nearest" });
  }, [activeType]);

  const insert = (def: NodeDefinition) => {
    const state = store.getState();
    const node = nodeRegistry.instantiate(def.type, { position: menu.flowPosition, ctx });
    const ops: CanvasOp[] = [{ op: "addNode", node }];
    const pending = menu.pending;
    const port = pending ? nodeRegistry.fittingPort(def.type, pending) : undefined;
    if (pending && port) {
      const box = node.size ?? boxOf(def);
      const y = box.h / 2 + (railLayout(def.ports, port.direction).find((p) => p.port === port)?.offset ?? 0);
      node.position =
        port.direction === "in"
          ? { x: menu.flowPosition.x, y: menu.flowPosition.y - y }
          : { x: menu.flowPosition.x - box.w, y: menu.flowPosition.y - y };
      const ends =
        pending.handleType === "source"
          ? { source: pending.nodeId, sourceHandle: pending.handleId, target: node.id, targetHandle: port.id }
          : {
              source: node.id,
              sourceHandle: port.id,
              target: pending.nodeId,
              targetHandle: pending.handleId,
            };
      const check = checkConnection(applyOps(state.doc, ops).doc, ends);
      if (check.ok) {
        if (check.replaces) ops.push({ op: "deleteEdge", id: check.replaces });
        ops.push({ op: "addEdge", edge: { id: newEdgeId(), ...ends, kind: check.kind } });
      }
      // Variations after a Generate starts from that Generate's model.
      const source = state.doc.nodes[pending.nodeId];
      const sourceModel = state.doc.params[pending.nodeId]?.model;
      if (
        def.type === "image.variations" &&
        source?.type === "image.generate" &&
        typeof sourceModel === "string"
      ) {
        node.params = { ...node.params, model: sourceModel };
      }
    }
    const result = state.actions.apply(ops, { label: "add", select: { nodeIds: [node.id], edgeIds: [] } });
    if (result.ok && OPENS_AT_ONCE.has(def.type)) markOpenPicker(node.id);
    // A node that opens its own picker right away takes focus itself.
    if (result.ok && !OPENS_AT_ONCE.has(def.type)) closing.current = { kind: "insert", id: node.id };
    state.actions.closeAddMenu();
    // A node dropped near an edge of the view (or under the top bar) is brought into view once
    // React Flow has measured it.
    if (result.ok) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => store.getState().viewController.revealNode(node.id)),
      );
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closing.current = { kind: "escape" };
      store.getState().actions.closeAddMenu();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!flat.length) return;
      setActive((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const def = flat[active];
      if (def) insert(def);
    }
  };

  let index = -1;
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={t("canvas.nodes.addMenu.label")}
      onKeyDown={onKeyDown}
      className={cn(
        surfaceVariants({ variant: "popover" }),
        "fixed z-50 max-h-[calc(100vh-24px)] w-320 overflow-y-auto data-[state=open]:animate-pop-in",
      )}
      style={{ ...place, ...(maxHeight && { maxHeight }) }}
      data-state="open"
    >
      <SearchInput
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        placeholder={t("canvas.nodes.addMenu.search")}
        aria-label={t("canvas.nodes.addMenu.search")}
        aria-controls="of-add-node-list"
        aria-activedescendant={flat[active] ? `of-add-node-${flat[active]!.type}` : undefined}
      />
      <div
        id="of-add-node-list"
        role="listbox"
        aria-label={t("canvas.nodes.addMenu.label")}
        className="flex flex-col gap-2"
      >
        {groups.length === 0 ? (
          <p className="px-10 py-8 text-small text-text-tertiary">
            {t("canvas.nodes.addMenu.noMatches", { query: query.trim() })}
          </p>
        ) : null}
        {groups.map((group) => (
          <div key={group.group ?? "matches"} className="flex flex-col gap-2">
            {group.group ? (
              <div className="flex h-28 items-center px-10 text-caption font-medium text-text-tertiary">
                {GROUP_LABEL[group.group]()}
              </div>
            ) : null}
            {group.items.map((def) => {
              index++;
              const mine = index;
              const on = mine === active;
              const Icon = def.icon;
              return (
                <button
                  key={def.type}
                  id={`of-add-node-${def.type}`}
                  type="button"
                  role="option"
                  aria-selected={on}
                  tabIndex={-1}
                  onPointerMove={() => setActive(mine)}
                  onClick={() => insert(def)}
                  className={cn(
                    "group flex h-48 w-full cursor-pointer items-center gap-10 rounded-10 px-10 text-left",
                    on && "bg-elevated-2",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-24 shrink-0 items-center justify-center rounded-6 inset-ring inset-ring-border",
                      on ? "bg-elevated" : "bg-elevated-2",
                    )}
                  >
                    <Icon size={14} aria-hidden className="text-text-secondary" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-small font-medium text-text-primary">{t(def.label)}</span>
                    <span className="truncate text-caption text-text-tertiary">{t(def.description)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
