// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { addRow, enterRow, promptRows, removeRow, setRow } from "../src/canvas/nodes/variations/prompt-rows";

// Prompts mode in the Variations side sheet (design xrC4Q): one field per prompt, an empty one at
// the end to type into, Enter for the next, Backspace in an empty one to remove it.

describe("the prompt list", () => {
  test("every prompt has its row, and an empty one waits at the end while there's room", () => {
    expect(promptRows([])).toEqual([{ value: "", next: true }]);
    expect(promptRows(["a", "b"])).toEqual([
      { value: "a", next: false },
      { value: "b", next: false },
      { value: "", next: true },
    ]);
    // A blank row being typed into is the last one: no second empty row under it.
    expect(promptRows(["a", ""])).toEqual([
      { value: "a", next: false },
      { value: "", next: false },
    ]);
    // At the cap there's no empty row.
    expect(promptRows(["a", "b", "c"], 3).map((r) => r.value)).toEqual(["a", "b", "c"]);
  });

  test("typing in the empty row at the end adds a prompt", () => {
    expect(setRow(["a"], 1, "b")).toEqual(["a", "b"]);
    expect(setRow(["a", "b"], 0, "x")).toEqual(["x", "b"]);
  });

  test("Enter goes to the next row, making one between prompts, never past the cap", () => {
    // From the last prompt: the empty row at the end is next.
    expect(enterRow(["a", "b"], 1)).toEqual({ prompts: ["a", "b"], focus: 2 });
    // Between two prompts: a new empty row after this one.
    expect(enterRow(["a", "b"], 0)).toEqual({ prompts: ["a", "", "b"], focus: 1 });
    // The row after is already empty: just move there.
    expect(enterRow(["a", "", "b"], 0)).toEqual({ prompts: ["a", "", "b"], focus: 1 });
    // Nothing from an empty row, and nothing at the cap.
    expect(enterRow(["a", ""], 1)).toBeNull();
    expect(enterRow(["a", "b"], 1, 2)).toBeNull();
    expect(enterRow(["a", "b"], 0, 2)).toBeNull();
  });

  test("removing a row puts the focus on the one before", () => {
    expect(removeRow(["a", "", "c"], 1)).toEqual({ prompts: ["a", "c"], focus: 0 });
    expect(removeRow(["a", "b"], 0)).toEqual({ prompts: ["b"], focus: 0 });
    expect(removeRow(["a"], 3)).toBeNull();
  });

  test("Add a prompt focuses the empty row at the end", () => {
    expect(addRow(["a", "b"])).toEqual({ prompts: ["a", "b"], focus: 2 });
    expect(addRow(["a", ""])).toEqual({ prompts: ["a", ""], focus: 1 });
    expect(addRow(["a", "b"], 2)).toBeNull();
  });
});
