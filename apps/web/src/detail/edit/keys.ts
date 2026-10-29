import type { MaskTool } from "./session";

// The Edit tab's keys (§4.5, §4.6). On this tab its tool letters win over the detail view's own:
// D picks the brush rather than downloading, so Download moves to ⇧⌘S. The view's other letters
// (F, R, ⇧F) and Delete stay quiet here, so a stray key never favourites, recreates or deletes the
// image being edited. Zoom (+, -, 0) works on both tabs.

export type EditKey =
  | { kind: "tool"; tool: MaskTool }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "download" }
  /** One of the view's own keys, which does nothing on this tab. */
  | { kind: "blocked" };

const TOOL_KEYS: Record<string, MaskTool> = {
  d: "brush",
  e: "eraser",
  a: "lasso",
  m: "rect",
  h: "pan",
};

/** The view's keys that the Edit tab silences besides letters: Delete, and stepping to another image. */
const BLOCKED = new Set(["Delete", "Backspace", "ArrowLeft", "ArrowRight"]);

type KeyInput = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** What a key does on the Edit tab, or null when the view's own handling stands (zoom, Tab, Esc). */
export function editKey(event: KeyInput): EditKey | null {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.altKey) return null;
  if (event.metaKey || event.ctrlKey) {
    if (key === "z") return event.shiftKey ? { kind: "redo" } : { kind: "undo" };
    if (key === "s" && event.shiftKey) return { kind: "download" };
    return null;
  }
  const tool = event.shiftKey ? undefined : TOOL_KEYS[key];
  if (tool) return { kind: "tool", tool };
  // Any other letter, shifted or not: ⇧D mustn't download any more than D does.
  if (/^[a-z]$/.test(key) || BLOCKED.has(key)) return { kind: "blocked" };
  return null;
}

/** The key a tool's tooltip shows. */
export const toolShortcut: Record<MaskTool, string> = {
  pan: "H",
  brush: "D",
  eraser: "E",
  lasso: "A",
  rect: "M",
};
