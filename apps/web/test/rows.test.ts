// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { solveRows } from "../src/image/rows";

const ratio = (r: number) => r;
const rowWidth = (tiles: { width: number }[], gap = 2) =>
  tiles.reduce((sum, t) => sum + t.width, 0) + gap * (tiles.length - 1);

describe("solveRows", () => {
  test("a row of four 3:4 and 4:5 images fills 1424px at about 456 tall (AC-2.3.1)", () => {
    const [row] = solveRows([0.75, 0.8, 0.75, 0.8, 0.75], ratio, 1424, 456);
    expect(row!.tiles).toHaveLength(4);
    expect(rowWidth(row!.tiles)).toBe(1424);
    expect(Math.abs(row!.height - 456)).toBeLessThanOrEqual(2);
  });

  test("every full row matches the container width exactly", () => {
    const rows = solveRows([1.78, 0.75, 1, 0.8, 1.5, 0.66, 1.33, 0.75, 0.75], ratio, 1437, 360);
    for (const row of rows.slice(0, -1)) expect(rowWidth(row.tiles)).toBe(1437);
  });

  test("the last partial row keeps the target height and isn't stretched", () => {
    const rows = solveRows([0.75, 0.75, 0.75, 0.75, 0.75], ratio, 1440, 456);
    const last = rows.at(-1)!;
    expect(last.height).toBe(456);
    expect(rowWidth(last.tiles)).toBeLessThan(1440);
  });

  test("a lone panorama shrinks to fit instead of overflowing", () => {
    const [row] = solveRows([8], ratio, 1440, 456);
    expect(row!.height).toBe(180);
    expect(rowWidth(row!.tiles)).toBe(1440);
  });

  test("no width, no rows", () => {
    expect(solveRows([1, 1], ratio, 0, 456)).toEqual([]);
  });
});
