import { LIST_MAX } from "@openfield/canvas/nodes/variations/spec";

// Prompts mode's list in the side sheet (design xrC4Q): one field per prompt. The rows are the
// node's `prompts` as typed, blank ones kept while editing, plus one empty row at the end ready to
// type in (design TUgzX) while there's room. Pure, so the keyboard rules are tested on their own:
// Enter adds the next row, Backspace in an empty row removes it.

export interface PromptRow {
  value: string;
  /** The empty row at the end: typing in it adds a prompt. */
  next: boolean;
}

/** The rows to show. */
export function promptRows(prompts: readonly string[], max = LIST_MAX): PromptRow[] {
  const rows = prompts.slice(0, max).map((value) => ({ value, next: false }));
  const last = prompts[prompts.length - 1];
  if (prompts.length < max && (last === undefined || last.trim() !== ""))
    rows.push({ value: "", next: true });
  return rows;
}

/** Typed into row `index`; the empty row at the end becomes a prompt. */
export function setRow(prompts: readonly string[], index: number, value: string): string[] {
  const next = [...prompts];
  if (index >= next.length) next.push(value);
  else next[index] = value;
  return next;
}

/** What a key does to the list, and which row gets the focus after. */
export interface RowChange {
  prompts: string[];
  focus: number;
}

/**
 * Enter in row `index`: an empty row after it, focused. Where the row after is already empty, it
 * just moves there. Nothing past the cap, and nothing from an empty row at the end.
 */
export function enterRow(prompts: readonly string[], index: number, max = LIST_MAX): RowChange | null {
  const value = prompts[index];
  if (value === undefined || value.trim() === "") return null;
  const after = prompts[index + 1];
  // The last prompt: the empty row at the end is next, while there's room for it.
  if (after === undefined) return prompts.length < max ? { prompts: [...prompts], focus: index + 1 } : null;
  if (after.trim() === "") return { prompts: [...prompts], focus: index + 1 };
  if (prompts.length >= max) return null;
  const next = [...prompts];
  next.splice(index + 1, 0, "");
  return { prompts: next, focus: index + 1 };
}

/** Removes row `index` (its ×, or Backspace in it while empty); the focus goes to the row before. */
export function removeRow(prompts: readonly string[], index: number): RowChange | null {
  if (index < 0 || index >= prompts.length) return null;
  const next = prompts.filter((_, i) => i !== index);
  return { prompts: next, focus: Math.max(0, index - 1) };
}

/** "Add a prompt": focus the empty row at the end, adding one when the last row has words. */
export function addRow(prompts: readonly string[], max = LIST_MAX): RowChange | null {
  const last = prompts[prompts.length - 1];
  if (last !== undefined && last.trim() === "") return { prompts: [...prompts], focus: prompts.length - 1 };
  if (prompts.length >= max) return null;
  // The empty row at the end already stands for it: focus that, nothing to store yet.
  return { prompts: [...prompts], focus: prompts.length };
}
