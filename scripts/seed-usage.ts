import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type JobSource, type NormalizedRequest, newId } from "../packages/core/src/index.ts";
import { createJobSet, type Db, insertUsage, openDb, seedProviders } from "../packages/db/src/index.ts";

// Fills a library with months of made-up but realistic runs, so Settings > Spending has days,
// weeks and months to show while you work on it. Never your real library: it refuses ~/.openfield.
//
//   bun run seed:usage                     # into .openfield/dev-spending, about six months
//   bun run seed:usage --home /tmp/x --days 60 --seed 7
//   OPENFIELD_HOME=.openfield/dev-spending OPENFIELD_FAKE_PROVIDERS=1 bun dev
//
// Running it again replaces what it wrote before and keeps everything else.

const MARK = "seed-usage:";

interface ModelSpec {
  modelId: string;
  /** Share of runs. */
  weight: number;
  /** Resolution → price per image, with how often each is picked. */
  tiers: { tier: string; usd: number; weight: number }[];
}

// Google's per-image prices (packages/providers/src/google/pricing.ts).
const MODELS: ModelSpec[] = [
  {
    modelId: "gemini-3.1-flash-image",
    weight: 5,
    tiers: [
      { tier: "512", usd: 0.045, weight: 1 },
      { tier: "1K", usd: 0.067, weight: 6 },
      { tier: "2K", usd: 0.101, weight: 2 },
      { tier: "4K", usd: 0.151, weight: 1 },
    ],
  },
  {
    modelId: "gemini-3-pro-image",
    weight: 3,
    tiers: [
      { tier: "1K", usd: 0.134, weight: 5 },
      { tier: "2K", usd: 0.134, weight: 3 },
      { tier: "4K", usd: 0.24, weight: 2 },
    ],
  },
  { modelId: "gemini-3.1-flash-lite-image", weight: 2, tiers: [{ tier: "1K", usd: 0.0336, weight: 1 }] },
];

const SOURCES: { source: JobSource; weight: number }[] = [
  { source: "composer", weight: 14 },
  { source: "canvas", weight: 4 },
  { source: "detail_editor", weight: 2 },
  { source: "recreate", weight: 1 },
];

const PROMPTS = [
  "A lighthouse at dusk, film grain",
  "Ceramic bowls on a linen cloth, soft window light",
  "A fox in fresh snow, telephoto",
  "Brutalist stairwell, late afternoon",
  "Citrus still life on marble",
];
const ASPECTS = ["1:1", "3:4", "4:5", "16:9"] as const;

/**
 * The request a run was frozen with, the parts the app reads back: model, prompt, size and
 * resolution. Enough for the feed's placeholders and Spending's size and quality split.
 */
function frozenRequest(r: {
  model: string;
  prompt: string;
  aspect: string;
  resolution: string;
  batch: number;
  source: JobSource;
}): NormalizedRequest {
  return {
    model: r.model,
    op: "generate",
    prompt: r.prompt,
    promptAfterPreset: r.prompt,
    size: { aspect: r.aspect },
    resolution: r.resolution,
    batch: r.batch,
    source: r.source,
    speed: "standard",
  } as unknown as NormalizedRequest;
}

/** A small seeded generator (mulberry32), so a seed always gives the same months. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T extends { weight: number }>(items: readonly T[], r: number): T {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let at = r * total;
  for (const item of items) {
    at -= item.weight;
    if (at < 0) return item;
  }
  return items[items.length - 1]!;
}

export interface SeedOptions {
  /** Days back from `now`, today included. */
  days: number;
  seed: number;
  now: Date;
}

/**
 * Writes the runs: busier lately and midweek, quiet some days, a batch of one to four images each,
 * with the odd failure, cancel after sending and rerun after a restart. Returns how many images.
 */
export function seedUsage(db: Db, opts: SeedOptions): { runs: number; images: number } {
  return db.transaction((tx) => {
    seedProviders(tx, [
      { id: "google", displayName: "Google", adapter: "google", authKind: "api_key", concurrencyCap: 4 },
    ]);
    // Replace this script's earlier rows, keep the rest.
    const mine = `SELECT id FROM job_sets WHERE idempotency_key LIKE '${MARK}%'`;
    db.$client.run(`DELETE FROM usage_log WHERE job_set_id IN (${mine})`);
    db.$client.run(`DELETE FROM jobs WHERE job_set_id IN (${mine})`);
    db.$client.run(`DELETE FROM job_sets WHERE idempotency_key LIKE '${MARK}%'`);
    return write(tx, opts);
  });
}

