import type { UsageFigures, UsageSeriesGroup, UsageSeriesResponse } from "@openfield/core";

// Settings > Spending's series (§6.9): the seven biggest groups each get a colour and the rest
// fold into Other. A group keeps its colour for good, remembered on this computer, so hiding one
// or changing the dates never repaints the others.

/** Seven hues, then Other's gray. */
export const SLOTS = 7;
export const OTHER = "__other";

export type Metric = "spend" | "images";

export interface SeriesView {
  /** A group key, or OTHER. */
  key: string;
  /** The groups inside it: one, or several for Other. */
  groups: UsageSeriesGroup[];
  /** 0 to 6, or -1 for Other. */
  slot: number;
  hidden: boolean;
  figures: UsageFigures;
  /** Per bucket, in bucket order. */
  usd: number[];
  images: number[];
}

export const seriesColor = (slot: number) =>
  slot < 0 ? "var(--of-chart-other)" : `var(--of-chart-${slot + 1})`;

/**
 * Colours for the groups on show, most spent first. A group keeps the colour it had last time
 * when that colour is free; a new one takes the first free colour. Returns the updated memory.
 */
export function assignSlots(
  keys: readonly string[],
  saved: Readonly<Record<string, number>>,
): { slots: Map<string, number>; saved: Record<string, number> } {
  const slots = new Map<string, number>();
  const taken = new Set<number>();
  for (const key of keys) {
    const slot = saved[key];
    if (slot !== undefined && slot < SLOTS && !taken.has(slot)) {
      slots.set(key, slot);
      taken.add(slot);
    }
  }
  const next = { ...saved };
  for (const key of keys) {
    if (slots.has(key)) continue;
    let free = 0;
    while (taken.has(free)) free++;
    slots.set(key, free);
    taken.add(free);
    next[key] = free;
  }
  return { slots, saved: next };
}

const zero = (): UsageFigures => ({ runs: 0, images: 0, usd: 0, usdDiscarded: 0, canceled: 0, reruns: 0 });

export function addFigures(into: UsageFigures, more: UsageFigures): UsageFigures {
  return {
    runs: into.runs + more.runs,
    images: into.images + more.images,
    usd: Math.round((into.usd + more.usd) * 1e6) / 1e6,
    usdDiscarded: Math.round((into.usdDiscarded + more.usdDiscarded) * 1e6) / 1e6,
    canceled: into.canceled + more.canceled,
    reruns: into.reruns + more.reruns,
  };
}

const figuresOf = ({ runs, images, usd, usdDiscarded, canceled, reruns }: UsageFigures): UsageFigures => ({
  runs,
  images,
  usd,
  usdDiscarded,
  canceled,
  reruns,
});

export interface SpendingView {
  series: SeriesView[];
  /** Every visible series added up: what the tiles and the table's Total show. */
  visible: UsageFigures;
  /** The colour memory after this render, when it changed. */
  saved: Record<string, number> | null;
}

export function buildView(
  data: UsageSeriesResponse,
  opts: { hidden: readonly string[]; saved: Readonly<Record<string, number>> },
): SpendingView {
  const own = data.groups.length > SLOTS ? data.groups.slice(0, SLOTS) : data.groups;
  const rest = data.groups.length > SLOTS ? data.groups.slice(SLOTS) : [];
  const { slots, saved } = assignSlots(
    own.map((g) => g.key),
    opts.saved,
  );
  const hidden = new Set(opts.hidden);

  const perBucket = (keys: readonly string[], field: "usd" | "images") =>
    data.buckets.map((b) => {
      let sum = 0;
      for (const key of keys) sum += b.groups[key]?.[field] ?? 0;
      return field === "usd" ? Math.round(sum * 1e6) / 1e6 : sum;
    });

  const series: SeriesView[] = own.map((group) => ({
    key: group.key,
    groups: [group],
    slot: slots.get(group.key)!,
    hidden: hidden.has(group.key),
    figures: figuresOf(group),
    usd: perBucket([group.key], "usd"),
    images: perBucket([group.key], "images"),
  }));
  if (rest.length) {
    const keys = rest.map((g) => g.key);
    series.push({
      key: OTHER,
      groups: rest,
      slot: -1,
      hidden: hidden.has(OTHER),
      figures: rest.reduce<UsageFigures>((sum, g) => addFigures(sum, figuresOf(g)), zero()),
      usd: perBucket(keys, "usd"),
      images: perBucket(keys, "images"),
    });
  }

  const visible = series.filter((s) => !s.hidden).reduce((sum, s) => addFigures(sum, s.figures), zero());
  const changed = Object.entries(saved).some(([key, slot]) => opts.saved[key] !== slot);
  return { series, visible, saved: changed ? saved : null };
}

/** A series' values for the metric on show. */
export const valuesOf = (s: SeriesView, metric: Metric) => (metric === "spend" ? s.usd : s.images);
