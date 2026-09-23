// Justified rows (§2.3): fill a row at the zoom step's height until it's wide enough, then scale
// the row so it spans the container exactly. Pure, so the layout is tested without a browser.

export interface SolvedTile<T> {
  item: T;
  width: number;
}

export interface SolvedRow<T> {
  height: number;
  tiles: SolvedTile<T>[];
}

export function solveRows<T>(
  items: readonly T[],
  ratioOf: (item: T) => number,
  width: number,
  target: number,
  gap = 2,
): SolvedRow<T>[] {
  if (width <= 0 || target <= 0) return [];
  const max = target * 1.35;
  const rows: SolvedRow<T>[] = [];
  let row: { item: T; ratio: number }[] = [];
  let sum = 0;

  const close = (height: number, fill: boolean) => {
    const widths = row.map(({ ratio }) => Math.max(1, Math.round(height * ratio)));
    if (fill) {
      // Hand the rounding remainder to the widest tiles, a pixel each, so the row is exact.
      let rest = width - gap * (row.length - 1) - widths.reduce((a, b) => a + b, 0);
      const order = widths.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0]);
      for (let k = 0; rest !== 0; k = (k + 1) % order.length) {
        const step = Math.sign(rest);
        widths[order[k]![1]]! += step;
        rest -= step;
      }
    }
    rows.push({ height: Math.round(height), tiles: row.map(({ item }, i) => ({ item, width: widths[i]! })) });
    row = [];
    sum = 0;
  };

  const heightFor = (count: number, ratios: number) => (width - gap * (count - 1)) / ratios;
  const fill = (solved: number) => {
    // A row too sparse to fill within the clamp keeps the clamp and sits left-aligned. A row that
    // is too wide always shrinks to fit: nothing may overflow the page.
    const height = Math.min(max, solved);
    close(height, height === solved);
  };

  for (const item of items) {
    const raw = ratioOf(item);
    const ratio = raw > 0 && Number.isFinite(raw) ? raw : 1;
    if ((sum + ratio) * target + gap * row.length < width) {
      row.push({ item, ratio });
      sum += ratio;
      continue;
    }
    // This image overflows the row: end the row with it or without it, whichever lands
    // nearer the target height.
    const withIt = heightFor(row.length + 1, sum + ratio);
    const without = row.length ? heightFor(row.length, sum) : Number.POSITIVE_INFINITY;
    if (Math.abs(without - target) < Math.abs(withIt - target)) {
      fill(without);
      row.push({ item, ratio });
      sum = ratio;
    } else {
      row.push({ item, ratio });
      sum += ratio;
      fill(withIt);
    }
  }
  // The last partial row keeps the target height and is never stretched, only shrunk to fit.
  if (row.length) {
    const natural = sum * target + gap * (row.length - 1);
    if (natural > width) fill(heightFor(row.length, sum));
    else close(target, false);
  }
  return rows;
}