function write(db: Parameters<Parameters<Db["transaction"]>[0]>[0], opts: SeedOptions) {
  const rand = random(opts.seed);

  let runs = 0;
  let images = 0;
  const midnight = new Date(opts.now);
  midnight.setHours(0, 0, 0, 0);
  for (let back = opts.days - 1; back >= 0; back--) {
    const day = new Date(midnight);
    day.setDate(day.getDate() - back);
    if (rand() < 0.12) continue; // a day off
    const weekday = day.getDay();
    const busy = [0.5, 1, 1.15, 1.25, 1.2, 0.9, 0.6][weekday]!;
    const growth = 0.5 + (1 - back / opts.days) * 1.2;
    const count = Math.round(busy * growth * (2 + rand() * 6));
    for (let n = 0; n < count; n++) {
      const at = new Date(day);
      // Waking hours, 8am to 11pm.
      at.setMinutes(8 * 60 + Math.floor(rand() * 15 * 60), Math.floor(rand() * 60));
      if (at > opts.now) continue;
      const model = pick(MODELS, rand());
      const tier = pick(model.tiers, rand());
      const source = pick(SOURCES, rand()).source;
      const batch = 1 + Math.floor(rand() * rand() * 4);
      const key = `${MARK}${opts.seed}:${at.toISOString()}:${n}`;
      const { jobSet, jobs } = createJobSet(db, {
        jobSet: {
          id: newId(),
          idempotencyKey: key,
          op: source === "detail_editor" ? "edit" : "generate",
          providerId: "google",
          modelId: model.modelId,
          requestJson: frozenRequest({
            model: `google:${model.modelId}`,
            prompt: PROMPTS[Math.floor(rand() * PROMPTS.length)]!,
            aspect: ASPECTS[Math.floor(rand() * ASPECTS.length)]!,
            resolution: tier.tier,
            batch,
            source,
          }),
          source,
          status: "succeeded",
          createdAt: at.toISOString(),
        },
        jobs: Array.from({ length: batch }, (_, idx) => ({ id: newId(), idx, status: "succeeded" as const })),
      });
      runs++;
      for (const job of jobs) {
        const roll = rand();
        const outcome = roll < 0.03 ? "failed" : roll < 0.05 ? "canceled" : "succeeded";
        const ts = new Date(at.getTime() + 8_000 + Math.floor(rand() * 30_000)).toISOString();
        insertUsage(db, {
          ts,
          providerId: "google",
          modelId: model.modelId,
          jobSetId: jobSet.id,
          jobId: job.id,
          batchIndex: job.idx,
          operation: jobSet.op,
          outcome,
          costUsd: outcome === "failed" ? 0 : tier.usd,
          costSource: outcome === "failed" ? "unknown" : "estimated",
          discarded: outcome === "canceled",
          speed: "standard",
          rerun: rand() < 0.01,
        });
        if (outcome === "succeeded") images++;
      }
    }
  }
  return { runs, images };
}

function resolveHome(raw: string): string {
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      home: { type: "string", default: join(import.meta.dir, "..", ".openfield", "dev-spending") },
      days: { type: "string", default: "180" },
      seed: { type: "string", default: "1" },
    },
  });
  const home = resolveHome(values.home);
  if (home === join(homedir(), ".openfield")) {
    console.error("That's your real library. Pick another folder with --home.");
    process.exit(1);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const opened = openDb(join(home, "openfield.db"));
  try {
    const made = seedUsage(opened.db, {
      days: Number(values.days),
      seed: Number(values.seed),
      now: new Date(),
    });
    console.log(`Wrote ${made.runs} runs and ${made.images} images into ${home}.`);
    console.log(`Open it with: OPENFIELD_HOME=${home} OPENFIELD_FAKE_PROVIDERS=1 bun dev`);
  } finally {
    opened.close();
  }
}
