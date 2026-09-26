// The spending chart's geometry, kept apart from React so it can be tested (§6.9). Numbers match
// design.pen's Plot frame: 258 tall, grid from x 48, points from x 52 to 8 short of the right edge,
// the baseline at 232 and the top line at 8.

export const PLOT = {
  height: 258,
  top: 8,
  base: 232,
  gridLeft: 48,
  left: 52,
  rightInset: 8,
  labelY: 242,
  barWidth: 24,
  barGap: 2,
  barRadius: 4,
} as const;

export interface Scale {
  max: number;
  ticks: number[];
}

/**
 * Round ticks from 0 to just past `value`, about five of them: 0, 0.25, 0.50… or 0, 5, 10…
 * `whole` keeps every tick a whole number, for image counts.
 */
export function niceScale(value: number, whole = false): Scale {
  const target = value > 0 ? value : whole ? 4 : 1;
  const raw = target / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw && (!whole || Number.isInteger(s))) ??
    Math.max(1, Math.ceil(raw));
  const max = Math.ceil(target / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max, ticks };
}

export type Point = readonly [number, number];

/**
 * A smooth line through points that never overshoots them (Fritsch–Carlson monotone cubic, like
 * d3.curveMonotoneX), so a day with nothing stays on the baseline instead of dipping below it.
 * Returns the segments after the first point: prefix with M or L.
 */
export function monotoneSegments(points: readonly Point[]): string {
  const n = points.length;
  if (n < 2) return "";
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1]![0] - points[i]![0];
    slope[i] = (points[i + 1]![1] - points[i]![1]) / dx[i]!;
  }
  const tangent: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    tangent[i] =
      a * b <= 0
        ? 0
        : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b);
  }
  tangent[n - 1] = slope[n - 2]!;
  const f = (v: number) => Math.round(v * 10) / 10;
  let d = "";
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const h = dx[i]! / 3;
    d += ` C${f(x0 + h)},${f(y0 + tangent[i]! * h)} ${f(x1 - h)},${f(y1 - tangent[i + 1]! * h)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

export function linePath(points: readonly Point[]): string {
  if (!points.length) return "";
  const [x, y] = points[0]!;
  return `M${x},${y}${monotoneSegments(points)}`;
}

/** The band between a series' top line and the one below it, closed back along the lower line. */
export function bandPath(upper: readonly Point[], lower: readonly Point[]): string {
  if (!upper.length) return "";
  const back = [...lower].reverse();
  const [lx, ly] = back[0]!;
  return `${linePath(upper)} L${lx},${ly}${monotoneSegments(back)} Z`;
}

/** Running totals, bottom series first: `stacked[s][i]` is the top of series s at bucket i. */
export function stack(values: readonly (readonly number[])[]): number[][] {
  const out: number[][] = [];
  let below = values[0]?.map(() => 0) ?? [];
  for (const series of values) {
    const top = series.map((v, i) => below[i]! + v);
    out.push(top);
    below = top;
  }
  return out;
}

/** Where each bucket sits across the plot. One bucket sits in the middle. */
export function bucketXs(count: number, width: number): number[] {
  const left: number = PLOT.left;
  const right = width - PLOT.rightInset;
  if (count <= 1) return [(left + right) / 2];
  return Array.from({ length: count }, (_, i) => left + (i * (right - left)) / (count - 1));
}

/** Bars get a slot each; a bar is at most 24 wide and never more than 60% of its slot. */
export function barLayout(count: number, width: number): { centers: number[]; slot: number; bar: number } {
  const left: number = PLOT.left;
  const right = width - PLOT.rightInset;
  const slot = (right - left) / Math.max(count, 1);
  return {
    centers: Array.from({ length: count }, (_, i) => left + slot * (i + 0.5)),
    slot,
    bar: Math.max(2, Math.min(PLOT.barWidth, slot * 0.6)),
  };
}

/**
 * Which buckets get an x label: every `every`-th one, and on a line chart the last one too, so the
 * axis always says where it ends. A label too close to that last one gives way to it.
 */
export function axisIndices(count: number, every: number, keepLast: boolean): number[] {
  const step = Math.max(1, every);
  const out: number[] = [];
  for (let i = 0; i < count; i += step) out.push(i);
  const last = count - 1;
  if (keepLast && last > 0 && out.at(-1) !== last) {
    if (last - out.at(-1)! < Math.ceil(step * 0.6)) out.pop();
    out.push(last);
  }
  return out;
}

/** The bucket nearest a pointer's x. */
export function nearestIndex(x: number, centers: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < centers.length; i++) {
    if (Math.abs(centers[i]! - x) < Math.abs(centers[best]! - x)) best = i;
  }
  return best;
}

/**
 * Whole percentages that add up to exactly 100 (largest remainder), so a table's Share column
 * never totals 99% or 101%.
 */
export function shares(values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - floors[i]!, i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i]!++;
    left--;
  }
  return floors;
}

/**
 * A guess at the month's end from the daily average so far: spent ÷ days gone × days in the month.
 * Null on the 1st, when one day says too little.
 */
export function monthProjection(spent: number, today: string): { amount: number; lastDay: string } | null {
  const day = Number(today.slice(8, 10));
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDay = `${today.slice(0, 8)}${String(length).padStart(2, "0")}`;
  if (day < 2 || spent <= 0) return null;
  return { amount: (spent / day) * length, lastDay };
}
