import { type MessageKey, t } from "@openfield/core";

// The canvas keyboard map (§7.9, design l9YSIT). One table drives both the key handler and the
// shortcuts sheet, so what the sheet says is what the keys do.

export type ShortcutId =
  | "tool.select"
  | "tool.pan"
  | "tool.note"
  | "tool.shape"
  | "tool.text"
  | "tool.frame"
  | "find"
  | "add"
  | "run.node"
  | "run.downstream"
  | "run.all"
  | "zoom.fit"
  | "zoom.selection"
  | "zoom.reset"
  | "zoom.in"
  | "zoom.out"
  | "undo"
  | "redo"
  | "duplicate"
  | "selectAll"
  | "group"
  | "ungroup"
  | "delete"
  | "escape"
  | "save"
  | "saveVersion"
  | "help"
  | "edit"
  | "focus.next"
  | "focus.prev"
  | "port.next"
  | "port.prev"
  | "nudge.left"
  | "nudge.right"
  | "nudge.up"
  | "nudge.down";

export interface Chord {
  /** KeyboardEvent.key, lower case for letters. */
  key?: string;
  /** KeyboardEvent.code, for keys whose `key` changes with Shift (⇧1). */
  code?: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface Shortcut {
  id: ShortcutId;
  chords: readonly Chord[];
  /** Also fires while typing in a node's text field. */
  inText?: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "tool.select", chords: [{ key: "v" }] },
  { id: "tool.pan", chords: [{ key: "h" }] },
  { id: "tool.note", chords: [{ key: "n" }] },
  { id: "tool.shape", chords: [{ key: "r" }] },
  { id: "tool.text", chords: [{ key: "t" }] },
  { id: "tool.frame", chords: [{ key: "f" }] },
  { id: "find", chords: [{ key: "f", mod: true }], inText: true },
  { id: "add", chords: [{ key: "a" }] },
  { id: "run.node", chords: [{ key: "enter", mod: true }], inText: true },
  // With ⌥ it makes new images for everything below too (§7.7).
  {
    id: "run.downstream",
    chords: [
      { key: "enter", mod: true, shift: true },
      { key: "enter", mod: true, shift: true, alt: true },
    ],
    inText: true,
  },
  { id: "run.all", chords: [{ key: "enter", mod: true, alt: true }], inText: true },
  { id: "zoom.fit", chords: [{ code: "Digit1", shift: true }] },
  { id: "zoom.selection", chords: [{ code: "Digit2", shift: true }] },
  { id: "zoom.reset", chords: [{ key: "0", mod: true }], inText: true },
  {
    id: "zoom.in",
    chords: [
      { key: "=", mod: true },
      { key: "+", mod: true },
      { key: "+", mod: true, shift: true },
    ],
    inText: true,
  },
  { id: "zoom.out", chords: [{ key: "-", mod: true }], inText: true },
  { id: "undo", chords: [{ key: "z", mod: true }] },
  {
    id: "redo",
    chords: [
      { key: "z", mod: true, shift: true },
      { key: "y", mod: true },
    ],
  },
  { id: "duplicate", chords: [{ key: "d", mod: true }] },
  { id: "selectAll", chords: [{ key: "a", mod: true }] },
  { id: "group", chords: [{ key: "g", mod: true }] },
  { id: "ungroup", chords: [{ key: "g", mod: true, shift: true }] },
  { id: "delete", chords: [{ key: "backspace" }, { key: "delete" }] },
  { id: "escape", chords: [{ key: "escape" }], inText: true },
  { id: "save", chords: [{ key: "s", mod: true }], inText: true },
  { id: "saveVersion", chords: [{ key: "s", mod: true, shift: true }], inText: true },
  { id: "help", chords: [{ key: "?", shift: true }, { key: "?" }] },
  { id: "edit", chords: [{ key: "enter" }] },
  // Keyboard access (§2.11): Tab walks the nodes in run order, ⌥↑/↓ the ports of the focused one.
  { id: "focus.next", chords: [{ key: "tab" }] },
  { id: "focus.prev", chords: [{ key: "tab", shift: true }] },
  { id: "port.next", chords: [{ key: "arrowdown", alt: true }] },
  { id: "port.prev", chords: [{ key: "arrowup", alt: true }] },
  { id: "nudge.left", chords: [{ key: "arrowleft" }, { key: "arrowleft", shift: true }] },
  { id: "nudge.right", chords: [{ key: "arrowright" }, { key: "arrowright", shift: true }] },
  { id: "nudge.up", chords: [{ key: "arrowup" }, { key: "arrowup", shift: true }] },
  { id: "nudge.down", chords: [{ key: "arrowdown" }, { key: "arrowdown", shift: true }] },
];

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export const isMac = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function matches(chord: Chord, e: KeyLike, mac: boolean): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  // The other platform's modifier never counts as a plain key press.
  const stray = mac ? e.ctrlKey : e.metaKey;
  if (stray) return false;
  if (!!chord.mod !== mod || !!chord.shift !== e.shiftKey || !!chord.alt !== e.altKey) return false;
  if (chord.code) return e.code === chord.code;
  // ⌥ changes e.key on a Mac (⌥⌘⏎ still reports Enter, but ⌥F reports ƒ).
  return !!chord.key && e.key.toLowerCase() === chord.key;
}

export function matchShortcut(e: KeyLike, mac = isMac(), inText = false): ShortcutId | null {
  for (const shortcut of SHORTCUTS) {
    if (inText && !shortcut.inText) continue;
    if (shortcut.chords.some((chord) => matches(chord, e, mac))) return shortcut.id;
  }
  return null;
}

// The sheet (l9YSIT): three columns, keycaps as the design writes them.

export interface SheetRow {
  label: MessageKey;
  keys: string;
}

export interface SheetGroup {
  title: MessageKey;
  rows: SheetRow[];
}

export function shortcutSheet(mac = isMac()): SheetGroup[][] {
  const cmd = mac ? "⌘" : "Ctrl+";
  const shift = mac ? "⇧" : "Shift+";
  const alt = mac ? "⌥" : "Alt+";
  const k = (key: MessageKey) => key;
  const enter = t("canvas.editor.shortcuts.enter");
  const cmdEnter = mac ? `⌘ ${enter}` : `Ctrl+${enter}`;
  return [
    [
      {
        title: k("canvas.editor.shortcuts.tools"),
        rows: [
          { label: "canvas.editor.shortcuts.select", keys: "V" },
          { label: "canvas.editor.shortcuts.pan", keys: "H" },
          { label: "canvas.editor.shortcuts.holdToPan", keys: t("canvas.editor.shortcuts.space") },
          { label: "canvas.editor.shortcuts.note", keys: "N" },
          { label: "canvas.editor.shortcuts.shape", keys: "R" },
          { label: "canvas.editor.shortcuts.text", keys: "T" },
          { label: "canvas.editor.shortcuts.frame", keys: "F" },
          { label: "canvas.editor.shortcuts.find", keys: `${cmd}F` },
          { label: "canvas.editor.shortcuts.add", keys: "A" },
        ],
      },
    ],
    [
      {
        title: k("canvas.editor.shortcuts.run"),
        rows: [
          { label: "canvas.editor.shortcuts.runSelected", keys: cmdEnter },
          { label: "canvas.editor.shortcuts.runFromHere", keys: `${shift}${cmdEnter}` },
          { label: "canvas.editor.shortcuts.runAll", keys: `${alt}${cmdEnter}` },
        ],
      },
      {
        title: k("canvas.editor.shortcuts.view"),
        rows: [
          { label: "canvas.editor.shortcuts.zoomToFit", keys: `${shift}1` },
          { label: "canvas.editor.shortcuts.zoomToSelection", keys: `${shift}2` },
          { label: "canvas.editor.shortcuts.actualSize", keys: `${cmd}0` },
          { label: "canvas.editor.shortcuts.zoomIn", keys: `${cmd}+` },
          { label: "canvas.editor.shortcuts.zoomOut", keys: `${cmd}-` },
        ],
      },
    ],
    [
      {
        title: k("canvas.editor.shortcuts.edit"),
        rows: [
          { label: "canvas.editor.shortcuts.undo", keys: `${cmd}Z` },
          { label: "canvas.editor.shortcuts.redo", keys: `${shift}${cmd}Z` },
          { label: "canvas.editor.shortcuts.copy", keys: `${cmd}C` },
          { label: "canvas.editor.shortcuts.cut", keys: `${cmd}X` },
          { label: "canvas.editor.shortcuts.paste", keys: `${cmd}V` },
          { label: "canvas.editor.shortcuts.duplicate", keys: `${cmd}D` },
          { label: "canvas.editor.shortcuts.selectAll", keys: `${cmd}A` },
          { label: "canvas.editor.shortcuts.group", keys: `${cmd}G` },
          { label: "canvas.editor.shortcuts.ungroup", keys: `${shift}${cmd}G` },
          { label: "canvas.editor.shortcuts.delete", keys: "⌫" },
          { label: "canvas.editor.shortcuts.nodeMenu", keys: `${shift}F10` },
          { label: "canvas.editor.shortcuts.nodeSettings", keys: mac ? `${alt} ${enter}` : `${alt}${enter}` },
          { label: "canvas.editor.shortcuts.clearSelection", keys: t("canvas.editor.shortcuts.esc") },
          { label: "canvas.editor.shortcuts.save", keys: `${cmd}S` },
          { label: "canvas.editor.shortcuts.saveVersion", keys: `${shift}${cmd}S` },
        ],
      },
    ],
  ];
}

/** Keycap text for a tool's tooltip or a menu item, in this platform's keys. */
export function toolKey(id: ShortcutId, mac = isMac()): string | undefined {
  const cmd = mac ? "⌘" : "Ctrl+";
  const enter = t("canvas.editor.shortcuts.enter");
  const map: Partial<Record<ShortcutId, string>> = {
    "run.node": mac ? `⌘ ${enter}` : `Ctrl+${enter}`,
    "tool.select": "V",
    "tool.pan": "H",
    "tool.note": "N",
    "tool.shape": "R",
    "tool.text": "T",
    "tool.frame": "F",
    find: `${cmd}F`,
    add: "A",
    "zoom.fit": mac ? "⇧1" : "Shift+1",
    "zoom.selection": mac ? "⇧2" : "Shift+2",
    duplicate: `${cmd}D`,
    group: `${cmd}G`,
    delete: "⌫",
  };
  return map[id];
}

/** The ⌥ key by its name on this platform, for copy like "Hold ⌥ and click". */
export const altKeyName = (mac = isMac()): string => (mac ? "⌥" : "Alt");
