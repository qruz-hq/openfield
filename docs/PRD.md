# Openfield — Product Requirements Document

> **Status:** Draft v0.1 · **Date:** 2026-09-23 · **License:** MIT · **Owner:** @gui

Openfield is an open-source, local-first, **bring-your-own-key** image generation workspace. It reproduces the workflow of Higgsfield's Image tab and its node Canvas on top of provider APIs the user pays for directly, with every generated file on local disk.

## How to read this document

| § | Section | For |
|---|---|---|
| 0 | [Canonical contracts](#0-canonical-contracts) | **Binding.** The shared vocabulary, types, routes, enums, defaults and codebase layout every other section obeys |
| 1 | [Overview, goals and users](#1-overview-goals-and-users) | Why this exists, who it is for, what is in and out of scope |
| 2 | [App shell, generation feed and library grid](#2-app-shell-generation-feed-and-library-grid) | The main screen: navigation, the feed, the asset library |
| 3 | [The prompt bar and per-model controls](#3-the-prompt-bar-and-per-model-controls) | The composer and capability-driven settings |
| 4 | [Image detail view and the editor](#4-image-detail-view-and-the-editor) | The detail overlay, iteration actions and the edit surface |
| 5 | [Styles, presets, references and characters](#5-styles-presets-references-and-characters) | Our open replacements for the reference product's proprietary style, moodboard, character and colour features |
| 6 | [Provider adapter architecture and BYOK](#6-provider-adapter-architecture-and-byok) | The extensibility core: `Provider` interface, capability manifests, jobs, keys, cost |
| 7 | [Canvas](#7-canvas) | The node graph: catalogue, typed ports, execution engine, persistence |
| 8 | [Data model, local API, queue and delivery plan](#8-data-model-local-api-queue-and-delivery-plan) | Storage, SQLite schema, HTTP API, queue, milestones, parity checklist, risks |
| A | [Consolidated open questions](#appendix-a-consolidated-open-questions) | What is still undecided or unverified, and which task closes it |

**Reading paths.** Building the first vertical slice: §0 → §6 → §8 → §3. Designing a screen: §0.1 → §2 → §3 → §4. Adding a provider: §0.3 → §6.12. Scoping the work: §0.14 → §8's milestones and parity checklist. Setting up the repo: §0.16 → §8.2 → §8.7 M0.

§0 was written last, after three adversarial reviews found the eight sections specifying the same contracts in incompatible ways. It is the reconciliation: where §0 and any other section disagree, §0 wins.

## Locked decisions

These were settled with the product owner before drafting and are treated as constraints throughout.

| Area | Decision |
|---|---|
| Fidelity | Reproduce Higgsfield's Image tab **1:1 in layout, controls, flows and interactions**; ship our own branding, names, icons and copy. Never their marks, assets or marketing text. |
| Form factor | Local web app: `git clone` + `bun`, server bound to `127.0.0.1`, single user, no auth |
| Stack | Bun workspaces monorepo (§0.16): `apps/web` (Vite + React SPA, Tailwind + shadcn/ui, React Flow for the canvas, TanStack Query) and `apps/server` (Hono on Bun), plus `packages/core`, `packages/providers`, `packages/db` and `packages/ui`. The browser calls the server through a Hono RPC typed client, and every route validates with `@hono/zod-validator` against zod schemas shared from `packages/core`. Data lives in SQLite through Drizzle ORM on `bun:sqlite`: the Drizzle schema is the single source of truth, and drizzle-kit migrations apply on boot |
| Storage | SQLite for metadata and lineage; plain image files under `~/.openfield` |
| API keys | Settings UI → `~/.openfield` config at `0600`; env vars override; provider calls server-side only, so keys never reach browser JS |
| Adapters | Built-in TypeScript modules implementing a typed `Provider` interface plus a per-model **capability manifest**; UI adapts per model |
| Launch providers | Google Gemini image (Nano Banana family) and OpenAI GPT Image; Higgsfield adapter only if its public API exposes Soul/presets/characters to a user key |
| v1.1 providers | fal.ai and Replicate (schema-driven), designed for in v1 |
| Modality | Image only in v1; jobs and assets are modality-agnostic so video is additive |
| v1 extras beyond parity | Per-generation cost estimate + usage log; user preset library with JSON import/export |
| Canvas | Fully specified here (§7), built after the image tab ships |
| Viewport | Desktop-first (≥1280px), usable down to tablet width |
| Telemetry | None |

## Sources and how to treat them

1. **Product walkthrough (primary).** A first-hand, measured Playwright walkthrough of Higgsfield captured on 2026-09-23: layout measurements at 1440×900, full control inventories, every option list, observed request payloads and job lifecycle. All parity claims and numbers in this document trace to it.
2. **Provider API research (secondary).** A sourced sweep of the Higgsfield public API, Google Gemini image models, OpenAI GPT Image models, fal.ai and Replicate, plus existing open-source provider abstractions.

> **Treat every provider-specific fact as configuration, not as settled truth.** Model IDs, prices, size and aspect-ratio lists, quality tiers and capability flags in §6 were researched on 2026-09-23, and some rest on third-party write-ups rather than official documentation — the Higgsfield API surface in particular. They must be re-verified against official docs before implementation, and they live in the model registry and capability manifests so they can change without touching UI code. Where the research was uncertain or silent, this document says so rather than guessing.

---
## 0. Canonical contracts

This section is binding. Where any other section of this document disagrees with §0 — on a name, an enum value, a field, a route, a default, a polarity or a scope decision — §0 wins and the other section is wrong until edited. Each numbered section still owns its own surface: §2 owns the feed's layout, §3 owns the composer's geometry, §4 owns the editor's interaction, §5 owns the picker sheet, §6 owns the adapter interface, §7 owns the canvas, §8 owns storage and delivery. §0 owns only what more than one of them touches: the vocabulary, the identifiers, the capability manifest, the job state machine, the error taxonomy, the HTTP and SSE surface, the lineage model, the preset objects, the mask and version conventions, the image pipeline, determinism, concurrency, cost, the v1 scope list, and the codebase layout and stack (§0.16). Sections must reference §0 rather than restate it; a restatement that drifts is a defect.

---

### 0.1 Vocabulary

One word per concept. These are the only spellings, in code, in the schema and in UI copy.

| Term | Means | Never called |
|---|---|---|
| **Composer** | The floating prompt bar (§3) | prompt bar (in code), promptbar |
| **Feed** | The justified-rows generation history on `/image` (§2) | grid, history grid |
| **Library** | The date-grouped fixed grid on `/assets` (§2.8) | assets page |
| **Detail view** | The full-viewport asset overlay (§4) | lightbox, dialog |
| **Editor** | The Edit tab's editing surface (§4.6) | canvas (that is §7) |
| **Job set** | One submit — one Generate click, one edit commit, one canvas node run — with N outputs | batch, run set |
| **Job** | One output within a job set; one feed tile | task |
| **Asset** | One stored image file plus its row | media, image record |
| **Adapter** | The TypeScript module implementing `Provider` for one provider (§6) | plugin, integration |
| **Manifest** | `ModelManifest`, including `Capabilities` (§0.3) | schema, model config |
| **Folder** | A named, many-to-many collection of assets | collection, album |
| **Preset** | A style recipe (§0.8) | style |
| **Reference set** | A named ordered group of reference images | moodboard |
| **Character** | Reference set + descriptor + optional pinned seed | identity, Soul ID |
| **Palette** | Extracted colours + injection mode | colour transfer |

**The three iteration actions.** The walkthrough recorded a tile "Recreate" icon, a menu "Regenerate", a menu "Reuse", and a detail-panel pair `[Recreate | Reference]`. Openfield ships exactly three actions and no other names. **`Re-run` and `Regenerate` are deleted as names for these three actions, in code and in UI copy.** The one surviving use of `Re-run` is the canvas node's own re-execution action and run pill (§0.11, §7.5) — it never names an action on an asset or a job set.

| Action | Behaviour | Where it appears |
|---|---|---|
| **Recreate** | Replays the **frozen `NormalizedRequest`** stored on the job set — same model, same params, same recorded seed — without touching the composer. Prepends placeholders like any run. On a model with `seed.supported: false` the button carries a `~` badge and the tooltip reads "This model can't make an exact copy. Expect changes." | Tile hover stack; detail action row (primary pair); bulk selection toolbar; `POST /api/job-sets/:id/recreate` |
| **Reuse** | Loads prompt, references, model and every setting into the composer and does **not** run. Settings the current model cannot accept are dropped with one toast listing them. | Tile More menu ("Reuse"); detail More menu; failed-tile "Edit settings" |
| **Use as reference** | Attaches the image to the composer's reference strip only; nothing else is loaded. | Tile bottom-right pill; detail action row (primary pair, second slot) |

The detail action row's primary pair is **`Recreate | Use as reference`** (2 × 155×40), matching the observed `[Recreate | Reference]` slot. **Reuse** lives in the More menu.

**Spelling.** US `canceled` / `canceling` in every enum, column, event name and UI string. British spellings are used only in prose nouns the schema does not touch (`colour grading` as a tool label is fine; the column is `color`).

**Design token namespace.** All design tokens are prefixed `--of-`. §2.2 owns the table and renames its entries accordingly: `--of-surface`, `--of-surface-0` (= `--of-surface`), `--of-surface-sheet` (= `--of-elevated`), `--of-elevated`, `--of-elevated-2`, `--of-border`, `--of-border-strong`, `--of-text-primary|secondary|tertiary`, `--of-accent`, `--of-accent-fg`, `--of-on-accent` (= `--of-accent-fg`), `--of-accent-soft`, `--of-danger`, `--of-danger-soft`, `--of-scrim`. **No section may write a raw hex or rgba literal for a colour.** Measured values that are *geometry* (sizes, radii, blur radii, gaps) are carried over verbatim; measured values that are *colour* are replaced by the token that plays the same role, because the reference product's surface palette is theirs and ours must invert in light mode (§1.11, R12).

---

### 0.2 Identifiers and addressing

| Thing | Form | Notes |
|---|---|---|
| Row id (`assets`, `jobs`, `job_sets`, `canvases`, `canvas_versions`, `canvas_runs`, `presets`, `reference_sets`, `characters`, `palettes`, `saved_prompts`, `folders`) | **ULID**, `TEXT PRIMARY KEY` | Lexicographically time-ordered. **UUID v7 is not used anywhere** — §6.7's `JobHandle.jobId` comment is corrected to `// ULID` |
| Model address | ``ModelKey = `${ProviderId}:${string}` `` | **Colon is the only separator.** `providers.id` may not contain one. The slash form (`google/gemini-3-pro-image`) appears nowhere |
| Deep link | `/image?model=<providerId>:<modelId>` | Unknown key → default model + toast |
| File path in the DB | Relative to `OPENFIELD_HOME` | `assets/2026/09/23/<ulid>.png`. No absolute path, drive letter or username ever enters SQLite |
| Idempotency key | Client ULID, one per job set | Per-attempt provider header is `` `${idempotencyKey}:${jobIdx}` ``, stable across retries. Persisted on `job_sets.idempotency_key` (UNIQUE) and `jobs.idempotency_key` |
| Canvas asset provenance | `assets.op_params.source = "canvas:<canvasId>:<nodeId>"` | Drives "Open in Canvas" |
| Thumb cache key | `<sha256>@h<rung>[@2x].webp` | §0.10 |

**Section numbering.** The final outline is fixed: **§1** overview · **§2** app shell, feed, library · **§3** composer · **§4** detail view and editor · **§5** presets, references, characters, palettes · **§6** providers and adapters · **§7** canvas · **§8** data model, API, queue, delivery. Every `see §N` in every section is repointed to this outline in one mechanical pass, and the three open questions that say "numbering is assumed and may need re-pointing" (§2 Open questions, Appendix A §2 and §8 bullets) are deleted.

---

### 0.3 Capability manifest — canonical shape

`Capabilities` as declared in §6.3 is the **only** manifest vocabulary. Four other naming schemes exist in the drafts (§3's `maxImagesPerRequest`/`maxConcurrentJobs`, §4.6's dotted `edit.*`/`image.*`/`vision.*`, §5's `capabilities.maxReferenceImages`, §7.5's `inpaintMask`/`imageUpscale`, §1.6/§8.4.1's `imageReference`); all are renamed. The type below is §6.3's, widened with the six fields its consumers genuinely need and which nothing else supplies.

```ts
export type ControlId =
  | "model" | "aspect" | "size" | "resolution" | "quality" | "batch" | "seed"
  | "negativePrompt" | "promptEnhance" | "background" | "references"
  | "referenceStrength" | "outputFormat" | "moderation" | "advanced" | "palette";

export interface Capabilities {
  ops: {
    textToImage: boolean;
    imageEdit: boolean;          // image(s) + instruction, no mask
    inpaint: boolean;            // requires a mask
    outpaint: boolean;           // native or mask-synthesised
    upscale: boolean;
    removeBackground: boolean;
    detectText: boolean;         // vision text-run detection (§4.8 row 2)
    decomposeLayers: boolean;    // plugin-only at v1
  };

  references: {
    supported: boolean;
    max: number;                 // 0 when unsupported
    roles: ReferenceRole[];
    mimeTypes: string[];
    maxBytes: number;
    maxPixels?: number;
    weights: boolean;            // provider honours per-image weight
    strengthMode: "per-image" | "global" | "none";
  };

  size:
    | { mode: "aspect"; ratios: AspectRatio[]; default: AspectRatio }
    | { mode: "enum";   sizes: PixelSize[]; default: PixelSize; allowAuto: boolean }
    | { mode: "free";   minEdge: number; maxEdge: number; multipleOf: number; default: PixelSize };

  resolution?: { tiers: ResolutionTier[]; default: ResolutionTier };
  quality?:   { levels: QualityLevel[]; default: string };

  batch: { max: number; native: boolean };          // max is 4 in v1, everywhere
  seed:  { supported: boolean; range?: [number, number]; echoed: boolean };

  negativePrompt: boolean;
  promptEnhance: "native" | "openfield" | "none";
  styleStrength: boolean;                            // native style/preset strength param

  background?: { values: ("auto" | "opaque" | "transparent")[]; default: "auto" };
  transparency: boolean;

  streaming: { partialImages: boolean; maxPartials?: number; progressPercent: boolean };

  output: { formats: OutputFormat[]; default: OutputFormat;
            compression?: { min: number; max: number; default: number } };

  safety?: { moderation?: { values: string[]; default: string; label: string };
             notices?: string[] };

  identity: { nativeCharacterRefs: boolean; nativeStylePresets: boolean };

  limits: { maxPromptChars?: number; requestTimeoutMs: number;
            typicalLatencyMs: [number, number]; maxConcurrent: number };

  /** Chip order in the composer and in the canvas node footer. */
  controlOrder: ControlId[];
  /** Restricted JSON Schema rendered mechanically by the Advanced chip (§3.4.7). */
  extraSchema?: JSONSchema;

  /** Control exists but some options are unavailable. Keyed by ControlId. */
  partial?: Record<string, { unavailable: string[]; reason: string }>;
  /** Control is faked by the adapter (batch fan-out, appended negative prompt, …). */
  emulated?: ControlId[];
  /** Control is declared absent on purpose, with copy for the disabled tooltip. */
  unsupported?: Record<string, { reason: string }>;

  unsupportedParamPolicy: "reject" | "drop-with-warning";
}
```

**Rename table — apply mechanically.**

| Found in a draft | Canonical |
|---|---|
| `maxReferenceImages`, `imageReference`, `edit.referenceImages` | `references.max` / `references.supported` |
| `maxImagesPerRequest`, `maxImagesPerRequest > 1` | `batch.max` / `batch.native === true` |
| `maxConcurrentJobs` | `limits.maxConcurrent` |
| `edit.instruction` | `ops.imageEdit` |
| `edit.mask`, `inpaintMask` | `ops.inpaint` |
| `edit.outpaint` | `ops.outpaint` |
| `image.upscale`, `imageUpscale` | `ops.upscale` |
| `image.segment_subject` | `ops.removeBackground` |
| `image.decompose_layers` | `ops.decomposeLayers` |
| `vision.text_detect` | `ops.detectText` |
| `seed.support`, `capabilities.seed` (boolean) | `seed.supported` |
| `background.transparent` | `background.values.includes("transparent")` |
| `promptEnhancement` | `promptEnhance` |
| `referenceWeights` | `references.weights` |
| `referenceStrength: "per-image"\|"global"\|"none"` | `references.strengthMode` |

**Control resolution — the single rendering rule.** Exactly one function decides every control on every surface (composer chips, canvas node footer, edit-tool rows):

```ts
type ControlState = "supported" | "partial" | "emulated" | "unsupported" | "absent";
resolveControl(caps: Capabilities, id: ControlId): { state: ControlState; options?; default?; reason?: string };
```

| State | Composer / node UI |
|---|---|
| `supported` | Control renders; the popover lists **the model's own options**, never a house list |
| `partial` | Control renders; unavailable options greyed with `reason` as subtitle; info dot on the chip |
| `emulated` | Control renders with a `~` glyph; popover header explains the emulation and its cost consequence |
| `unsupported` | **Core set → renders disabled with a tooltip naming the model.** Non-core → hidden |
| `absent` | Not in the DOM |

**Core set:** Model · Aspect · Resolution/Quality · Images · Seed. Everything else is hidden when `unsupported` or `absent`. §6.3's sentence "A control is **hidden**, never greyed, when the capability is absent" is deleted, and the `negativePrompt` row's "Hidden when false" becomes "Hidden when absent; disabled with a reason when explicitly `unsupported`." Seed is deliberately core-and-disabled: hiding it would hide the reason reproducibility is unavailable.

**Parity acceptance criterion** (replaces §6.3's): *for the models observed in the reference product, the manifest must render the observed chips, in the observed order, with no observed chip missing and no model-capability chip added. Openfield-only controls (Advanced, Avoid, Seed, Reference strength, Palette) are excluded from the comparison and asserted separately.* Where the observed chip set and the provider API disagree, **the API wins** and the note reads: "the reference product's chip set reflects its own proxy, not the public API."

**Discovery is allow-listed, not additive.** `Provider.listModels()` is required only to return the adapter's static catalog; network discovery is optional. A discovered id is added to the picker **only if the adapter's own `recognise(id)` predicate accepts it**; unrecognised ids are recorded in the refresh report and listed under Settings → Models → *Not supported*, never added. There is no conservative-default path for discovered ids — the conservative manifest is reserved for entries the user added deliberately in `~/.openfield/models.json`. (Research: Gemini publishes no image-model `models.list`, and OpenAI's `/v1/models` does not flag image capability.)

---

### 0.4 Job model and state machine

```ts
export type JobState =
  | "pending"      // accepted locally, not yet sent
  | "submitting"
  | "queued"       // provider-side queue
  | "running"
  | "succeeded" | "failed" | "canceled" | "interrupted";

export type JobSetState = JobState | "partial";   // some jobs succeeded, some failed
```

`jobs.status` CHECK and `job_sets.status` CHECK mirror these **verbatim**. `submitted` is deleted (it duplicated `submitting`). Terminal states: `succeeded`, `failed`, `canceled`, `interrupted`.

```
pending → submitting → (queued)* → running → succeeded | failed
   ↓           ↓           ↓          ↓
        canceled (any non-terminal)     |
        interrupted (restart, non-resumable adapter)
```

A job whose adapter cannot resume after a restart is marked **`interrupted`**, shown as "Interrupted." with **Try again**, and is **never auto-resubmitted** (double-billing risk). §6.7's "marked `failed` with `provider_error`" is deleted.

**Operations.** One snake_case union, used byte-identically by `job_sets.op`, `assets.op`, `usage_log.operation` and §4.9's operation record:

```ts
export type Op =
  | "generate" | "edit" | "inpaint" | "outpaint" | "variation"
  | "upscale" | "remove_bg" | "text_edit" | "relight" | "angles" | "enhance" | "decompose"
  | "crop" | "grade" | "overlay";

/** The subset an adapter is ever asked to perform. */
export type AdapterOp = "generate" | "edit" | "inpaint" | "outpaint" | "upscale" | "remove_bg";
```

`GenerateOp` in §6.5 is renamed `AdapterOp` and loses camelCase `removeBackground` → `remove_bg`. Compile mapping, applied in `normalize()`:

| Recorded `Op` | Submitted `AdapterOp` | Notes |
|---|---|---|
| `relight`, `angles`, `enhance`, `text_edit` | `edit`, or `inpaint` when a mask is present and `ops.inpaint` | Widget compiles a structured instruction; labelled best-effort |
| `variation` | `generate` | seed-jitter / prompt-list / model-list strategies |
| `decompose` | — | plugin only |
| `crop`, `grade`, `overlay` | — | **local ops**: `provider_id = 'local'`, `cost_actual_usd = 0`, `assets.generative = 0`, no provider call |

**Lineage relations are not operations.** `asset_edges.relation` is the small union `'derived' | 'reference' | 'import'`. The operation lives on the asset (`assets.op`), never on the edge.

**Runner rules** (canonical; §6.7's table, §7.7 and §8.4 defer to it):

| Concern | Rule |
|---|---|
| Concurrency | §0.12 |
| Poll schedule | 800 ms first poll, ×1.6 backoff, cap 5 s, ±20 % jitter; `nextPollAfterMs` and `Retry-After` win |
| Retry | Only `retryable` codes (§0.5). `maxAttempts` 3 (1 + 2 retries), full-jitter backoff 1 s / 4 s / 15 s ±20 %, `Retry-After` always wins |
| Timeout | §0.12 |
| Idempotency | `` `${idempotencyKey}:${jobIdx}` ``, reused on every attempt |
| Durability | Handles in SQLite; on boot, resumable jobs re-attach, non-resumable become `interrupted` |
| Cancellation | §0.12 |

---

### 0.5 Error taxonomy

`ErrorCode` is canonical for **anything that reaches a job row, a feed tile, a node band or an SSE frame**.

```ts
export type ErrorCode =
  | "auth_missing" | "auth_invalid" | "auth_forbidden"
  | "billing_required" | "quota_exceeded" | "rate_limited"
  | "content_refused" | "content_flagged_input"
  | "unsupported_param" | "capability_unsupported" | "invalid_request" | "payload_too_large"
  | "provider_unavailable" | "provider_error"
  | "network" | "timeout" | "disk_full" | "canceled" | "unknown";
```

`retryable: true` for exactly `network`, `timeout`, `rate_limited`, `provider_unavailable`. Everything else fails immediately.

**HTTP transport codes are a separate, small set** and never overlap: `bad_request`, `not_found`, `conflict`, `internal` — plus "any `ErrorCode` above" when the failure originated in a provider call. §8.3's list loses `missing_credential`, `provider_auth`, `provider_rate_limit`, `content_policy`, `capability_unsupported`, `disk_full`, `timeout`, `canceled` (those are `ErrorCode`s). `jobs.error_code` and `job_sets.error_code` are commented "one of §0.5 `ErrorCode`".

**Failed-tile copy** (replaces §2.4's table, which keyed on codes that exist nowhere else):

| `ErrorCode` | Tile reason (our copy) | Primary action |
|---|---|---|
| `auth_missing` | "No key for this model" | Open Settings |
| `auth_invalid` / `auth_forbidden` | "This key was rejected" | Change key |
| `billing_required` / `quota_exceeded` | "This key is out of credit" | Open billing page |
| `rate_limited` | "Too many requests. Try again in a minute." (the tile only appears once Openfield's own retries have run out; while they run, status text may say "Retrying") | Try again |
| `content_refused` / `content_flagged_input` | "The model wouldn't make this" | Reuse (edit the prompt) |
| `unsupported_param` / `capability_unsupported` | "This model can't do that" | Reuse |
| `invalid_request` / `payload_too_large` | "These settings didn't work" | Details |
| `provider_unavailable` / `provider_error` | "The model ran into a problem" | Details |
| `network` | "Couldn't connect" | Try again |
| `timeout` | "This took too long" | Try again |
| `disk_full` | "Couldn't save. Your disk is full" | Free up space |
| `canceled` | "Canceled. You may still be charged for work that already started." (§0.12, verbatim) | Recreate |

When an adapter's `userMessage` says more than the row above (for example "Image blocked. It came from an unknown site."), the runner stores it on the job as `error_reason` and the tile shows it instead; retryable codes keep the row's copy, because their "trying again" wording is stale once the retries are spent. The failed tile's **Details** shows only our copy (what to try, and when it happened), never the code or the provider's message.

Every failure card links to the **Error log** (Settings → Help): redacted request payload, HTTP status, `providerCode`, redacted response. `mapError` has one signature everywhere: `mapError(res: Response, body?: unknown): Promise<ProviderError>`, always `throw await mapError(res, body)` / `error: await mapError(res, body)`.

---

### 0.6 Local HTTP API and event stream

**§8.3 owns the HTTP surface.** §2, §6 and §7 reference it and never restate a path. Canonical corrections to every call site:

| Wrong, in a draft | Canonical |
|---|---|
| `GET /api/thumb/:assetId?w=&q=` (§2.3, §2.9) | `GET /files/thumb/:id?h=<rung>&dpr=1\|2` |
| `DELETE /api/jobs/:id` (§2.4) | `POST /api/jobs/:id/cancel` |
| `GET /api/export/zip?ids=` (§2.5) | `POST /api/assets/bulk {action:'download'}` |
| `POST /api/jobs` (§6.5) | `POST /api/generate` |
| `GET /api/jobs/stream` (§6.7) | `GET /api/events` |
| `POST /api/canvas`, `PATCH /api/canvas/{id}` + `baseVersion` (§7.3, §7.8) | `POST /api/canvases`, `PATCH /api/canvases/:id` + `graphVersion` |
| `POST /api/canvases/:id/nodes/:nodeId/run` (§8.3) | `POST /api/canvases/:id/run` (see below) |
| `maskDataUrl` in `POST /api/edit` (§8.3) | `maskAssetId`, uploaded via `POST /api/masks` |

**Rows added to §8.3's table:**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/masks` | Upload a painted mask as an internal asset (`multipart/form-data`, PNG, must match the base asset's pixel dimensions) → `{asset}` with `kind='mask'`, `mime='image/png'` |
| `POST` | `/api/job-sets/:id/recreate` | Replay the frozen `NormalizedRequest` as a new job set (§0.1 **Recreate**) → 202, same shape as `/api/generate` |
| `POST` | `/api/canvases/:id/run` | `{scope:'node'\|'downstream'\|'all'\|'selection', nodeIds, plan:[{nodeId, typeVersion, fingerprint, model, params, inputs}], dryRun?}` → `{runId, jobSets:[{nodeId, jobSetId}], skipped:[{nodeId, reason:'cached'}], estimate}` |
| `POST` | `/api/canvases/:id/runs/:runId/cancel` | Cancel a whole canvas run |
| `GET`/`POST` | `/api/reference-sets` · `PATCH`/`DELETE` `/api/reference-sets/:id` | §0.8 |
| `GET`/`POST` | `/api/palettes` · `PATCH`/`DELETE` `/api/palettes/:id` | §0.8 |
| `GET`/`POST` | `/api/prompts` · `PATCH`/`DELETE` `/api/prompts/:id` | Saved prompts (§5.9) |

`GET /api/assets` default `limit=50` (the measured feed page size), not 60. `POST /api/uploads` accepts `.jpg .jpeg .png .webp .heic` (HEIC transcoded to PNG on ingest).

**One request body.** `POST /api/generate` and `POST /api/edit` take the **same type** — §6.5's `GenerateRequest`, extended. `/api/generate` accepts `op: "generate"` only; `/api/edit` accepts every other `Op`. §8.3.1's nested `params` example is deleted.

```ts
export interface GenerateRequest {
  idempotencyKey: string;              // client ULID, one per job set
  model: ModelKey;                     // "google:gemini-3-pro-image"
  op: Op;

  prompt: string;
  negativePrompt?: string;
  enhancePrompt?: boolean;

  size: SizeSpec;                      // {kind:"auto"} | {kind:"aspect",ratio} | {kind:"pixels",width,height}
  resolution?: ResolutionTier;
  quality?: string;                    // a QualityLevel.id
  background?: "auto" | "opaque" | "transparent";
  output?: { format: OutputFormat; compression?: number };

  batch: number;                       // 1 … capabilities.batch.max (≤ 4 in v1)
  seed?: number;                       // absent ⇒ server generates, when supported (§0.11)

  references?: ReferenceInput[];       // {assetId, role, weight?}
  base?: ReferenceInput;               // edit / inpaint / outpaint / upscale source
  mask?: MaskInput;                    // {assetId, invert?, featherPx?} — §0.9
  expand?: { top: number; right: number; bottom: number; left: number };

  presetId?: string;
  presetStrength?: number;             // 0–1
  characterId?: string;
  referenceSetId?: string;
  paletteId?: string;
  moderation?: string;

  source: "composer" | "detail_editor" | "canvas" | "api" | "recreate";
  canvas?: { canvasId: string; nodeId: string };
  providerOptions?: Record<string, unknown>;   // Advanced → Custom only
}
```

Response is 202 with the job set and its N jobs carrying resolved `width`/`height`, exactly as §8.3.1 documents, so placeholders reserve the correct aspect ratio before any provider call.

In code, `GenerateRequest` and `NormalizedRequest` are zod schemas in `packages/core/src/schemas/request.ts`, and their TypeScript types are inferred from them. Both `/api/generate` and `/api/edit` validate their body with `@hono/zod-validator` against those schemas (§0.16, §8.3.3).

**`NormalizedRequest`** — declared once in §6.5, because `estimate`, `submit` and the whole of §6.5 step 6 take it and no draft defines it:

```ts
export interface NormalizedRequest
  extends Omit<GenerateRequest, "presetId" | "presetStrength" | "characterId" |
                                "referenceSetId" | "paletteId" | "size"> {
  jobId: string;                       // ULID, one per output
  jobSetId: string;
  batchIndex: number;
  batch: number;                       // 1 when the runner fans out
  size: PixelSize | { aspect: AspectRatio };
  seed?: number;                       // filled only when capabilities.seed.supported
  promptAfterPreset: string;
  manifestVersion: string;
  paramsHash: string;                  // §0.11
}
export type PixelSize = { width: number; height: number };
export interface PerImagePrice { quality?: string; tier?: ResolutionTier; usd: number }
export interface Diagnostic { level: "error" | "warning"; field?: string; code: string; message: string }
```

`PriceTable`, `AssetSink`, `RedactingLogger`, `RefreshReport` and `UnknownModelError` are declared alongside it in §6.5/§6.2.

**Event stream.** One SSE endpoint: `GET /api/events`. `GET /api/jobs/stream` is deleted. Event types:

`snapshot` · `job_set.created` · `job.queued` · `job.started` · `job.progress` · **`job.partial`** · `job.output` · `job.failed` · `job.canceled` · `job_set.completed` · `asset.updated` · `asset.deleted` · `folder.updated` · `models.updated` · `usage.updated` · `canvas_run.updated` · `maintenance.progress`.

```
event: job.partial
data: {"jobId":"01K…","index":0,"partialIndex":1,"thumbUrl":"/files/thumb/tmp-01K…?h=456","width":1536,"height":2048}
```

Partial frames are written to `tmp/`, served from a volatile thumb path, **never inserted into `assets`**, and superseded by the final `job.output`. This is what terminates `ImageModel.stream?()` and `streaming.partialImages`.

**Security — all four guards are mandatory, on every method including GET.**

1. **Host check.** Reject any `Host` that is not `127.0.0.1:<port>` or `localhost:<port>`.
2. **No CORS, ever.** The server never emits `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials` or `Timing-Allow-Origin` on any route, in any build, including dev.
3. **Cross-site guard.** Reject any request carrying `Sec-Fetch-Site: cross-site`, or `Sec-Fetch-Dest: image|script|style` on an `/api` path, or an `Origin` header that is not the app's own origin — **GETs included**, because `GET /files/thumb/:id` has a side effect (it generates and writes a file) and `GET /api/assets` is the whole prompt history.
4. **Session token.** The server mints a random token at boot, injects it into `index.html`, and requires it as `X-Openfield-Session` on every `/api` and `/files` request. A page that cannot read our HTML cannot forge it.

Acceptance: *a cross-origin page cannot list assets, read key status, or cause a thumbnail to be generated.* R11's mitigation text is rewritten to match.

**Outbound network posture.** Outbound connections are restricted to `meta.networkHosts ∪ meta.assetHosts` of enabled adapters. `assetHosts: string[]` is a **new required field on `ProviderMeta`** (e.g. `cdn.higgsfield.ai`) and is listed in Settings → Privacy beside `networkHosts`. A download URL whose host is in neither list is refused with `provider_error`, logged with the host, and surfaced as "Image blocked. It came from an unknown site." Redirects are not followed across hosts; only `https:` is permitted. Conformance test 19 becomes "Only hosts in `meta.networkHosts ∪ meta.assetHosts` are contacted."

---

### 0.7 Assets, lineage and files

**Storage tree** is §8.1's, canonical. `~/.openfield/thumbs/` (not `cache/thumbs/`), `uploads/YYYY/MM/DD/<ulid>.<ext>`, `canvases/previews/<id>.png`. **`refs/` does not exist** — reference images are ordinary uploads.

**`assets` carries the columns §4.9 declares mandatory.** They are declared in `packages/db/src/schema/assets.ts` (§8.2, the source of truth):
- `parent_asset_id`: `TEXT`, no FK (tombstone pointer)
- `root_asset_id`: `TEXT NOT NULL` (denormalised lineage root)
- `op`: §0.4 `Op`, typed by `OPS`, no CHECK
- `op_params`: JSON
- `mask_asset_id`: references `assets(id)` `ON DELETE SET NULL`
- `generative`: `NOT NULL DEFAULT 1`
- `approximate`: `NOT NULL DEFAULT 0`
- `approximate_reason`
- the partial index `idx_assets_root ON assets(root_asset_id, created_at) WHERE deleted_at IS NULL`

`assets.kind` CHECK is built from `ASSET_KINDS`: `('generated','uploaded','imported','edited','mask')`.

`parent_asset_id` deliberately carries **no foreign key**: a hard-deleted parent must leave the child's chain intact (§4.9 requirement 7, §8.6's "the edge points at a tombstone"). `asset_edges` keeps `ON DELETE CASCADE` on `child_asset_id` only, drops the FK on `parent_asset_id`, and its `relation` CHECK becomes `('derived','reference','import')`.

**Two lineage queries, two jobs.** The version strip and the History tab load with `WHERE root_asset_id = :root ORDER BY created_at` against `idx_assets_root` — one index scan, no recursion (§4.9 requirement 1). §8.2.2's `WITH RECURSIVE` survives **only** as the multi-parent reference graph behind `GET /api/assets/:id/lineage`.

**Ingest is non-destructive and single-pathed.** Every byte that enters Openfield — provider output or user upload — goes through §8.5.1: stream to `tmp/<ulid>.part`, hash while streaming, probe dimensions and real MIME from magic bytes (never the declared type), dedupe on `assets.sha256`, atomic `rename()` into place, insert the row in the same transaction that flips the job. **Originals are stored exactly as returned — no re-encode, no strip, no EXIF removal.** Google's SynthID watermark survives untouched; `safety.notices` is therefore an honest claim. A 2048px-long-edge WebP working copy for the editor lives in the thumb cache, never in place. §5.6's sha256-named `refs/` tree and its q85 re-encode are deleted; reference sets hold **asset ids**, never paths or hashes.

Consequently **§6.13's Gemini `output.format` row becomes "not exposed ⇒ `output.formats: ["jpeg"]`, chip hidden."** (JPEG is the only image output type the generateContent reference documents, checked at M0-07; the stored bytes are whatever Google returns.) Format conversion happens only on export (§8.5.4), where the dialog warns: *"Changing the format may remove the hidden AI watermark."*

**Deletes.** Soft delete sets `deleted_at`; the asset leaves every feed and every query filters `deleted_at IS NULL`. **The FTS row is retained on soft delete** (no trigger fires on `deleted_at`, and none is added); hard delete removes it via the `assets_ad` trigger. §8.6's claim "FTS row is removed" is deleted.

**FTS and backups.** `assets` has a TEXT primary key and therefore an implicit rowid that `VACUUM` may renumber, so `VACUUM INTO` can produce a backup whose `assets_fts` docids no longer match. Restore is therefore defined as: *stop the server, replace `~/.openfield`, start* — and on boot, **before the HTTP listener accepts traffic**, the server runs `INSERT INTO assets_fts(assets_fts) VALUES('rebuild')` whenever the db file's inode/mtime indicates it was replaced. `POST /api/maintenance/reindex {fts:true}` runs the same rebuild on demand.

---

### 0.8 Preset, reference set and character objects

**Placeholder tokens.** `{prompt}` — single brace — is the preset template slot, reserved exclusively for presets, and MUST appear exactly once. `{{name}}` is the user-variable syntax (§5.9) and resolves **before** templates. `{{prompt}}` appears nowhere; §6.5 step 1 and the §8.2 column comment are corrected.

**The §5.3 object is the canonical JSON wire and file shape**, for all four entity kinds. §3.6's `{name, promptTemplate, negativeAdditions?, referenceImages[]?, strength, defaults?}` and §6.10's `{name, promptTemplate, fragments, references[], defaults{}}` are deleted and replaced with "see §5.3". Envelope `kind` is `"style" | "reference-set" | "character" | "palette"`.

**Storage of record is SQLite.** `~/.openfield/presets/` holds only `exported/` and `imported/` material; the folder form is an **import/export format, not a live store**. §5.5's "the folder form is the canonical write format" is corrected. §5.11's acceptance criterion becomes: *deleting the `presets` rows and restarting re-seeds the 12 bundled presets and 8 bundled palettes from `apps/server/seed/presets/` and `apps/server/seed/palettes/`.*

**Four entities, four tables.** The `presets` table holds style presets only. The `kind` column and `GET /api/presets?kind=` are **removed**, and the import endpoint routes by envelope `kind`. The tables are declared in `packages/db/src/schema/library.ts` (§8.2, the source of truth) and created by the initial generated migration. §5.10 lists their columns. These constraints matter across sections:
- `presets.payload_json` is the §5.3 object and the single source.
- `reference_set_items` is keyed on `(set_id, asset_id)`, holds **asset ids, never sha256**, and checks `role IN ('style','subject','composition','palette')`.
- `palettes.mode IN ('prompt','reference','both')`.
- `saved_prompts.preset_id` references `presets(id)` `ON DELETE SET NULL`.
- `characters` carries `reference_set_id` (references `reference_sets(id)`), `seed`, `lock_seed` (default 0), `injection IN ('prefix','suffix','replace-token')`, `token` and `provider_identity_json`.

**Resolution order** (server-side, in `normalize()` step 1, logged verbatim onto the job set so Reuse and Recreate reproduce it even after the preset is edited): variables and snippets → `basePrompt`; template variant by `strength`; `{prompt}` substitution; palette clause; negative prompt (native where `negativePrompt`, else appended as `Avoid: …` with a visible note); `params` merge minus anything the manifest does not declare; `providerOverrides["<provider>:<modelId>"]` then `["<provider>:*"]`; references, preset-first in weight order, truncated to `references.max`. `presetStrength` maps to a native parameter when `styleStrength` is true, otherwise selects the `light` variant, otherwise disables the slider with a reason.

**`@`-mentions resolve Openfield objects only** — presets, characters, reference sets, saved references. The reference product's server-side "Elements" entity is not reproduced.

---

### 0.9 Editing conventions (masks, regions, versions)

**Mask polarity — stated once, here, and repeated nowhere.**

> Openfield's canonical mask is an **RGBA PNG at the base image's exact pixel size. Alpha = 0 (fully transparent) marks the region the model must regenerate; alpha = 255 preserves. RGB channels are ignored.**

This is §4.6's convention, it matches the OpenAI edits convention as generally documented, and it is the only one. `MaskInput`'s comment in §6.5 is rewritten to it; §6.14's mask row becomes "the adapter converts Openfield's canonical mask (alpha 0 = edit) to whatever polarity the live probe establishes for `/v1/images/edits`, covered by a fixture test — polarity is unconfirmed in the research"; §7.6's `image → mask` coercion becomes "**luminance → alpha, white = alpha 0 = edit region**", with the coercion glyph on the edge.

**Masks are assets, not payloads.** A committed mask is uploaded once via `POST /api/masks` and travels as `maskAssetId`. `maskDataUrl` is deleted from `POST /api/edit`. `invert` and `featherPx` are applied by core before upload, are recorded in `assets.op_params`, and never reach the adapter as flags. No base64 crosses the provider interface (conformance test 16).

**Regional fallback.** When a model has `ops.imageEdit` but not `ops.inpaint`, core crops the mask's bounding box with 12 % context padding, snaps it to an accepted size, sends it with the full image as context, and composites the result back with a 2px feathered alpha. The asset is written with `approximate = 1` and `approximate_reason`, carries an **Approximate** badge in the version strip and the History row, and the fallback is a Settings toggle (default on, one-time explainer). An emulated regional edit is never presented as a true inpaint.

**Versions.** No operation ever overwrites an image file. Every commit — generative or local — writes a new file and a new `assets` row with `parent_asset_id`, `root_asset_id`, `op`, `op_params`, `generative`, and `mask_asset_id` where one was used. Local ops write `generative = 0`, `cost_usd = 0`, `provider_id = 'local'`. In-session undo/redo covers uncommitted work only; a commit becomes a version, not an undo step.

**Editor tools and shortcut precedence.** The observed toolbar binds **Shapes to `R`** — §4.6 and §4.5's key list are corrected to `V H M A D E R T`, and §7.9's canvas Shape stays `R`. Edit area (`M`) and Lasso (`A`) are our own assignments; no shortcut was observed for them.

§2.6 publishes the one global shortcut table; §4.5 and §7.9 cross-reference it and add only their own surface's tools. Collisions are resolved as:

| Key | Binding | Was |
|---|---|---|
| `⌘K` | Command palette, everywhere | §3.2 also claimed it for the model chip |
| `⌘M` | Choose model | (new; replaces §3.2's `⌘K`) |
| `R` | **Recreate**, on feed and detail | §4.4/§4.5 claimed it for Use as reference |
| `U` | **Use as reference**, on feed and detail | §4.4's "the two surfaces agree" was false |
| `F` | Favourite, on feed and detail | §4.5 used `F` for fullscreen and `L` for favourite |
| `⇧F` | Expand image | replaces §4.5's `F`; `L` is deleted |
| `D` | Download — **except on the Edit tab**, where tool letters win and Download moves to `⌘⇧S` | §4.5 listed `D` with no tab qualifier |

On the Edit tab, tool letters take precedence over surface actions. That precedence rule is stated explicitly in §2.6 and §4.5.

---

### 0.10 Image pipeline: zoom ladder, thumbnails, formats, metadata

**One ladder. §8.5.2 owns it.** The measured value is step 3 ≈ 456 px; §2.3's 250/296/354/440/592 table is replaced.

| Zoom step | Target row height | Thumb rung | Approx. cols @1424 px content |
|---|---|---|---|
| 0 Contact sheet | 200 | `@h200` | 8–9 |
| 1 Small | 280 | `@h280` | 6–7 |
| 2 Medium | 360 | `@h360` | 5 |
| 3 **Large (default)** | **456** | `@h456` | **4** |
| 4 Showcase | 640 | `@h640` | 3 |
| — detail dialog | long edge 1440 | `@p1440` | — |

- Height-keyed, never width-keyed. `srcset` spans `@h200,@h280,@h360,@h456,@h640` plus `dpr=2` variants capped at the original's dimensions. §2.3's width `srcset` (256/384/512/768/1024/1536) and §7.10's 128/256/512/1024 ladder are both replaced by this one; canvas node thumbnails request the smallest rung ≥ 2× the rendered box.
- Serving: `GET /files/thumb/:id?h=<rung>&dpr=1|2`. The server resolves to the **nearest-or-larger rung**, so arbitrary query values can never explode the cache. Single-flight lock keyed `sha@h@dpr`. `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<sha>@h456"`.
- Cache path: `~/.openfield/thumbs/<sha[0:2]>/<sha>@h456.webp`. Not `cache/thumbs/`.
- **AC-2.3.1 is rewritten:** *at a 1440 px viewport, zoom step 3, a row of four 4:5 assets solves to 365×456 with 2 px gaps, and the row's rendered width equals the container width to within 1 px, verified with `getBoundingClientRect()`.* The mixed-row worked example in §2.3 already solves at 456 and stands.

**Encoder: `sharp` only**, with a safe fallback instead of a second encoder:

> `sharp` (libvips) is loaded once at boot. If it loads, thumbnails are WebP `quality 82`, `effort 4`, metadata stripped, `fit: inside`, on a worker pool capped at `max(1, cores − 2)`. **If it fails to load under Bun, thumbnails are off**: `GET /files/thumb/:id` streams the original instead, and Settings → Storage says "Thumbnails are off. Images show at full size, so scrolling may be slower." There is no WASM chain.

**Metadata on export.** PNG `tEXt`/`iTXt` chunks — including the legacy `parameters` chunk for interop with existing tooling — are written by a small in-repo chunk writer (`png-chunks-extract` / `png-chunk-text` class, MIT) applied to the **encoded buffer after** the encoder; `sharp` cannot write arbitrary PNG text chunks. EXIF/XMP for JPEG and WebP use `exiftool-vendored` or the same post-encode approach; the choice is a **blocking sub-task `M2-13a`** (spike: confirm PNG `tEXt`/`iTXt` + legacy `parameters` round-trip and WebP XMP/EXIF round-trip, under Bun). Any export whose `format` differs from `assets.mime` shows the re-encode watermark warning (§0.7).

**Batch cap is 4, everywhere.** `job_sets.batch_size CHECK (batch_size BETWEEN 1 AND 4)` — the §8.2 CHECK of 8 is the one place a bad client or a canvas fan-out could double a user's spend past the UI cap. Comment: *"UI cap is 4 (observed parity); raising it requires a migration and a manifest change."*

---

### 0.11 Determinism: seeds, replay, caching

**Seeds are generated server-side, in `normalize()` step 4, and only when `capabilities.seed.supported`.** §3.4.5's "fresh client-side random seed per job" is deleted, including the parenthetical claiming the observed payload proves it — that was the reference product's client, not a contract on ours. The composer sends `seed: null`. Rules:

| Case | Behaviour |
|---|---|
| Unlocked, `seed.supported` | Field shows the seed of the last completed run, greyed. Server generates one 32-bit seed **per output** and records it on `jobs.seed` and `assets.seed` |
| Locked, `seed.supported` | The entered seed is sent; for batch > 1 the server derives `seed, seed+1, … seed+n−1` |
| `seed.supported: false` | `jobs.seed` stays NULL. The Seed chip renders **disabled with a reason** (core set, §0.3). **No launch adapter declares seed support** (§6.13, §6.14), so on every v1 model Recreate is an exact *replay of the request*, not a reproduction of the image, and the `~` badge says so |

**Frozen request.** `normalize()` ends by hashing `NormalizedRequest + {modelKey, manifestVersion, promptAfterPreset}` into `paramsHash` with `hashCanonical()`, and writes the whole normalized object to `job_sets.request_json`. **Recreate replays that object, never the current UI state or the current manifest**, so a manifest change can never silently alter a re-run.

**Canvas fingerprints reuse the same hash function**, `hashCanonical()` from `@openfield/core` (canonical JSON, then SHA-256), so the browser and the server compute identical values:

```
fingerprint = sha256(typeId, typeVersion, normalizedParams, modelKey,
                     manifestVersion, [upstream fingerprints in port order])
```

A node is `cached` when `fingerprint === result.fingerprint` and every referenced asset still exists. Seed modes `Fixed` and `From input` are offered **only when `seed.supported`**; on models without seeds the node always caches on unchanged inputs and the run pill reads "Each run gives a new result." §7.7's "a node whose seed mode is `random` can never cache" would otherwise make every launch-model node uncacheable.

**Results that arrive late.** A result carries the fingerprint it was **submitted** with. On arrival the runner compares it to the node's current fingerprint: on a match the node goes `done`; on a mismatch **the asset is still filed in the library** and the node renders `stale` with the chip "Made with older settings · Open · Re-run". Undo and redo never cancel an in-flight run; a node with a run in flight refuses reparenting and deletion, with the toast "Wait for this node to finish, or cancel it."

---

### 0.12 Concurrency, queue and cancellation defaults

**§8.4.2 owns the numbers. §3.6, §6.7 and §7.7 cross-reference them and state none of their own.**

| Setting | Default | Rule |
|---|---|---|
| `globalConcurrency` | **4** | Total in-flight provider calls across all providers. §7.7's "3 concurrent provider jobs globally" is wrong |
| Effective per-provider cap | — | `min(providers.concurrency_cap, manifest.limits.maxConcurrent)`. Precedence stated once, here |
| `providers.openai.concurrency_cap` | 2 | Complex prompts can run ~2 min |
| `providers.google.concurrency_cap` | 4 | 3–4 s/image |
| `providers.higgsfield.concurrency_cap` | 2 | Rate limits undocumented |
| `attemptTimeoutMs` | from `limits.requestTimeoutMs` — default 120 000 generate, 300 000 upscale | Per attempt |
| `jobDeadlineMs` | **900 000** | Whole-job wall clock across all attempts. `jobTimeoutMs: 180000` is **deleted** — it made `maxAttempts: 3` unreachable against a 150 s per-attempt timeout |
| `maxAttempts` | 3 | Attempt 1 + 2 retries |

OpenAI's `limits.requestTimeoutMs` is raised to **180 000** in §6.14: the research records complex prompts taking up to ~2 minutes, and 150 000 leaves no headroom.

**Scheduling.** `job_sets.priority INTEGER NOT NULL DEFAULT 10` is a **new column**. Selection order is `job_sets.priority DESC, job_sets.created_at, jobs.idx`, with round-robin across providers at each tick so a capped provider cannot block a free one. Composer runs and single-node canvas runs enqueue at **10**; canvas run-downstream and run-all enqueue at **5**, so a 30-node batch cannot starve a user who just pressed Generate. This replaces both §8.4.2's priority-free FIFO description and §7.7's unimplemented 10/5 scheme.

**Cancellation is honest, on every surface.**

1. Still `pending`/`queued` → `canceled` synchronously, nothing spent.
2. In flight → abort the outbound fetch.
3. Adapter implements `cancel()` → call it, mark `canceled` on acknowledgement.
4. Adapter does not → mark `canceled`, stop polling, discard any late result, and write a `usage_log` row at **full estimate with `discarded = 1`**.

**Neither launch adapter implements provider-side cancel**, so (4) is the path every v1 cancellation takes: the provider may complete and bill the work, and **no asset is produced**. Copy, verbatim, on the tile, the node band and the toast: *"Canceled. You may still be charged for work that already started."* §7.12's criterion becomes "…and keeps every asset already **written to the library**; runs canceled after submit are recorded in the usage log as billed-but-discarded."

**Crash recovery** (§8.4.5) is unchanged in shape and uses §0.4's states: `queued` → re-enqueue; `submitting`/`running` with a `provider_job_id` and a pollable adapter → resume the watcher (not re-billed); otherwise → `interrupted`, never auto-resubmitted.

**Canvas execution split, stated once at the top of §7.7:**

> The DAG compiler, fingerprinting and dirty propagation run **in the browser** (they are pure over the document). **Scheduling and execution run in the server**: the client POSTs a compiled run plan to `POST /api/canvases/:id/run` and the server owns ordering, concurrency, retry and crash recovery. `canvas_runs(id, canvas_id, scope, status, created_at, finished_at)` persists a run so it survives a reload.

---

### 0.13 Cost and usage accounting

**Pricing is pure data, and the estimate is a pure function.** `estimate()` is removed from the `ImageModel` interface, because the browser cannot call a method and an HTTP round-trip per batch-stepper click is not acceptable. Instead:

```ts
/** Pure. Touches manifest.price only, never credentials. Exported from the browser-safe
 *  entry @openfield/providers/manifest and imported by apps/web, which already holds the
 *  manifest in memory (§0.16). */
export function estimate(manifest: ModelManifest, req: NormalizedRequest): CostEstimate;

/** Optional, on ImageModel. One network round-trip for providers with a cost endpoint.
 *  Never on the render path; result cached per paramsHash. */
estimateRemote?(req: NormalizedRequest, ctx: CallContext): Promise<CostEstimate>;
```

The composer, the edit-tool CTAs and the canvas run pills compute the estimate **locally** from the manifest. `POST /api/models/:p/:m/estimate` remains for server-side callers and the canvas run-all preview only. The Generate sub-label renders the pure estimate first and upgrades in place if `estimateRemote()` resolves. Conformance test 4 ("`estimate()` is pure: no network, no clock, deterministic") now applies to the exported function and is satisfiable by every adapter.

```ts
export interface CostEstimate { currency: "USD"; min: number; max: number;
  confidence: "exact" | "estimated" | "unknown"; basis: string; pricedAt: string }
export interface CostActual { currency: "USD"; amount: number;
  confidence: "reconciled" | "estimated" | "unknown"; basis: string }
```

`POST /api/models/:p/:m/estimate` returns `{min, max, confidence, basis, pricedAt}` — matching `CostEstimate` exactly. §8.3's `{costUsd, low, high, basis:'per_image'|'per_token'|'unknown', asOf}` is replaced; `basis` is the human string ("3 images × $0.134 (2K)"), not an enum.

**`per_token` pricing gains cached input**, since the research records cached-input discounts: `cachedInputPerMTok?: number` on the `per_token` variant and `cachedInputTokens?: number` on `ProviderUsage`. Where a provider reports cached tokens they are billed at that rate; where the field is absent, the reconciled figure is an **upper bound** and is labelled `≤`.

**Unverified endpoints never produce an exact number.**

- Higgsfield: `price.kind = "unknown"` at launch. The only evidence for an estimate endpoint is a third-party blog with no path, request or response shape recorded, and the product's private `/fnf/job-sets/costs` is out of bounds (§1.11). The Generate button reads "Cost unknown". Upgrade to `provider_estimate` + `confidence: "estimated"` only after a live probe confirms the path and response shape; `"exact"` requires a documented public endpoint.
- OpenAI: whether `POST /v1/images/generations` returns a `usage` block is **unconfirmed** and is part of the same live probe as mask polarity. Until then the adapter ships `confidence: "estimated"` and the Usage screen marks those rows `~`.

**`usage_log` — one row per terminal outcome, success, failure and cancel alike.** §8.2's table gains the columns §6.9's row spec needs: `estimate_min REAL, estimate_max REAL, price_as_of TEXT, discarded INTEGER NOT NULL DEFAULT 0, batch_index INTEGER, size TEXT, quality TEXT`, and `cost_source` values become `'reconciled' | 'estimated' | 'unknown'`.

§2.4's "Cost is never logged for a failed job" and §8.4.3's "every terminal outcome writes a row" are reconciled as: **a failed job writes a `usage_log` row with `cost_usd = 0` and `cost_source = 'unknown'`; no cost is ever added to a spend total for a failure.** A canceled-after-submit job writes a row at full estimate with `discarded = 1`, which is what the Usage screen's "Canceled but charged" line sums.

Prices always carry `pricedAt` and `sourceUrl`, are never presented as authoritative, are overridable in `~/.openfield/prices.json`, and are never changed silently — `refreshPricing()` proposes a diff the user accepts or rejects.

---

### 0.14 Scope contract: what v1 ships

**This list is the scope contract. §8.8's parity checklist is rewritten to agree with it, and R16 points here.** The checklist cannot cancel a feature that §3 or §4 specifies in full; where the drafts disagreed, the feature section wins unless a locked decision says otherwise.

#### Ships in v1

| Feature | Milestone | Form |
|---|---|---|
| Justified-row feed, 5-step zoom, 2 px gaps, multi-select, hover actions | M1 | §0.10 ladder |
| Local tips card in the first placeholder | M1 | Static local JSON, dismissible, Settings switch, no network. Queue position renders in the same slot when a run is waiting |
| Model picker: search, **Recent / by company / Needs a key**, capability badges | M1 | **Not Featured/All** — that is the reference product's editorial grouping (§1.11). M1-04 and §8.8 row 19 are corrected |
| **Local prompt enhance** | M1 | Per §3.4.3: enhancer-model select over the user's own text models, rewrite styles, preview/automatic modes, diff sheet, 8 s Undo, `prompt_original` persisted, separate usage-log line. Off by default; chip **disabled with "Add an OpenAI or Google key to use this"** when no text-capable key exists. `promptEnhance: "openfield"` on both launch adapters is therefore honest |
| **`@`-mention typeahead** | M1 | Resolves Openfield presets, characters, reference sets and saved references (§3.2, §5.7). `/` snippets alongside (§5.9). The reference product's server-side "Elements" entity is not reproduced |
| Detail view: Info · **Edit · History** tabs | M2 | Comments dropped (single user); History replaces it |
| **Layers panel** | M2 | Base + mask + local overlay layers (text, shapes, grade), with visibility, reorder, rename, merge. Generative *layer decomposition* stays a disabled plugin slot |
| Presets, reference sets, characters, palettes, saved prompts, JSON import/export | M3 | §0.8 |
| Cost estimate + usage log + CSV | M3 | §0.13 |
| Canvas | M4 | §7, minus the rows below |
| **Settings surface — new §6.17** | M0→M3 | Left-rail IA: API keys · Models · Defaults · Appearance · Storage · Spending · Privacy · Help · Experimental, with one table listing every setting, its `settings` key, its default and the section that specifies it. Eleven sections currently write requirements into a screen no section owns |
| **First run — new §2.10** | M0 | launch → no-key empty state → Keys → paste key → Check key → default model auto-selected → composer focused. G5/S1 gate on exactly this path |
| **Accessibility — new §2.11** | all | WCAG 2.2 AA contrast as a release gate with a CI check over the §2.2 token pairs; a keyboard path to every action on every surface including canvas (`Tab` cycles nodes in topological order, `⌥↑/↓` cycles ports, `Enter` connects); `aria-live="polite"` announcements for job start/complete/fail; reduced-motion coverage for the canvas and the §2.4 crossfade; an explicit, reasoned statement that the editor and canvas panes are out of scope for screen-reader parity |
| **i18n readiness (English only in v1) — new §2.12** | M1 | All user-facing strings in one catalogue, `packages/core/src/i18n/en.json` (§0.16), with no concatenation; dates and numbers through `Intl.DateTimeFormat`/`Intl.NumberFormat`; `currency` widened from the literal `"USD"` to `string`, with USD the only v1 value |

#### The nine edit tools — binding dispositions

| # | Tool | v1 | Form |
|---|---|---|---|
| 1 | Layer decomposition | **Disabled plugin slot** | Row visible, disabled, `Plugin` badge, "How to add this" link. Settings UI built. No launch adapter declares `ops.decomposeLayers` |
| 2 | **Edit text** | **Ships, M2** | `ops.detectText` on a configured multimodal model returns `{id,text,bbox}[]` under a strict JSON schema; editing a line issues an `edit`/`inpaint`. Disabled with a reason when no multimodal model is configured |
| 3 | **Expand & crop** | **Ships, M2** | Crop is local and lossless. Expand pads locally; *Fill with AI* needs `ops.outpaint` (OpenAI, mask-synthesised) or falls back to the regional path with the Approximate badge |
| 4 | **Upscale** | **Ships partially, M2** | **Local Lanczos ×2/×4 in v1**, labelled *"Resizes, adds no detail."* ×8/×16 and detail-adding upscale are a plugin/v1.1 adapter slot. No launch adapter declares `ops.upscale` |
| 5 | Remove background | **Disabled slot** | No launch adapter declares `ops.removeBackground`; a local ONNX (BiRefNet/rembg-class) plugin is documented as the reference implementation. **A disabled row with correct copy is the pass condition for M2-09** |
| 6 | **Colour grading** | **Ships, M2** | Local non-generative WebGL stack (exposure, contrast, temp/tint, saturation/vibrance, lift/gamma/gain, grain, bloom, halation, vignette), `.cube` import/export, Match reference by local 3D histogram matching. Cost $0.00, offline, every model. **Preset names must be Openfield's own** — the drafted list is the observed catalogue minus two entries and violates §1.11/R12 |
| 7 | **Enhancer** | **Ships, M2** | Instruction-edit presets compiled from widgets, best-effort label. Original preset names |
| 8 | **Relight** | **Ships, M2** | Direction sphere + quick-select + soft/hard + brightness + colour, compiled to a structured instruction edit, best-effort label |
| 9 | **Angles** | **Ships, M2** | Camera widget → instruction edit; the panel states plainly this is a re-render, not a 3D reprojection |

§6.10's cell "None exist in v1; the rows are absent, not broken" is factually wrong and is rewritten to the table above.

#### Deferred to v1.1 (binding)

| Item | Why |
|---|---|
| Canvas **AI text `text.llm`** and **Table** nodes | A runnable LLM node makes a text-model key a *canvas* dependency; §1.10 and the locked "image-only v1" say no. Both are hidden from the add-node menu in v1 and marked v1.1 in the §7.5 catalogue table. The `AI text ~$0.01` line is deleted from §7.7's cost-preview example. **The fan-out mechanism itself stays in v1** — Variations needs it |
| Canvas **Upscale node** | Latent: appears only when an adapter advertises `ops.upscale`; none does at launch. Out of M4's DoD |
| Video / Voice / Page nodes, Ask Agent, comments, chat, multiplayer | §1.5, §7.11 |
| fal.ai and Replicate adapters | Locked decision |
| Detail-adding upscale, layer decomposition, background removal | Plugin/adapter slots, above |
| C2PA signing, identity fine-tuning, semantic search | Noted, not promised |

#### Dropped entirely

Explore/publish/social, Share-to-network, comments on assets, credits and free-gen counters, team workspaces, Clerk auth, "Turn to video" (v1 slot reserved, absent not disabled), the reference product's Featured/All grouping and its marketing surfaces.

#### Consequent corrections to §8.7 and §8.8

- **§8.8 rows rewritten:** 6 (Recreate/Reuse/Use as reference per §0.1) · 13 (✅ M1 local enhancer) · 18 (⚠️ substituted — local tips card) · 19 (Recent/by company/Needs a key) · 36 (✅ M2) · 37 (✅ M2, local WebGL) · 38 (✅ M2, widget-compiled) · 39 (✅ M2, LAYERS) · 42 (✅ M1, `@` over Openfield objects) · 43 (four starter templates) · 50 (❌ Video/Voice/Page; Table and AI text v1.1).
- **Templates:** four, authored by us — **From a reference**, **Image edit**, **Storyboard (4 panels)**, **Compare styles**, bundled in `apps/server/seed/templates/`. *Upscale pass* is dropped until an adapter advertises `ops.upscale`. M4-14 and row 43 are corrected from "Three templates".
- **M2 DoD is rewritten to be falsifiable:** *"Edit performs whole-image instruction edit on both launch providers; masked inpaint and mask-synthesised outpaint on OpenAI GPT Image once the live mask probe confirms polarity; the regional fallback on Gemini with the Approximate badge; Upscale ships as local Lanczos resample only, labelled 'Resizes, adds no detail'; Remove background renders disabled with its reason. No launch adapter declares `ops.upscale` or `ops.removeBackground`, so a disabled row with correct copy is the pass condition for M2-08 and M2-09."*
- **Tasks added:** `M1-16` prompt-enhance service (text-model registry entry, server-side rewrite endpoint, diff sheet, preview/auto modes, `prompt_original` persistence, usage-log line) · `M1-17` `@`-mention typeahead + server-side token resolution · `M2-13a` metadata-writer spike (blocking) · `M2-15` live probe of OpenAI `/v1/images/edits` mask polarity, dimensions and format, fixture recorded, §6.14 note updated (**blocking prerequisite for M2-05/M2-06**) · `M2-16` colour-grading WebGL stage · `M2-17` layers panel · `M2-18` text-detect edit · `M2-19` relight/angles/enhancer widgets · `M4-16` fingerprint + dirty propagation + result cache + `⌥`-click bypass · `M4-17` fan-out map semantics, `×k` badge, labelled result grid, 32-job confirmation rail · `M4-18` run-all cost-preview popover · `M4-19` Edit/Inpaint node + mask editor modal · `M4-20` Preset node + merge precedence and lock glyphs · `M4-21` Variations node (seed-jitter / prompt-list / model-list).
- **Resolved open questions are deleted, not restated:** every "Recreate vs Reuse vs Regenerate" bullet (§1.12, §2.10, §3.9, §4.11, §6.17, §8.10, Appendix A ×5), every "section numbering is assumed" bullet (§2.10, Appendix A §2 and §8), the zoom-step bullets in §2.10/§8.10/Appendix A, the "feed page size 60" half of §8.10's paging bullet, and §8.10's "is their Colour Grading generative or local" bullet (we ship local regardless, so the question does not gate anything). Genuinely open items — OpenAI mask polarity, OpenAI `usage` block, OpenAI reference cap, Gemini seed support, Higgsfield public API reach, output-token counts — stay, and each names the milestone task that closes it.

---

### 0.15 Voice and UI copy

Every word a person sees in Openfield follows this section, including every quoted UI string in this document. If an older string anywhere else disagrees, this section wins.

**Voice.** Write for someone making images, not for someone reading the code. Say what happened, then what they can do. Keep it short, plain and human. Use active voice and sentence case, and no exclamation marks. One idea per sentence. If a sentence runs long, split it.

**Hard rules**
- No em dashes in UI text. Use a period, a comma or a colon, or write two sentences. An empty value shows "None", not a dash.
- No internal terms (see the word list). If a word only makes sense to someone who has read the code, rewrite it.
- No filler ("simply", "just", "to get started", "here"), no stacked hedges, no marketing tone. No roadmap talk ("coming soon", "Soon", "v1.1"). Anything that hasn't shipped is hidden, not teased.
- Keep every fact that protects the person, and say it like a person: "Canceled. You may still be charged for work that already started."
- Buttons are verbs or short noun phrases: "Try again", "Add a key", "Change key", "Free up space".
- A failed action always offers "Try again", never "Retry". "Retrying" is fine as status text while Openfield tries again on its own.
- Small caps labels are written in sentence case in the source and uppercased with CSS.

**Words.** One word per concept.

| We say | We never say |
|---|---|
| image (Assets stays as the nav and library name) | output, generation, gen |
| model, or the company's name (OpenAI, Google) | provider, provider API, adapter, endpoint |
| key | token, credential |
| run (one press of Generate or Run) | job, job set, request batch, fan-out |
| settings | params, parameters, config, manifest, schema, capability |
| Avoid (the field for things to leave out) | negative prompt, polarity |
| edit an area, mask | inpaint, regional fallback |
| on your computer | ~/.openfield, 0600, env vars in prose, any file path |
| preset, character, folder, reference | fingerprint, idempotency, normalize, seed jitter |

"Company" appears only where the person has to pick or identify who holds a key (Settings, the Info row, model picker groups). "Seed" appears only as the label of the Seed control itself.

**Errors** say what happened, then what to do, in at most two short sentences. The button carries the fix: "This key was rejected." with **Change key**. "Couldn't save. Your disk is full." with **Free up space**. Never blame the person, and never put a raw error code in the message. Codes live in the Error log (Settings → Help).

**Costs.** Estimates read "About $0.16", and ranges read "About $0.12–0.19". Where space is tight (chips, node pills, table cells), use "~$0.16". Never use "est.", "≈" or "estimate". Billed amounts show plainly ("$0.134"). An unknown price reads "Cost unknown", and local tools that cost nothing say "Free". Only the raw numbers (prices, counts, sizes, durations) use the mono font. The words around them don't. Dates follow the person's locale ("Sep 23, 2026"), never ISO.

| Do | Don't |
|---|---|
| This key is out of credit. | No credit available on this key |
| Too many requests. Retrying in 8s | Provider rate limit, retrying |
| Couldn't connect. | Couldn't reach the provider |
| Each image is made and billed separately. | Sent as 4 separate requests, cost scales linearly |
| About $0.27 · 2 images | ≈ $0.27 · 2 images |
| Limited controls. Couldn't load this model's settings. | This model's manifest could not be read |

---

### 0.16 Codebase and stack

This subsection is binding like the rest of §0. The paths, package names and import rules below are the only ones. A section that names a different path is wrong until someone edits it.

**Decision.** Openfield is one Bun workspaces monorepo with two apps and four packages. The web app is a Vite + React SPA. The server is Hono on the Bun runtime. The database is SQLite through Drizzle ORM on `bun:sqlite`. The browser calls the server through Hono RPC. Next.js, tRPC and Prisma were considered and rejected. Openfield is a local, single-user app with a long-running server (queue, crash recovery, SSE, filesystem, SQLite). That fits Hono on Bun, gets nothing from server rendering, and should ship as one fast process that a desktop wrapper can later host. Hono RPC gives end-to-end types over plain JSON routes that curl can still call, where tRPC would add its own procedure protocol. Drizzle keeps the schema in TypeScript and the migrations as reviewable SQL on `bun:sqlite`, where Prisma would add a separate schema language and a code-generation step.

```
openfield/
├── apps/
│   ├── web/            @openfield/web
│   └── server/         @openfield/server
├── packages/
│   ├── core/           @openfield/core
│   ├── providers/      @openfield/providers
│   ├── db/             @openfield/db
│   └── ui/             @openfield/ui
├── e2e/                Playwright suites (M0-15, M1-15)
├── package.json        workspaces ["apps/*", "packages/*"] and the root scripts
├── tsconfig.base.json  strict, extended by every workspace
└── biome.json          format, lint and the import rules below
```

Internal packages are consumed as TypeScript source. Each `package.json` `exports` map points at `.ts` files, Vite and Bun compile them, and no package has a build step. The entries are: `@openfield/core` (root) plus `/constants`, `/schemas`, `/canvas` and `/i18n`; `@openfield/providers/manifest` and `/server` (no root, rule 3); `@openfield/db` (root); `@openfield/ui` (root); and `@openfield/server/app-type` (type only, rule 1). Workspace dependencies use `"workspace:*"`. Turborepo is added only if builds get slow, and nothing below depends on it.

#### Packages

| Workspace | Owns | May import (workspace) | Main external deps |
|---|---|---|---|
| `apps/web` | The SPA: routing (React Router), every screen in §2 to §5, the canvas (§7: React Flow nodes, `<NodeShell>`, DAG compiler, fingerprints, dirty propagation), server state through TanStack Query, the `hc` client, the SSE consumer | `@openfield/core`, `@openfield/ui`, `@openfield/providers/manifest`, and `import type { AppType } from "@openfield/server/app-type"` | `react`, `react-router`, `@tanstack/react-query`, `@xyflow/react`, `zustand` (canvas stores, §7.10), `hono/client`, `vite`, `tailwindcss` |
| `apps/server` | The Hono app on Bun: the four guards (§0.6), every route in §8.3, the job runner and scheduler (§8.4), crash recovery, the SSE hub, ingest, thumbnails and export (§8.5), the file store under `OPENFIELD_HOME` (§8.1), `config.json` and keys (§6.11), seeding, serving the built SPA | `@openfield/core`, `@openfield/db`, `@openfield/providers/server`, `@openfield/providers/manifest` | `hono`, `@hono/zod-validator`, `sharp` (§8.5.2) |
| `packages/providers` | The `Provider`, `ImageModel` and other behaviour interfaces (§6.2), the registry, request normalization (`normalize()`), the pure `estimate()` and `resolveControl()`, one folder per adapter, the conformance suite | `@openfield/core` | none (`fetch` comes from `CallContext`, §6.2) |
| `packages/core` | Every zod schema, and the type inferred from it, for data that crosses a boundary: HTTP request and response bodies, SSE event payloads, the error envelope, manifest data (`Capabilities`, `ModelManifest`, `PriceModel`), `GenerateRequest` and `NormalizedRequest`, settings (§6.17 keys and defaults), preset envelopes (§5.3), the canvas document (§7.8) and its document migrations. Also the enum constants (§0.4, §0.5 and every CHECK list), ULIDs, `hashCanonical()` (§0.11), and the i18n catalogue with `t()` | none | `zod` (v4), `ulid` |
| `packages/db` | The Drizzle schema, the single source of truth for every table (§8.2), drizzle-kit migrations, drizzle-zod row schemas, `openDb()` with migrate-on-boot, typed query helpers (§8.2.2) | `@openfield/core` | `drizzle-orm`, `drizzle-zod`, `drizzle-kit` (dev) |
| `packages/ui` | Design tokens (`--of-*`, §2.2) and the Tailwind theme, shadcn/ui primitives restyled to the tokens, and the presentational components shared across surfaces (chips, popovers, stepper, tiles, badges, `<PickerSheet>`, icons). Props in, events out: no data fetching, no routing, no API client, no React Flow | `@openfield/core` (types and `t()` only) | `react`, `tailwindcss`, Radix primitives via shadcn/ui |

#### Dependency rules

1. **No package imports an app.** The only edge between apps is the type-only import of `AppType` by `apps/web` from `@openfield/server/app-type`. That entry file exports the type and nothing else, and the import is erased at build. `apps/web/tsconfig.json` adds `bun-types` so the server's type graph checks. Rule 2's bundle check proves none of it ships.
2. **The browser never loads server code.** `apps/web` and `packages/ui` never import `@openfield/db`, `@openfield/providers/server`, an adapter folder, a `bun:` or `node:` module, or anything that reads `config.json`, env vars or keys.
3. **`packages/providers` splits at its exports.** It has no root export.
   - `@openfield/providers/manifest` (`src/manifest.ts`) is the browser-safe entry. It holds the manifest types re-exported from core, `estimate()` and `resolveControl()`, and imports only `@openfield/core` and files under `src/manifest/`.
   - `@openfield/providers/server` (`src/server.ts`) is the server entry. It holds the registry and `builtinProviders`, `normalize()`, the adapters, the `mapError` helpers and the behaviour interfaces.
   - An adapter imports only `../types`, its own folder and `@openfield/core`, and never another adapter.
4. **`packages/db` is server-only.** Only `apps/server` imports it. SQL lives only inside `packages/db` (schema, migrations, `src/queries/`), and routes call query helpers.
5. **`packages/core` is a leaf.** It depends only on `zod` and `ulid`, and uses no DOM API and no Bun API, so the same file runs in the browser, in the server and under `bun test`.

Enforcement has three parts:
- Each `package.json` declares exactly the workspace dependencies in the table.
- `biome.json` encodes rules 1 to 5 as per-folder `noRestrictedImports` overrides.
- CI builds `apps/web` and fails if the bundle contains a module from `packages/db`, `packages/providers/src/server.ts` or an adapter folder, or any `bun:` specifier. The S5 secret scan runs over the same bundle.

#### Type flow

```
packages/db     src/schema/*.ts (Drizzle) ── drizzle-kit generate ──▶ migrations/*.sql
                      │ drizzle-zod
                      ▼
                src/rows.ts: row schemas and types (AssetRow, NewJobSetRow, …)
                      │ apps/server/src/mappers/: row → wire shape, one mapper per resource
                      ▼
packages/core   src/schemas/: request and response bodies, SSE payloads, settings, manifest, canvas
                      │ @hono/zod-validator (json, query, param, form)
                      ▼
apps/server     src/routes/*.ts ─▶ src/app.ts: export type AppType
                      │ import type
                      ▼
apps/web        src/api/client.ts: hc<AppType>() ─▶ TanStack Query hooks
```

- **One declaration per shape.** A type that crosses a boundary as data (HTTP, SSE, a JSON column, a file on disk, the browser bundle) is declared once, as a zod schema in `packages/core/src/schemas/`. Its TypeScript type is `z.infer` of that schema. A type that carries behaviour (functions, `AbortSignal`, streams) is a hand-written interface in the package that owns the behaviour. §6's code blocks stay the normative shapes, and §6 names the file each type lives in.
- **Rows are not wire shapes.** Core never imports db. Each resource maps rows to core shapes with a mapper typed like `(row: AssetRow) => Asset`, so renaming a column breaks the build at the mapper, not in the browser. Handlers return `c.json(value satisfies <CoreType>, status)`, and that return type is what `hc` infers.
- **Manifests** are validated by `modelManifestSchema` from core in three places: adapter static catalogs (conformance test 1), `~/.openfield/models.json` and `prices.json` when they load, and the `models.capabilities` column through a drizzle-zod override.
- **Canvas documents** are validated by `canvasDocumentSchema` from core:
  - in the browser: edit, import, save as template;
  - in the server: `PATCH /api/canvases/:id`, template seeding;
  - in a unit test over the bundled templates.
  The §7.11 node catalogue manifest and JSON Schema are generated from the same schema.
- **Enums** are `as const` arrays in `packages/core/src/constants.ts`. The zod enums, the Drizzle `text({ enum })` column types and the SQL CHECK lists (§8.2) are all built from them, so a value can't exist in one and be missing from another.
- **Settings** use `settingsSchema`, which lists every §6.17 key with its default. `GET` and `PATCH /api/settings` validate against it, and the `settings` table stores each key's JSON value.

#### Where things live

| Thing | Path |
|---|---|
| Drizzle schema, one file per domain | `packages/db/src/schema/` (`providers.ts`, `jobs.ts`, `assets.ts`, `organisation.ts`, `library.ts`, `canvas.ts`, `usage.ts`) |
| Migrations, generated and custom, with drizzle-kit's journal | `packages/db/migrations/` (config: `packages/db/drizzle.config.ts`) |
| Row schemas · query helpers · schema check | `packages/db/src/rows.ts` · `packages/db/src/queries/` · `packages/db/test/schema.test.ts` |
| Wire schemas (API, SSE, errors, settings, manifest, request, cost, preset envelopes) | `packages/core/src/schemas/` |
| Enum constants | `packages/core/src/constants.ts` |
| Canvas document schema and document migrations (R14) | `packages/core/src/canvas/` |
| i18n catalogue and `t()` (§2.12) | `packages/core/src/i18n/en.json`, `packages/core/src/i18n/index.ts` |
| Behaviour interfaces · registry | `packages/providers/src/types/` · `packages/providers/src/registry.ts` |
| One adapter (§6.12) | `packages/providers/src/<name>/` (the names `types` and `manifest` are reserved) |
| Recorded fixtures | `packages/providers/src/<name>/__fixtures__/` |
| Conformance suite | `packages/providers/conformance/` |
| Routes · app composition and `AppType` · the type-only `@openfield/server/app-type` entry · boot | `apps/server/src/routes/<resource>.ts` · `apps/server/src/app.ts` · `apps/server/src/app-type.ts` · `apps/server/src/index.ts` |
| Runner and scheduler · SSE hub · ingest, thumbnails, export | `apps/server/src/runner/` · `apps/server/src/events/` · `apps/server/src/files/` |
| Bundled presets (12) and palettes (8) | `apps/server/seed/presets/`, `apps/server/seed/palettes/` |
| Bundled canvas templates (4) | `apps/server/seed/templates/*.ofcanvas.json` |
| User-saved canvas templates | `~/.openfield/canvases/templates/` |
| Typed client · query hooks · raw-HTTP and SSE helpers | `apps/web/src/api/client.ts` · `apps/web/src/api/hooks/` · `apps/web/src/api/raw.ts` |
| Canvas UI and engine | `apps/web/src/canvas/` |
| Tokens, Tailwind theme, primitives | `packages/ui/src/` |

#### Root scripts

| Command | Does |
|---|---|
| `bun install` | Installs every workspace. There is no postinstall build, and a `sharp` binary that fails to load never fails the install or the boot (§8.5.2) |
| `bun dev` | Starts `apps/server` (watch mode, `127.0.0.1:4317`) and `apps/web` (Vite, `127.0.0.1:5173`, `strictPort`) together, and stops both on exit. Open `http://127.0.0.1:4317`. In dev the server proxies every path outside `/api` and `/files` to Vite and injects the session token into `index.html`, and Vite's HMR socket connects to 5173 directly. The app has one origin, so the four guards (§0.6) behave the same in dev and production |
| `bun run typecheck` | Type-checks every workspace by running each workspace's own `tsc` |
| `bun run build` | Runs `bun run typecheck`, then the Vite build of `apps/web` to `apps/web/dist` |
| `bun start` | Runs `apps/server` in production mode. It serves `apps/web/dist` and injects the token into `index.html` |
| `bun run db:generate` | Runs `drizzle-kit generate` in `packages/db` after a schema edit. The new SQL file is committed together with the schema change. `bun run db:generate --custom --name=<name>` creates an empty hand-written migration |
| `bun test` | Runs Bun's test runner across all workspaces: unit tests, the db schema check (§8.2.1) and the conformance suite in offline mode |
| `bun run lint` · `bun run e2e` | Biome over the repo · the Playwright suites in `e2e/` |

S1's three commands (`bun install`, `bun dev`, open the URL) are exactly the first two rows plus the URL `bun dev` prints.

---
## 1. Overview, goals and users

### 1.1 Product summary

**Openfield** is an open-source, local-first, bring-your-own-key image generation workspace. It reproduces the *workflow* of Higgsfield's Image tab and its node canvas — the floating **Composer** with capability-driven setting chips, the edge-to-edge justified-row **feed**, the hover actions on every tile, the **detail view** with its Info / Edit / History panel, the model picker, the preset / character / palette picker sheets, and the node canvas — on top of provider APIs the user pays for directly.

It runs from `git clone` + `bun`. A Bun/Hono server binds to `127.0.0.1` only; there is no account, no login, no hosted component. Generated images are ordinary files under `~/.openfield`, with metadata and lineage in SQLite. API keys live in a `0600` config file (env vars override) and are used exclusively server-side, so no provider key ever reaches browser JavaScript. Providers are typed TypeScript adapters that publish a per-model **capability manifest** (shape in §0.3, interface in §6.3); one resolver renders every control from it, hiding what a model cannot do and disabling the core chips with a reason instead of lying about them — the same per-model behaviour recorded in the walkthrough, where the reference product's GPT Image 2 shows `Aspect · Quality · Resolution · Background · 1/4` while its Nano Banana Pro shows only `Aspect · Quality(=resolution) · 1/4`. Openfield's equivalent manifests render `openai:gpt-image-2` as `Aspect · Quality · Resolution · Background · Advanced · 1/4` and `google:gemini-3-pro-image` as `Aspect · Resolution · Advanced · 1/4` (§3.7), because Gemini exposes no separate quality axis (§6.13).

Launch adapters are **Google Gemini image** (shown in the UI by Google's Nano Banana names: *Nano Banana Pro*, *Nano Banana 2*, *Nano Banana 2 Lite*; the Gemini API ids stay in the model keys, §6.13) and **OpenAI GPT Image**, plus a **Higgsfield adapter** if and only if its public API exposes presets and characters to a user-supplied key. fal.ai and Replicate are designed for but shipped in v1.1. v1 is image-only; the job and asset model is modality-agnostic so video slots in without a migration. Licence MIT. No telemetry, ever.

### 1.2 The problem

The workflow Higgsfield built for image work is genuinely good — measured in detail in the walkthrough notes — and it is only available as SaaS:

- **Credit-metered, not cost-metered.** Every actionable control carries a credit number: the Generate button (`Generate ✦ 3`, `8.5 → 6.5`, `4307 free gens left`), every edit-tool CTA (`Upscale · 3`, `Enhance · 4`, `Separate layer · 12`, `Generate · 0.2`), every canvas node run pill (`✦ 6.5`). Credits are an opaque unit bought at a markup over the underlying model price, they expire with the plan, and the cost table (`GET /fnf/job-sets/costs`) is the vendor's, not yours.
- **Cloud-stored by default.** Your library is a server-side feed (`GET /fnf/jobs/accessible`), served through an image-resizing proxy. Folders, favourites and canvases are rows in someone else's database; canvases are even the same backing entity as asset folders. Nothing is on your disk unless you download it one file at a time.
- **Account-gated and social by construction.** Login is mandatory (Clerk). The shell is built around Explore, publishing, comments on assets, share-to-network menus, team workspaces and multiplayer canvas cursors — surface area a single person working locally does not want and cannot switch off.
- **Locked to one vendor's model shelf.** The model list is curated by the vendor, prices and "UNLIMITED" badges move without notice, and models can disappear. You cannot point the same UI at a key you already hold.
- **No escape hatch.** There is no self-host option, no export of the workflow, no way to add the provider you actually use.

### 1.3 The Openfield answer

| Higgsfield constraint | Openfield |
|---|---|
| Credits at a markup | Direct provider billing; a per-run **USD cost estimate** on the Generate button and every run action, plus a usage log with CSV export (§6.9) |
| Cloud library behind a proxy | Plain files under `~/.openfield/assets` and `~/.openfield/uploads`, SQLite for metadata and lineage, a local thumbnail cache in `~/.openfield/thumbs` (§8.1) |
| Mandatory account, social feed | No auth, no accounts, no Explore, no publish, no comments, no share targets |
| Vendor-curated model shelf | Model **registry** carried by the adapters, plus allow-listed runtime discovery where a provider API supports it (§0.3); no hardcoded model names in the UI |
| Proprietary Soul presets / Soul ID / Soul HEX | Our own open substitutes — preset, reference set, character and palette objects (§1.6, specified in §5) |
| Topaz upscale, proprietary edit tools | **Capability slots**: a tool renders only when a manifest declares the matching `ops.*` capability; otherwise it renders disabled with a reason (§6.3) |
| Closed | MIT, typed `Provider` interface, adapter conformance suite (§6) |

### 1.4 Goals

**G1 — Workflow parity.** A user who works in Higgsfield's Image tab daily can work in Openfield without relearning anything: same layout skeleton, same control inventory, same hover affordances, same flow from prompt → feed → detail → iterate. Parity is measured against the observed walkthrough at a 1440×900 baseline (desktop-first ≥1280px, usable down to tablet width), by the criterion §0.3 fixes.

**G2 — Keys and files stay yours.** All provider calls are server-side. Keys are never returned to the browser, never logged, never sent anywhere but the provider. Every generated pixel lands on local disk before it is shown.

**G3 — Real cost, always visible.** Wherever Higgsfield prints a credit number, Openfield prints an estimated USD number computed locally from the model manifest, shown with an *About* prefix; every terminal job — success, failure or cancel — appends a row to a usage log the user can inspect and export (§6.9).

**G4 — Capability-driven UI, not per-model branching.** The renderer reads the manifest through one resolver (§0.3); adding a model never means editing a component.

**G5 — Five-minute clone-to-first-image.** Clone, install, paste one key in Settings, type a prompt, generate — the first-run path in §2.10.

**G6 — Contributable.** A new provider is a self-contained adapter directory plus one registry line, validated by a shared conformance suite. No core, UI or schema changes.

**G7 — Modality-agnostic bones.** Jobs, job sets, assets and lineage carry a `modality` from day one so video is additive.

### 1.5 Non-goals (v1)

- **No accounts, auth, sessions or multi-user.** Single user, loopback only.
- **No hosting, no deploy target, no SaaS story.** If you expose it to a network, that is your call and your risk.
- **No Explore, publish, social feed, likes-from-others, comments, or share-to-network menus.** The Comments tab observed in their detail overlay is not built; our third tab is History (§0.14). "Favourite" exists, but as a local flag only.
- **No credits system, no wallet, no in-app purchase, no plan tiers.** Costs are estimates over the user's own provider spend.
- **No team collaboration**: no workspaces, no invites, no share dialog, no multiplayer cursors, no per-canvas chat, no role model.
- **No telemetry, analytics, crash reporting or update pings.**
- **No bundled model weights and no local inference engine** in v1 (see §1.10 Later).
- **No scraping, reverse-engineering or use of Higgsfield's private endpoints**, and no use of their brand assets or marketing copy (§1.11).
- **No mobile-first layout.** Tablet width is a graceful degradation, not a design target.

### 1.6 Open substitutes for proprietary pieces

Stated here at product level. The objects and their pickers are specified in §5, the capability slots in §6.3 against the manifest of §0.3, the canvas in §7, and cost in §6.9.

| Higgsfield feature (observed) | Openfield substitute |
|---|---|
| Soul style presets — a 33-item curated style grid (their names are in the research notes only) | **Preset library** (§5): a preset is a prompt template with one `{prompt}` slot + optional reference images + optional per-model parameter overrides, stored in SQLite, user-editable, importable/exportable as JSON. We ship 12 bundled presets with our own names and copy. |
| Soul ID Character (trained identity) | **Character** (§5): a named reference set + descriptor fragment + optional pinned seed, passed as reference images to any model whose manifest declares `references.supported`, truncated to `references.max`. Real identity training is a v1.1 adapter capability (e.g. Replicate fine-tune), not a v1 promise. |
| Soul HEX / Color Transfer palette grid | **Palette** (§5): user reference image + locally extracted swatch strip + injection mode (prompt / reference / both); 8 bundled palettes, ours. |
| Topaz upscale, Remove background, Relight, Angles, Enhancer, Layer decomposition, Edit text | **Capability slots** keyed to `ops.upscale`, `ops.removeBackground`, `ops.imageEdit`, `ops.inpaint`, `ops.detectText`, `ops.decomposeLayers` (§0.3, bound to controls by §6.3). A slot no installed adapter declares renders disabled with a reason and a "How to add this" link, never silently absent. Which of them ship in v1, and in what form, is §0.14's table — mirrored in §1.10. |
| Moodboard builder | A folder of references promoted to a **reference set** (§5); no separate trainer. |
| Cinematic Cameras / camera + lens wheels | A preset category with camera/lens prompt fragments, under our own names; no proprietary model. |
| Credit cost labels | USD estimate computed locally from the manifest price table (§6.9), labelled with an *About* prefix (`~` where space is tight) and a tooltip naming the `pricedAt` snapshot date; "Cost unknown" where a provider publishes no per-image price. |
| "Ask Agent" canvas assistant | Optional, BYOK text model, v1.1. The canvas itself is fully in v1 (§7). |

### 1.7 Target users

**Mara — the working image-maker.** Uses Higgsfield's Image tab several hours a week for client mood work and social assets. Cares about muscle memory, about not losing a 200-image project to a plan change, and about handing a client a folder rather than a link. Wants the same feed, the same hover actions, the same detail panel — with the files on her own drive.

**Ivo — the BYOK power user.** Already holds Google and OpenAI keys and reads provider pricing pages for fun. Refuses to pay credit markups. Wants to switch models mid-flow without losing his prompt, see what a batch of 4 at 4K will actually cost before he clicks, and grep his own SQLite when he wants a report.

**Sam — the OSS contributor.** Uses a provider Openfield does not ship. Wants to read one interface file, copy an existing adapter directory, implement the typed model interface (§6.3), write a capability manifest, run `bun test` against the shared conformance suite, and open a PR that touches nothing else.

### 1.8 Top user stories

1. **Generate from a prompt.** As a creator, I type a prompt in the Composer, set model / aspect / quality / batch on the chip row, and press Generate — so that N placeholder tiles appear immediately at the head of the feed with the correct aspect ratio, my prompt and settings are **not** cleared, and I can queue another run while the first is still running.
2. **Steer with references.** As a creator, I attach reference images via the `+` button (or drop them on the Composer, or send an existing result back in as a reference) — so that a model that supports references uses them, and a model that does not tells me so instead of silently ignoring them.
3. **Browse and search history.** As a creator, I scroll one unified, virtualized feed of everything I have ever generated — newest first, across all models, not filtered to the current one — and filter or search it by prompt text, model, folder, favourite and date.
4. **Iterate on a result.** As a creator, I open a tile and, from the detail view, **Recreate** it from its frozen request, **Reuse** its prompt and settings in the Composer, **Use it as a reference**, or edit it (instruction edit, regional edit, masked edit) — so that each iteration is a new asset with recorded **lineage** back to its parent (§0.1, §0.9).
5. **Organise.** As a creator, I favourite a tile, add it to a folder from the tile's More menu or by multi-select, and browse a Library grouped by date with per-group select — so that finished work is separable from experiments.
6. **Reuse presets.** As a creator, I save the current prompt + settings + references as a named preset, apply it later in one click from the picker sheet, and export/import presets as JSON to share them.
7. **Switch models mid-flow.** As a power user, I change the model chip and my prompt and references survive; settings the new model supports carry over, settings it does not are dropped with a visible note, and the controls re-render from the new model's manifest.
8. **Track spend.** As a power user, I see an *About $* estimate on the Generate button and on every run action before I click, and a usage log afterwards showing per-job model, parameters, images produced and estimated cost, with CSV export (§6.9).
9. **Compose a repeatable workflow on canvas.** As a power user, I open a canvas, drop Prompt / Image Generator / Upload / Assets nodes, wire a text output into a prompt input and an image output into an image input, run a node or the graph, and reopen the canvas later with everything persisted — so that a workflow I invented once becomes a workflow I rerun with new inputs (§7).
10. **Set up in minutes.** As a new user, I clone, run one command, paste one key into Settings, and generate — without creating an account or editing a config file by hand.
11. **Add a provider.** As a contributor, I add an adapter directory implementing the typed interface plus a capability manifest, register it in one place, and both the model picker and the whole settings UI pick it up with no other code change.

### 1.9 Success criteria

Openfield is an OSS project, not a funnel; the metrics are about the artifact, not about users we track (we track none). These are measured by maintainers on releases, not collected from installs.

| # | Criterion | Target at v1 | How it is measured |
|---|---|---|---|
| S1 | **Time to first image** after `git clone` on a clean machine with one provider key in hand | ≤ 5 minutes, ≤ 3 commands (`bun install`, `bun dev`, open the URL), zero manual file editing | Timed fresh-machine run over the §2.10 first-run path, scripted in CI on macOS + Linux, recorded in the README |
| S2 | **Parity checklist coverage** against the observed Image tab + Canvas inventory | 100% of rows marked *must*, ≥ 70% of rows marked *should*, every *won't* row annotated with the reason (social / proprietary / team) | The checklist file in the repo (§8.8), derived one-for-one from the walkthrough notes. It records parity; it is subordinate to the §0.14 scope contract and cannot cancel a feature a feature section specifies |
| S3 | **Contributor-added adapter with no core changes** | A new provider PR touches only `packages/providers/src/<name>/**` plus one line in `packages/providers/src/registry.ts`; 0 files changed under `apps/**`, `packages/core/**`, `packages/db/**` or `packages/ui/**` | CI path-check on PRs labelled `adapter`, plus the shared adapter conformance suite passing against recorded fixtures |
| S4 | **Capability honesty** | 0 controls rendered that the selected model cannot honour, **except the core set** (Model, Aspect, Resolution/Quality, Images, Seed), which renders disabled with a tooltip naming the model when a capability is explicitly unsupported — a disabled Seed chip is a deliberate pass, not a failure (§0.3) | Automated check: resolve every registered manifest through `resolveControl`, assert the rendered control set ⊆ manifest capabilities ∪ the disabled core set, and that every disabled control carries a reason string |
| S5 | **Key containment** | 0 occurrences of any provider key in the client bundle, in any HTTP response body, or in logs | Automated secret-scan over the built bundle and over a captured full-session HAR in CI |
| S6 | **Local performance** | Feed first paint ≤ 500 ms and smooth scrolling with 5,000 assets; server cold start ≤ 2 s | Seeded benchmark fixture, run in CI |
| S7 | **Cost accuracy** | Estimated vs. actual provider spend within ±10% over a 50-generation sample | Manual reconciliation against a provider invoice at each release; deviations update the price snapshot. Reconciliation needs a provider usage block, which is **unconfirmed for OpenAI** (§0.13), so S7 is measured only against providers that publish per-image prices and report usage; everything else is reported `~` and excluded from the gate |
| S8 | **Data portability** | A user can delete Openfield and still have every image, with prompts recoverable | `~/.openfield` contains original files plus a sidecar/DB export; verified by an export-and-reimport test |

### 1.10 Scope

This table is the product-level view of the §0.14 scope contract and agrees with it row for row. Where a feature section and a checklist disagree, §0.14 decides.

| Area | v1 | v1.1 | Later |
|---|---|---|---|
| **Image generation** | Composer + chip row, batch 1–4, aspect / resolution / quality / background per manifest, negative prompt, references, seed (core chip — rendered disabled with a reason on models declaring no seed support, §0.11), Advanced chip rendering the manifest's `extraSchema`, **local prompt enhance** (M1, off by default, disabled with "Add an OpenAI or Google key to use this" when no text-capable key exists) | Queue management (reorder, pause) | — |
| **Providers** | Google Gemini image, OpenAI GPT Image, Higgsfield (conditional on its public API exposing presets/characters to a user key) | fal.ai, Replicate (schema-discovered), OpenRouter-style aggregators | Local inference bridge (ComfyUI/InvokeAI/Diffusers), on-device models |
| **History & library** | Unified justified-row feed with the 5-step zoom ladder (§0.10), multi-select, hover actions, folders, favourites, prompt search/filter, date-grouped Library view | Saved smart filters; bulk export; tags | Semantic / image-similarity search |
| **Detail & editing** | Detail view (Info · Edit · History tabs, keyboard next/prev), version strip, model-native instruction edit, regional/masked edit with the Approximate badge on the emulated path (§0.9), expand & crop (crop local; Fill with AI via `ops.outpaint` or the regional fallback), **local colour grading** (non-generative WebGL stack, `.cube` import/export, our own preset names), **Edit text** (vision text-detect → instruction/masked edit), relight / angles / enhancer widgets compiled to instruction edits, layers panel, **upscale = local Lanczos ×2/×4** labelled "Resizes, adds no detail". **Remove background** and **layer decomposition** ship as visible disabled slots with a `Plugin` badge | Detail-adding upscale (×8/×16) and background removal filled by an adapter or plugin | Generative layer decomposition |
| **Presets** | Preset library (12 bundled), reference sets, characters, palettes (8 bundled), saved prompts, `@`-mention typeahead and `/` snippets over Openfield objects, JSON import/export (§5) | Preset sharing index; per-model preset mapping | Identity fine-tuning (LoRA) via provider adapters |
| **Canvas** | Full spec in v1 (§7): infinite canvas, Prompt / Image Generator / Edit image / Variations / Preset / Upload / Assets / Note / Frame nodes, plus Shape and Text annotations from the toolbar (§7.4), typed ports, compatibility-filtered connect menu, per-node run, autosave, zoom & minimap, toolbar, four starter templates. **Note, Frame, Shape and Text are annotation-only; a runnable AI text node is v1.1** | AI text and Table nodes, Upscale node (latent until an adapter declares `ops.upscale`), video/audio nodes, shared template index, agent-authored graphs (BYOK text model), group/frame operations | Scheduled or batch graph runs; parameter sweeps |
| **Cost** | Per-run USD estimate computed locally from the manifest, usage log over every terminal outcome, CSV export (§6.9) | Budget ceilings and warnings; per-folder/project cost roll-up | — |
| **Modality** | Image only (schema modality-agnostic) | Video generation tab reusing the same job/asset model | Audio, 3D |
| **Platform** | Local bun server on 127.0.0.1, SQLite + files, first-run key flow (§2.10), Settings surface (§6.17), WCAG 2.2 AA contrast gate (§2.11), English-only i18n readiness — one `en.json`, `Intl` formatting (§2.12) | Optional packaged desktop build | Optional encrypted sync between the user's own machines |
| **Explicitly never** | Accounts, hosted SaaS, Explore / publish / social feed, share-to-network menus, comments on assets, credits and free-gen counters, team workspaces and multiplayer, telemetry | | |

### 1.11 Relationship to Higgsfield

Openfield reproduces **user experience and workflow** — layout, control inventory, interaction patterns, flows — which is the functional design of an application, not its expressive content. It does not reproduce Higgsfield's identity or its technology:

- **No brand assets.** No Higgsfield name, wordmark, logo, icons, illustrations, screenshots or images in our branding or copy. The name appears only nominatively and factually: in comparisons in this document, as the optional adapter's id and provider display name, as the provider's own model and endpoint identifiers in the registry and host allow-lists, and in the config filenames that adapter owns — never as an Openfield label, headline or asset. Openfield ships its own name, logo, icon set and palette; the lime accent observed in the reference product is Higgsfield's brand colour and is **not** adopted — our accent is the `--of-accent` token of §2.2, which inverts for light mode.
- **No copied copy.** All UI strings, headlines, descriptions and tooltips are written for Openfield. **Preset names, colour-grading preset names and enhancer preset names are Openfield's own; the observed product's names are recorded in the research notes only and are never shipped.** Where the reference product's copy was recorded during research, it is used to identify *what a control does*, never as text to paste. Observed headline copy such as the moodboard/character/colour hero text is replaced with our own wording, and its editorial model grouping is replaced by Recent / by company / Needs a key (§0.14).
- **No proprietary models or services.** Soul, Soul Cinema, Soul ID, Soul HEX, Higgsfield's curated style catalogue and the Topaz upscaler are not reimplemented, redistributed or emulated as models. Each has a declared open substitute or a capability slot (§1.6).
- **No private API use.** Openfield does not call Higgsfield's application endpoints (`/fnf/*`), does not use scraped session credentials, and does not circumvent authentication or rate limits. The optional Higgsfield adapter is opt-in, uses the **documented public API** at `api.higgsfield.ai` with the user's own API key and their own billing relationship, and is disabled and hidden when no key is configured.
- **No confidential material.** The research behind this PRD was a logged-in walkthrough of a publicly available product using the researcher's own paid account, recording layout measurements and observable behaviour. No source code, internal documentation or non-public material was obtained or used.
- **Licence and notice.** Openfield is MIT, copyright "Openfield contributors". The README carries a plain statement that Openfield is an independent project, not affiliated with, endorsed by or sponsored by Higgsfield, and that Higgsfield and its product names are trademarks of their owner, referenced only nominatively. `CONTRIBUTING.md` asks contributors not to submit assets, strings or code derived from Higgsfield or any other closed product.
- **Before release**, a maintainer performs a brand-and-copy audit against this list, on the release checklist alongside the S2 parity checklist.

### 1.12 Open questions

- **Higgsfield adapter viability.** The public API is documented for Soul v2 (`POST /higgsfield-ai/soul/v2/standard`) with `Authorization: Key <id>:<secret>`, but research found no documented endpoint for **listing style IDs** (70+ styles referenced without a schema), no documented **identity-training** endpoint, and no Canvas API. Until style-listing and character endpoints are confirmed with a real key (the owner's, in `M3-16`), the adapter's scope — and whether it ships in v1 at all — is undecided; §0.13 already pins its pricing to `kind: "unknown"` until a live probe confirms an estimate endpoint.
- **Provider terms.** Whether each provider's ToS permits a BYOK client of this shape, and whether any require attribution or restrict presenting cost estimates, has not been verified per-provider.
- **Model catalogue refresh cadence.** Google publishes no `models.list` for image models and OpenAI's `/v1/models` does not flag image capability — both stand. §0.3 settles the consequence: `listModels()` need only return the adapter's static, version-stamped catalogue, network discovery is optional and **allow-listed by the adapter's own `recognise(id)`** (unrecognised ids are reported, never added), and the snapshot date is surfaced in Settings → Models. What remains open is the refresh cadence and who runs the maintainer script.
- **Migration.** Whether existing Higgsfield users want to import their cloud library, and whether any supported export path exists, is unknown; no export API was observed.
- **Parity ownership.** Who signs off the S2 parity checklist (§8.8), and what counts as a *must* row versus a *should* row, needs fixing before the checklist is written. §0.14 remains the scope contract either way.
- **Canvas gaps.** Several behaviours of the v1 node set were not captured (inner UI of the Upload and Assets nodes, multi-select and group operations, delete/duplicate shortcuts). §7 decides these from first principles rather than from observation; node types §0.14 defers to v1.1 or drops outright are not open questions.

---
## 2. App shell, generation feed and library grid

This section specifies the main screen of Openfield: the persistent application shell, the generation feed that fills the `/image` route, the `/assets` library, first run, accessibility and i18n readiness. Layout numbers are the measured values from the walkthrough (2026-09-23, 1440×900 viewport) re-expressed in our own design language.

§0 is binding on every shared contract. §2 owns layout, tile and library behaviour, multi-select, the published keyboard table, first run, accessibility and i18n; it does not own endpoints (§8.3), error codes (§0.5), the zoom/thumbnail ladder (§0.10, §8.5.2) or the meaning of the iteration actions (§0.1). Composer and per-model controls are §3; the detail view and editor are §4; presets, references, characters and palettes are §5; adapters, keys and the Settings surface are §6 (Settings IA: §6.17); the node canvas is §7; storage, the HTTP API, the queue and delivery are §8.

---

### 2.1 Routes and navigation model

| Route | Screen | Notes |
|---|---|---|
| `/image` | Create screen: generation feed + floating composer | Default route after launch |
| `/image?model=<providerId>:<modelId>` | Same, with a model preselected | Colon is the only separator (§0.2). Deep-linkable; changing the model chip rewrites the query without a page transition (`history.replaceState`); an unknown key falls back to the default model with a toast |
| `/image?folder=<folderId>` | Feed filtered to one folder | Composable with `model` |
| `/assets` | Library: all assets, date-grouped fixed grid | |
| `/assets/favourites` | Favourites-only library | |
| `/assets/folder/:folderId` | Single folder | |
| `/canvas` | Canvas index (§7) | |
| `/canvas/:canvasId` | Canvas editor (§7) | |
| `/settings` | Your keys, models, storage, appearance, usage log (§6.17) | |
| `/presets` | Preset library (§5) | Reachable from the nav app menu and the style picker |

Routing is client-side (React Router), state in the URL wherever it is user-meaningful: model, folder filter, zoom step (`?z=0..4`), and the open asset (`?asset=<id>`, §4). The feed's scroll offset is preserved per route in memory and restored when returning from the detail view or from `/canvas`.

#### Top navigation bar

Fixed, full width, **44px tall**, `background: var(--of-surface)`, `border-bottom: 1px solid var(--of-border)`, `z-index: 60`. Content is a single flex row, 16px side padding, 8px gaps.

- **Left**: Openfield wordmark (our own logo, 20px glyph + 14px/600 wordmark) followed by a 12px chevron that opens the app menu: *New canvas · Open library · Preset library · Settings · Help · About*.
- **Centre-left**: primary nav items, 14px/500, 8px/10px padding, radius 8, `--of-text-secondary` idle / `--of-text-primary` + `--of-elevated` background when the route is active: **Create · Assets · Canvas**.
- **Right**: search button (16px icon, opens the command palette — §2.6), **usage pill** (running spend for the current period, e.g. `$1.24 · 38 images`, 12px, mono numerals, links to the usage log in §6.9), theme toggle (sun/moon), Settings gear. Nothing else — no account, upgrade, notification or social affordances, since Openfield is single-user and local.

**"Create" mega-menu.** Hovering or clicking **Create** opens a two-column panel (560px wide, radius 16, 16px padding, 8px below the nav, 150ms fade + 2px rise), the same shape as the reference product's Image menu with our own inventory:

- **Tools** column: *Create image* (`/image`), *Canvas* (`/canvas`), *Preset library* (`/presets`), *Library* (`/assets`). Each row: 32px rounded icon tile, 14px/500 name, 12px `--of-text-secondary` description.
- **Models** column: rows fed **live from the model registry** (§6.4) — never a hardcoded list. Each row shows the provider glyph, model name, a capability hint derived from the manifest (§0.3), and navigates to `/image?model=<providerId>:<modelId>`. Models whose provider has no configured key render at 50% opacity with an "Add a key" affordance that deep-links to `/settings`. If the registry returns nothing (no keys yet), the column shows a single "Add a key" row (§2.10).

> **AC-2.1.1** Every model listed in the menu resolves to a working `/image?model=<providerId>:<modelId>` deep link, and a cold load of that URL selects the model and its capability-correct control set before first paint of the composer.

---

### 2.2 Theme and design tokens

Dark and light both ship in v1. Dark is the default and is what `design.pen` shows; light is a full first-class theme derived from the same tokens, not an inversion hack. Theme resolution order: explicit user choice persisted in the local config → `prefers-color-scheme` → dark. Implemented as CSS custom properties on `:root`, re-declared under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])` and under `:root[data-theme="dark"]`; Tailwind consumes them through `theme.extend.colors`. `body` always sets an explicit background.

#### Colour tokens

All design tokens carry the `--of-` prefix (§0.1). This table is the only place a colour literal appears; **no other section writes a raw hex or rgba for a colour**.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--of-surface` | `#0E1012` | `#FFFFFF` | Page background, top nav |
| `--of-surface-0` | = `--of-surface` | = `--of-surface` | Alias consumed by the composer wrapper (§3.1) |
| `--of-elevated` | `#17191C` | `#F4F5F7` | Chips, popovers, cards, tile overlays |
| `--of-surface-sheet` | = `--of-elevated` | = `--of-elevated` | Alias consumed by the picker sheets (§5.2) |
| `--of-elevated-2` | `#202327` | `#E9EBEF` | Hover of elevated, pressed states |
| `--of-border` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.10)` | Hairlines, chip borders, panel edges |
| `--of-border-strong` | `rgba(255,255,255,0.16)` | `rgba(0,0,0,0.18)` | Focus rings on neutral controls |
| `--of-text-primary` | `#F5F6F7` | `#101214` | Body, titles |
| `--of-text-secondary` | `rgba(245,246,247,0.62)` | `rgba(16,18,20,0.60)` | Captions, descriptions, muted values |
| `--of-text-tertiary` | `rgba(245,246,247,0.38)` | `rgba(16,18,20,0.40)` | Placeholders, disabled |
| `--of-accent` | `#E9E3D8` | `#1B1D21` | Primary action, selection, progress, active state |
| `--of-accent-fg` | `#14161A` | `#FFFFFF` | Text/icon on accent fills |
| `--of-on-accent` | = `--of-accent-fg` | = `--of-accent-fg` | Alias consumed by §4.1 |
| `--of-accent-soft` | `rgba(233,227,216,0.08)` | `rgba(27,29,33,0.06)` | Accent tints, selected-row backgrounds |
| `--of-accent-line` | `rgba(233,227,216,0.25)` | `rgba(27,29,33,0.18)` | Borders of selected or active controls |
| `--of-danger` | `#F2545B` | `#D23540` | Destructive actions, failed jobs |
| `--of-danger-soft` | `rgba(242,84,91,0.14)` | `rgba(210,53,64,0.10)` | Error tile fill |
| `--of-scrim` | `rgba(0,0,0,0.55)` | `rgba(0,0,0,0.45)` | Tile hover gradient, modal backdrop |

The three aliases exist because other sections consume them by name; they resolve to their base token and are never given an independent value. Openfield's accent is a warm bone `#E9E3D8` on dark (near-black `#1B1D21` on light), chosen for a quiet, premium feel and deliberately unlike the reference product's lime. It is used exactly where that product uses its accent: the Generate action, selection rings, progress indicators, the checkmark on a selected option row, and the active-state tint on toggled chips. Every pair in this table is a contrast-gate input (§2.11).

#### Radii, spacing, elevation

- **Radii**: `--of-r-xs 6` · `--of-r-sm 8` · `--of-r-md 12` · `--of-r-lg 16` · `--of-r-xl 20` · `--of-r-2xl 24` · `--of-r-pill 999`. Feed tiles use **radius 0** (as measured); library cards use `--of-r-md`.
- **Spacing scale** (px): 2, 4, 8, 12, 16, 18, 22, 24, 32, 40, 64. The odd members are load-bearing measurements, not rounded: **2** = feed tile gap, **18** = library grid gap, **22** = composer form padding (§3).
- **Elevation**: `--of-shadow-popover: 0 8px 32px rgba(0,0,0,0.45)`; `--of-blur-panel: blur(10.45px)` for the floating composer and hero sheets (§3); `--of-blur-chip: blur(8px)` for tile overlay buttons.

#### Type scale

Inter (self-hosted, variable, subset latin), fallback `system-ui, -apple-system, "Segoe UI", sans-serif`. `ui-monospace, "JetBrains Mono", monospace` for IDs, seeds, dimensions and cost figures.

| Token | Size / line-height / weight | Use (measured origin) |
|---|---|---|
| `--of-t-micro` | 11 / 14 / 600, `letter-spacing: 0.06em`, uppercase | Section labels (`PROMPT`, `DETAILS`), badges |
| `--of-t-caption` | 12 / 16 / 500 | Descriptions in pickers, tabs, date group headers, pill labels |
| `--of-t-body` | 14 / 20 / 400 | Prompt text, option-row names, key/value rows |
| `--of-t-body-strong` | 14 / 20 / 600 | Buttons, active nav, CTA labels |
| `--of-t-value` | 16 / 20 / 400 | Chip values (aspect, quality, batch) |
| `--of-t-title` | 20 / 28 / 600 | Page titles ("All assets"), dialog headers |
| `--of-t-display` | 28 / 34 / 700 | Empty-state headlines |

Focus visibility: every interactive element gets `outline: 2px solid var(--of-accent); outline-offset: 2px` on `:focus-visible`. Motion respects `prefers-reduced-motion` — the coverage list is §2.11.

---

### 2.3 The generation feed (`/image`)

The feed is the page — edge-to-edge, starting directly below the shell, with the composer floating above it. It is the user's whole history, **newest first, across all models**, never filtered to the currently selected model (this matches the observed behaviour and is important: switching models must not appear to wipe the history).

#### Frame

- Top nav 44px. Below it a **feed toolbar, 42px tall** (`y 44 → 86`), transparent background, 16px side padding:
  - **Left**: filter chips, 28px tall, radius `--of-r-sm`, 12px/500 — *All* · *Favourites* · folder dropdown (*All folders ⌄*) · *Hide failed* toggle. Active chips take `--of-accent-soft` + `--of-accent` text.
  - **Right**: the **zoom slider** (Radix Slider, 120px track, 14px thumb) and a *Hide toolbar* / expand icon button.
- The grid begins at **y = 86** and spans the full content width: at a 1440px viewport with a 16px scrollbar the content box is **1424px** (x 0 → 1424), with no page gutter. Below 1280px the feed keeps a 16px gutter each side.
- The scroll container ends with **240px of bottom padding** so the final row can scroll clear of the floating composer.

#### Justified-rows layout

The feed is a **justified-rows (flex-justified) layout**, not a fixed column grid: every row shares one height, and each tile's width is `rowHeight × aspectRatio`. Gaps are **2px** horizontally and vertically. Tiles have **radius 0** and no captions; the image is the tile.

Algorithm, run on the client for the loaded window:

1. Take the zoom step's **target row height** `H` (§0.10, restated as a table below for the tiles-per-row derivation only).
2. Greedily append assets to the current row at height `H` until the sum of widths plus gaps meets or exceeds the container width `W`.
3. Solve the row: `rowHeight = (W − 2·(n−1)) / Σ(aspectRatio_i)`; widths are `rowHeight × aspectRatio_i`, rounded so the row sums to exactly `W` (distribute the ±1px remainder to the widest tiles).
4. Clamp the solved height to `[0.75·H, 1.35·H]`; a row that would exceed the clamp (e.g. one lone 21:9 panorama) is left at the clamp and left-aligned.
5. The trailing partial row renders at `H`, left-aligned, never stretched.

This reproduces the measured behaviour exactly: at zoom step 3 a mixed row of 3:4 (342w) + 4:5 (367w) + 3:4 (342w) + 4:5 (367w) plus three 2px gaps solves to **1424px at a row height of 456**.

#### Zoom slider

Radix Slider, discrete, `min 0, max 4, step 1`, **default step 3**, value persisted per-route in the URL (`?z=`) and in local config. Dragging right enlarges tiles. Tooltip on the thumb shows the step name; the grid re-solves on `valueCommit` and shows a live ghost re-solve on drag (throttled to `requestAnimationFrame`).

The five target row heights and their thumb rungs are **§0.10's ladder, owned by §8.5.2**. Reproduced here only so the column counts below are checkable:

| Step | Name | Target row height (§0.10) | Tiles/row @1424w, 4:5 | @3:4 | @16:9 |
|---|---|---|---|---|---|
| 0 | Contact sheet | 200 | 9 | 9 | 4 |
| 1 | Small | 280 | 6 | 7 | 3 |
| 2 | Medium | 360 | 5 | 5 | 2 |
| 3 | **Large (default)** | **456** | **4** | **4** | **2** |
| 4 | Showcase | 640 | 3 | 3 | 1 |

> **AC-2.3.1** At a 1440 px viewport, zoom step 3, with a history of 4:5 assets, tiles measure 365×456 with 2 px gaps and four per row; every row's rendered width equals the container width to within 1 px, verified with `getBoundingClientRect()`.

`365 = 456 × 4:5` is the ladder target from §0.10; step 4 of the algorithm governs how far a solved row height may drift from `H` to make the row sum exact, and the width-equals-container invariant is the binding half of the criterion.

#### Virtualization and paging

- The scroll container is `position: relative` with an explicit computed total height; visible tiles are **absolutely positioned** (`transform: translate3d(x, y, 0)`), with an overscan of 2 rows above and below the viewport. Tiles carry `contain: layout paint style`.
- Row geometry is computed incrementally and memoised per `(zoomStep, containerWidth, assetListVersion)`; a resize re-solves from the first row intersecting the viewport so the user's scroll anchor does not jump.
- Images come from the local thumbnail service (`GET /files/thumb/:id?h=&dpr=`, §8.3), WebP, generated on first request and cached under **`~/.openfield/thumbs`**. `srcset` spans the height ladder `@h200, @h280, @h360, @h456, @h640` plus their `dpr=2` variants; `sizes` is derived from the solved tile width. Rung resolution, the cache key and the encoder are §0.10/§8.5.2 and are not restated here. Full-resolution originals load only in the detail view (§4). `loading="lazy"`, `decoding="async"`, and an `--of-elevated` placeholder box at the exact aspect ratio so nothing reflows.
- **Paging**: cursor pagination, page size **50** — the measured feed page size — ordered `created_at DESC, id DESC`, over §8.3's asset list endpoint. An IntersectionObserver sentinel 1200px before the end requests the next page; a failed page shows an inline "Couldn't load more." row with **Try again** rather than an empty void.
- **Prepending** (new jobs, see below) inserts at the head and compensates `scrollTop` by the inserted block height whenever `scrollTop > 0`, so the user's view never jumps.
- Job state changes arrive on the single SSE stream `GET /api/events` (§0.6, §8.3) with a polling fallback; the feed never full-refetches on a job update, it patches the single asset in its store. Partial frames (`job.partial`) render into the placeholder and are superseded by the final output.

> **AC-2.3.2** With 5,000 assets in the database, scrolling the feed at zoom step 0 holds ≥55fps on a 2021-class laptop, and the DOM never contains more than ~3 viewports of tiles.

---

### 2.4 Tile states

Every tile is a single focusable element (`role="gridcell"`, roving `tabindex`) wrapping the image plus its overlays.

**Idle.** Image only. No border, no caption, radius 0.

**Hover / keyboard-focused.** 120ms fade-in of:

- A **top scrim** (`linear-gradient(to bottom, var(--of-scrim), transparent)`, 96px tall) and a **bottom scrim** (same, inverted, 96px).
- **Selection checkbox**: 16px box in a 32px hit target, inset **left 8px / top 12px**, `--of-elevated` fill at 72% with `--of-blur-chip`, 1px `--of-border`. Always present in the DOM (for hit-testing and screen readers), visually revealed on hover/focus or whenever selection mode is active.
- **Top-right action stack**: vertical, **4px apart**, inset top 8 / right 8; each button **32×32**, radius `--of-r-sm`, `background: color-mix(in srgb, var(--of-elevated) 72%, transparent)`, `--of-blur-chip`, 1px `--of-border`, 16px icon. In order: **Favourite** (heart, filled `--of-accent` when on) · **Download** · **Recreate** (replays the stored request, same seed where the model supports one; a `~` badge when it does not — §0.1) · **More**.
- **Bottom-right pill group**: horizontal, height 32, radius `--of-r-pill`, 4px gaps, inset bottom 8 / right 8. In order: **Use as reference** (attaches the image to the composer's reference strip and nothing else, §0.1) · **Edit ⌄** (opens the detail view on its Edit tab, §4; the chevron offers *Edit area*, *Expand & crop*, *Upscale*, *Remove background*, each capability-gated by `resolveControl` per §0.3) · **Send to Canvas ⌄** (*New canvas with this image* / *Add to recent canvas*, §7). The slot the reference product gives to "Animate" is reserved for **Animate** when video ships; in v1 it is absent, not disabled.

**More menu** (our inventory, our copy): *Open* · **Recreate** · **Reuse** (loads prompt, references, model and settings into the composer without running, §0.1) · *Use as reference* · *Copy prompt* · *Copy image* · *Add to folder ▸* · *Favourite* · *Save as preset…* · *Show in Finder* · *Export…* · **Delete** (`--of-danger`). Share/publish/social entries have no counterpart — Openfield ships no network sharing.

**Selected.** `outline: 2px solid var(--of-accent); outline-offset: -2px`, an `--of-accent-soft` overlay at 12%, checkbox filled `--of-accent` with an `--of-accent-fg` check. Selected tiles keep their overlays hidden unless hovered, so a large selection stays legible.

**Generating.** On submit, **N placeholder tiles** (one per batch image, N ≤ 4 per §0.10) are prepended immediately — before the server responds — each reserving the **exact requested aspect ratio** so the row solve is correct and nothing reflows when the real image lands. Contents:

- Top-left **"Generating" pill**: 24px tall, radius `--of-r-pill`, `--of-elevated` at 72%, 12px/500, 12px spinner.
- Top-right **"Cancel" pill**: same geometry, `--of-danger` text on hover; cancels through §8.3's job-cancel route. Cancellation is honest per §0.12: neither launch adapter implements provider-side cancel, so the tile and the toast carry, verbatim, *"Canceled. You may still be charged for work that already started."*
- Body: an indeterminate shimmer sweep; where the manifest declares `streaming.progressPercent` (§0.3) it becomes a 3px determinate bar pinned to the tile's bottom edge, and `streaming.partialImages` renders `job.partial` frames in place. An elapsed-time counter (`0:14`) appears after 10s, and a "Still working. Some models take up to 2 minutes" line after 45s.
- The **first** placeholder of a batch may host a **tip card** — our own rotating local tips, shipped as a static JSON file, dismissible, switchable off in Settings (§6.17); no network request and no telemetry. **Queue position renders in the same slot when a run is waiting** ("2nd in line", from the scheduler's ordering in §0.12).
- On completion the real image **swaps in place** with a 150ms crossfade (dropped to an instant swap under reduced motion, §2.11); the row is not re-solved unless the returned aspect ratio differs from the request, in which case only that row re-solves. Observed completion for a batch of 2 was ~15–20s.
- Multiple queued runs stack: each new job set prepends above the previous, newest first. Prompt and settings are never cleared by submitting (§3).

**Failed.** The reference product never surfaced a failure to us, so the failed tile is Openfield's own design. A failed job keeps its tile at the requested aspect ratio: `--of-danger-soft` fill, 1px `--of-danger` at 40%, centred 20px alert glyph, a one-line plain-language reason in `--of-t-body` (§0.5's copy; the provider's own message is never shown on the tile and lives in the Error log), and a button row: **Try again** (accent ghost) · **Reuse** (loads the job's settings into the composer, §0.1) · **Details** (opens the Error log with the redacted payload, HTTP status and provider code) · dismiss ×.

The reason line and the primary action for every failure are **§0.5's failed-tile copy table**, keyed on §0.5's `ErrorCode`; §2 does not restate them. The spelling is **`canceled`** everywhere — enum, column and UI copy alike.

Failed tiles persist (`jobs.status = 'failed'`, §0.4) and stay in the feed until dismissed; the toolbar's **Hide failed** chip filters them out without deleting. A batch in which every job fails collapses to a single tile labelled "3 images failed" that expands on click. **A failed job writes a usage-log row with `cost_usd = 0` and `cost_source = unknown`; no cost is ever added to a spend total for a failure** (§0.13, §6.9).

**Last viewed.** After the detail view closes, the tile that was open receives a persistent **eye badge** (24px, top-left, `--of-elevated` at 72%, `--of-blur-chip`) plus a 1px `--of-border-strong` inset ring. It survives navigation away and back, is cleared when another asset is opened, and is what the feed scrolls to when restoring position.

---

### 2.5 Multi-select and bulk actions

- **Entering selection**: click any tile's checkbox, `⌘/Ctrl+click` a tile, `Shift+click` to select a range from the last-selected tile, or press `X` / `Space` on the focused tile. Plain click still opens the detail view — selection never hijacks the primary gesture.
- **Selection model** lives in a store keyed by asset id; it survives zoom changes, filter changes and paging (a selected asset scrolled out of the window stays selected and is counted).
- **Floating selection toolbar**: appears with a 160ms rise+fade, centred horizontally, `height 56`, radius `--of-r-lg`, `--of-elevated` at 92% with `--of-blur-panel`, 1px `--of-border`, `--of-shadow-popover`, 12px internal gaps. On `/image` it sits at **bottom: 170px** (16px composer offset + 142px composer height + 12px clearance) so it never collides with the composer; on `/assets` it sits at **bottom: 16px**. Contents, left to right: **"N selected"** (`--of-t-body-strong`) · *Select all shown* · divider · **Download .zip** · **Add to folder ▸** · **Favourite** · **Recreate** · **Export…** · **Delete** (`--of-danger`) · divider · **Clear** (×).

| Bulk action | Behaviour |
|---|---|
| Download .zip | Server streams a zip of the originals through §8.3's bulk-asset route (`{action:'download'}`), named `openfield-<date>-<count>.zip`; a progress toast shows packaged/total; files inside are named `<created_at>-<shortId>.<ext>` |
| Add to folder ▸ | Submenu of folders + inline "New folder…"; membership is additive and many-to-many |
| Favourite | Optimistic toggle, single batched write; flips to *Unfavourite* when all selected are already favourited |
| Recreate | Replays each selected asset's frozen `NormalizedRequest` through §8.3's recreate route (§0.1). A confirmation shows the **total estimated cost** (§0.13) when more than 4 job sets are involved or the estimate exceeds the warn threshold, and states plainly when any selected model has `seed.supported: false` so its results will differ. Placeholders prepend as usual |
| Export… | Opens the export sheet: format (PNG/JPEG/WebP), max dimension, whether to write a sidecar `.json` with prompt/model/settings, destination folder. A format that differs from the stored MIME carries §0.7's re-encode warning |
| Delete | Confirmation dialog: "Delete N images?" with the body "They move to the trash. You can restore them from there. They're also removed from folders and canvases." When the person has set `trashRetentionDays` (§8.6), the body adds "They're deleted for good after N days in the trash."; destructive button `--of-danger`; a single undo toast (8s) restores them straight away, and until the trash is emptied they can be restored from the Trash view |

> **AC-2.5.1** Selecting 200 assets, applying *Add to folder*, and clearing selection performs one HTTP request and one SQLite transaction, and the folder count in the library sidebar updates without a refetch of the grid.

---

### 2.6 Keyboard

**This is the published shortcut table for the whole application (§0.9).** §4.5 and §7.9 cross-reference it and add only their own surface's tools; no other section assigns a global key. The feed is a roving-tabindex grid, so arrow keys move focus rather than scroll. The table is also rendered in a cheat sheet opened with `?`.

| Key | Action |
|---|---|
| `↑ ↓ ← →` | Move between images |
| `Home` / `End` | First / last image |
| `PageUp` / `PageDown` | Scroll one screen |
| `Enter` | Open image |
| `Space` / `X` | Select or deselect |
| `Shift + ↑↓←→` | Extend selection |
| `⌘/Ctrl + A` | Select all shown images |
| `Esc` | Clear selection |
| `F` | Favourite or unfavourite |
| `⇧F` | Expand image |
| `D` | Download |
| `R` | Recreate |
| `U` | Use as reference |
| `E` | Open in editor |
| `Delete` / `Backspace` | Delete |
| `1`–`5` | Set zoom level |
| `−` / `=` | Zoom out / in |
| `⌘/Ctrl + K` | Search everything |
| `⌘/Ctrl + M` | Choose model |
| `⌘/Ctrl + F` | Search images |
| `⌘/Ctrl + Enter` | Generate |
| `G` then `I / A / C / S` | Go to Create / Assets / Canvas / Settings |
| `?` | Keyboard shortcuts |

On the detail view's Edit tab, editor tool letters take precedence over surface actions; Download is `⌘⇧S` there.

Typing a printable character while the feed has focus and no modifier moves focus into the prompt editor and inserts the character, so the user can start writing without reaching for the mouse.

---

### 2.7 Empty and edge states

| Condition | Presentation |
|---|---|
| **Fresh install, no provider key** | Centred column, max-width 520: `--of-t-display` headline "Nothing generated yet", `--of-t-body` / `--of-text-secondary` line "Openfield uses your own API keys. Add one to start making images.", primary button **Add a key** → `/settings`, secondary link *How keys are stored* (says, in plain words, that the key stays on your computer, only your user account can read it, and it is only ever sent to the company it belongs to; the file path and permissions live in the README, not in the UI). No sample images, no stock art. This is step 2 of §2.10. |
| **Key configured, no generations** | Same frame, headline "Your first image", three example prompt cards (our own copy) that populate the composer on click, and a link to the **Preset library** (§5). The composer is focused on mount. |
| **Folder filter with no members** | "Nothing in *Client work* yet" + "Add images from an image's ⋯ menu, or select several and choose Add to folder." + *Clear filter*. |
| **Search with no results** | "No matches for “`<query>`”" + *Clear search*; suggests searching in All assets if a folder filter is active. |
| **All items hidden by *Hide failed*** | Inline row: "N failed runs hidden. Show". |
| **Offline / provider unreachable** | A dismissible banner under the toolbar, `--of-danger-soft`: "Couldn't connect to `<company>`. Runs will fail until it's back." Existing assets remain fully browsable — the library is local files. |

---

### 2.8 Assets library (`/assets`)

The library is the same data as the feed viewed differently: the feed is the *history of generations* laid out by aspect ratio; the library is *everything in `~/.openfield`* — generations, uploaded references, edited derivatives and imports — laid out in a tidy fixed grid for finding and filing. It has no composer.

#### Sidebar — 256px, fixed, `--of-surface`, 1px right `--of-border`

1. **Search field** at the top (32px, radius `--of-r-sm`, `--of-elevated`, magnifier glyph, placeholder "Search assets"). Queries prompt text, model name, folder name and filename; debounced 200ms; full-text search over the SQLite FTS index (§8.2).
2. **All assets** (active by default) and **Favourites (N)** — counts in `--of-text-tertiary`, right-aligned, mono numerals.
3. Group **Type**: *Images (N)* · *References (N)* · *Edits (N)*, with no *Video* or *Audio* rows in v1: they appear only once those types exist, and the asset model is already modality-agnostic (§1, §8.2), so adding them needs no migration.
4. Group **Library** — collapsible, with a `+` button that creates a folder inline. Folder rows: 16px folder glyph, name (14px/400, truncated with a tooltip), item count. Drag a selection onto a folder row to file it; drag a folder onto another to nest it one level. Right-click: *Rename · Set colour · Export folder… · Delete folder*.
5. Bottom: disk-usage line ("4.2 GB used") linking to Settings → Storage (§6.17).

#### Main area

- Header row, 56px: page title (`--of-t-title`, e.g. "All assets" / the folder name) with the item count beside it, and at the right the same **zoom slider** as the feed plus a **Hide sidebar** toggle.
- Assets are **grouped by date** with sticky group headers ("Today", "Yesterday", then the formatted date — all three produced by `Intl`, §2.12). Each header carries a **checkbox that selects the whole group** and a right-aligned count.
- The grid is **fixed, square-cropped tiles** — not justified rows. At a 1440px viewport: content column 1184px, 24px page padding → **6 columns, 18px gaps, 172×172 cards, radius `--of-r-md`**. Cards use `object-fit: cover` with a centre crop, and a 1px `--of-border` inset so pale images stay bounded. The zoom slider changes the column count: 8 / 7 / **6** / 5 / 4 at steps 0–4, recomputing card size from the available width and requesting the smallest thumb rung ≥ the rendered box (§0.10).
- Card hover shows the same top-right action stack and checkbox as the feed; the bottom-right pill group is replaced by a single **Open** affordance plus a 12px/500 filename/model caption revealed on hover.
- The grid is virtualized by group: only groups intersecting the viewport (plus one either side) render their cards; group heights are computed from the known count, so the scrollbar is stable from the first paint.
- Same multi-select model, same floating selection toolbar (at `bottom: 16px` here), same keyboard map, plus `⌘/Ctrl + Shift + N` to create a folder.

#### How folders relate to the feed

- A **folder is a named collection**, not a location on disk: `folders(id, name, color, parent_id, created_at)` plus `asset_folders(asset_id, folder_id, added_at)` — declared in the Drizzle schema (§8.2). The column is `color`; the British spelling survives only in the menu item **Set colour**. An asset can belong to several folders; files never move, so nothing breaks in Canvas or in a lineage chain when filing changes.
- **Adding** happens from either surface: the tile *More → Add to folder*, the bulk selection toolbar, or drag-and-drop onto a sidebar row.
- **Filtering the feed**: choosing a folder in the feed toolbar's folder dropdown sets `/image?folder=<id>`, and the justified feed then shows only that folder's generations, still newest-first and still across all models. The dropdown also offers *Favourites*.
- **Deleting a folder** removes memberships only; the confirm dialog states "The images stay in your library." Deleting *assets* is the only destructive path, and it is the same dialog in both surfaces; a soft delete keeps the row and its FTS entry (§0.7).
- Counts are derived (`COUNT` over the join, cached in the store) and update optimistically on add/remove.
- Where the reference product makes a canvas itself a folder record, Openfield keeps **canvases as their own entity** (§7). A canvas can *reference* assets and can be linked to a folder, but the two are not the same row, so filing an image never mutates a canvas.

> **AC-2.8.1** At a 1440px viewport, `/assets` renders a 6-column grid of 172px square cards with 18px gaps, date group headers stick to the top of the scroll container, and a group header's checkbox selects exactly the assets in that group.
> **AC-2.8.2** Adding 12 selected assets to a folder from `/assets`, then navigating to `/image?folder=<id>`, shows exactly those of the 12 that are generations, in newest-first order, in justified rows.

---

### 2.9 Substitutions for proprietary surfaces

| Reference-product surface | Openfield equivalent |
|---|---|
| Top-nav Explore / Upgrade / Enterprise / avatar / bell / team workspaces | Removed. Single-user, local, no account. Nav right side is search, usage pill, theme, settings. |
| Image mega-menu "Models" list (hardcoded catalogue of proprietary models) | Same two-column shape, but rows are generated from the runtime **model registry** (§6.4); unconfigured providers render dimmed with an "Add a key" link. |
| Tile "Create 3D scene", "Multishot", "Skin Enhancer", "Extract Hex", "Publish", "Share to X/WhatsApp/…" | Not shipped. Their slots are taken by *Send to Canvas*, *Save as preset*, *Show in Finder* and *Export…*. |
| Tile "Animate" → video generation | Reserved slot; absent in v1, enabled when the video modality ships against the same job/asset model. |
| Promo/tips card inside the first processing tile (CMS-fed) | A local, static, dismissible tips file; no network request, no telemetry, and a Settings switch to turn it off. **Queue position renders in the same slot when a run is waiting.** |
| Credit counts on every action ("free gens left", "✦ 6.5") | **Cost estimate in your own currency** from the adapter's price manifest, shown on the Generate button and in bulk-action confirmations, with a running usage log (§0.13, §6.9). |
| Comments on assets, per-canvas chat, collaborator sharing | Not applicable to a single-user local app; omitted rather than stubbed. |
| Image-resizing CDN proxy | Local thumbnail service (`GET /files/thumb/:id?h=&dpr=`, §8.3), WebP output, on-disk cache under `~/.openfield/thumbs`, height-keyed ladder per §0.10. |

---

### 2.10 First run

Openfield has no account, no licence check and no sample content, so first run is one problem: get one provider key in place and one image on screen. G5 and S1 gate on exactly this path, and nothing else in the document specifies it.

| # | Step | Where |
|---|---|---|
| 1 | `bun install`, `bun dev`; the server prints its `127.0.0.1` URL and opens `/image` | terminal |
| 2 | No provider holds a usable key → the feed renders the **no-key empty state** (§2.7 row 1). The composer is visible but Generate is disabled with the sub-label "Add a key to start" | `/image` |
| 3 | **Add a key** navigates to `/settings` → **Keys** (§6.17) with the first provider row expanded and the key field focused | `/settings` |
| 4 | Paste the key → **Check key** (§6.2's `testConnection()`): one cheap round-trip, result inline — a ✓ with the number of models the adapter recognised, or the §0.5 failure copy with the field still populated and the key never discarded | `/settings` |
| 5 | On success the server writes the key to `~/.openfield/config.json` at `0600` (§6.11), loads the adapter's static catalogue, and sets `settings.defaultModel` to that adapter's default model if it is unset | server |
| 6 | One toast, "Connected to `<company>`", with a **Start creating** action back to `/image`. The model chip shows the auto-selected model with its capability-correct control set (§0.3), and the composer's prompt editor takes focus | `/image` |
| 7 | Type a prompt, `⌘/Ctrl+Enter`. Placeholder tiles prepend (§2.4) | `/image` |

Rules that make the path hold:

- **No manual file editing at any step.** The config file is written by the server, never hand-edited to get started.
- **Env override.** A key supplied by environment variable renders its provider row read-only — "Set by `OPENFIELD_GOOGLE_API_KEY`" — with **Check key** still available and no editable field. This path skips steps 3–5 and lands the user on step 6 at launch.
- **Re-entry.** The no-key state returns whenever zero providers hold a usable key. Adding a second provider later never re-triggers first run, and a key that stops working surfaces as `auth_invalid` on the tile (§0.5), not as a re-onboarding.

> **AC-2.10.1** On a clean machine with one provider key in hand, `git clone` to first generated image takes **≤ 5 minutes and ≤ 3 commands** (`bun install`, `bun dev`, open the URL) with **zero manual file editing** (S1). Scripted in CI on macOS and Linux and recorded in the README.

---

### 2.11 Accessibility

Accessibility is a release gate, not a backlog. Scope and limits are stated plainly rather than implied.

**Contrast — WCAG 2.2 AA, enforced in CI.** Body text ≥ 4.5:1, large text and the boundaries of interactive components ≥ 3:1, in **both themes**. A CI job enumerates every foreground/background pair in §2.2's token table (including the composed cases: text on `--of-elevated` over `--of-surface`, scrim-backed overlay buttons, accent fills) and fails the build on any pair under threshold. Two pairs are **unverified today** and must be resolved before M1 closes: `--of-accent` `#E9E3D8` against `--of-accent-fg` `#14161A`, and `--of-text-tertiary` at 0.38 alpha over `--of-surface`. If a pair fails, the token value moves — the gate does not.

**A keyboard path to every action, on every surface.** Everything in §2.6 is reachable by keyboard with a visible `:focus-visible` ring. Surfaces that are not naturally focusable get an explicit model:

| Surface | Keyboard model |
|---|---|
| Feed / library grid | Roving tabindex, `role="grid"` with `aria-rowcount`/`aria-colcount`; each tile is a `gridcell` named "`<truncated prompt>` · `<model>` · `<date>`" plus its state (generating, failed, selected, favourited) |
| Composer chips | `role="toolbar"`, arrow keys within, `Tab` out (§3.3) |
| Picker sheets and dialogs | Focus trap, `Esc` closes, focus restored to the invoking control (§5.2) |
| Node canvas (§7) | `Tab` cycles nodes in **topological order**; `⌥↑` / `⌥↓` cycle the focused node's ports; `Enter` connects the focused port to the current selection; `Esc` cancels a pending connection. React Flow is keyboard-hostile by default, so §7.9 implements this explicitly and cross-references here |

**Live announcements.** A single `aria-live="polite"` region announces job lifecycle — start ("Generating 4 images"), completion ("4 images ready") and failure (the §0.5 reason line) — one message per job set, never per tile, so a batch of four does not produce four interruptions. Placeholder tiles carry `aria-busy="true"` until their image lands. Destructive confirmations and undo toasts are `role="alertdialog"` / `role="status"` respectively.

**Reduced motion.** Under `prefers-reduced-motion: reduce`: §2.4's 150 ms crossfade becomes an instant swap; the placeholder shimmer becomes a static fill with a determinate bar where progress exists; the canvas's pan/zoom easing, node-drop spring and edge-draw animation are disabled and the viewport jumps; the selection toolbar's 160 ms rise, the mega-menu's 2 px rise and tile scrims resolve as 0 ms opacity changes. No motion-only affordance carries meaning.

**Out of scope, deliberately.** The editor pane (§4.6) and the node canvas (§7) are **not claimed to be screen-reader accessible in v1**. Both are direct-manipulation surfaces — a per-pixel mask and a spatial graph — whose state has no faithful linear reading, and a reader-only user cannot complete a mask stroke or judge a layout from a description. They remain fully keyboard-operable per the table above, and every asset they produce is reachable from the feed, the library and the detail view's Info and History tabs, which are accessible. This limitation is written into the README, not left to be discovered.

> **AC-2.11.1** The CI contrast job fails the build on any §2.2 token pair below its AA threshold, in either theme.
> **AC-2.11.2** An automated axe pass plus a scripted keyboard walk completes every action in the §2.6 table, every tile action and every bulk action on `/image`, `/assets`, the detail view and the canvas, using the keyboard alone, with a visible focus indicator at each stop and zero critical axe violations outside the two out-of-scope panes.

---

### 2.12 i18n readiness (v1: English only)

v1 ships English only. The requirement is narrower than translation: nothing in the codebase may make a second locale a rewrite, and nothing user-facing may be locale-hostile on day one.

- **One string catalogue.** Every user-facing string lives in `packages/core/src/i18n/en.json`, keyed by dotted path. Code reads it through the `t()` helper from `@openfield/core/i18n`, so `apps/web`, `packages/ui` and any message the server composes share one catalogue (§0.16). A lint rule forbids bare text nodes in JSX in `apps/web` and `packages/ui` outside the helper, so a literal can't reach a screen by accident.
- **No concatenation.** Plurals, counts and interpolations use ICU message syntax — `"{count, plural, one {# image} other {# images}}"`, `"{count} selected"`, `"{size} used"`. The strings "3 images failed", "N selected", "N failed runs hidden" and "4.2 GB used" are each **one** message with arguments, never assembled from fragments.
- **Dates and times through `Intl.DateTimeFormat`** with the system locale and timezone. This covers the library's date group headers, the detail view's asset timestamp and the canvas's saved-at line — all three of which are currently written as hardcoded US forms (§4.3's "September 23, 2026 at 12:44 AM", §7.3's "7/23/2026") and must resolve through the formatter instead. "Today" and "Yesterday" come from `Intl.RelativeTimeFormat`.
- **Numbers, sizes and currency through `Intl.NumberFormat`.** Cost figures render with `style: "currency"` and the estimate's own currency code; percentages, file sizes and durations use the same path. Mono numerals are kept wherever a number changes in place.
- **Currency is a `string`, not a literal.** `CostEstimate.currency` and `CostActual.currency` (§0.13) are widened from `"USD"` to `string`; **USD is the only value any v1 adapter emits**, and the usage log stores the code beside the amount so a non-USD price table is additive rather than a schema change.
- **Layout.** Spacing and insets use logical properties (`padding-inline`, `inset-inline`) throughout, so RTL becomes a stylesheet concern. RTL mirroring, locale-aware collation beyond the default collator, and translated preset or tip copy are explicitly **not** v1.

> **AC-2.12.1** The lint gate passes with zero user-facing string literals outside `en.json`, and switching the OS locale to `en-GB` changes every rendered date, number and currency without a code change.

---

### 2.13 Open questions

- The feed was never seen in a failure state, so the failed tile's layout and its retry affordances are Openfield originals with no reference behaviour to compare against. (The error vocabulary itself is settled — §0.5.)
- Whether the reference product's justified solver clamps extreme aspect ratios (21:9, 1:8) was not observed; our `[0.75·H, 1.35·H]` clamp is a derivation that should be tuned against real mixed-ratio histories. Closes with M1-08.
- The relationship between that product's feed and its assets library was not fully traced: it is unclear whether a generation appears in "all assets" automatically or only once filed. Openfield assumes automatic membership in "All assets".
- Selection behaviour across pagination boundaries was not observed — whether a selection survives loading more, and whether "select all" means all-loaded or all-matching. Openfield specifies all-loaded with an explicit count.

---

## 3. The prompt bar and per-model controls

The **composer** (§0.1) is the single place a run is configured and launched. It is a floating, fixed-to-bottom panel that sits over the feed, stays mounted for the whole session, and never clears itself. Everything a job set needs — prompt, references, model, per-model settings, batch count, seed — lives here, and the selected model's `Capabilities` (§0.3) decides which of those controls exist at all.

This section owns the composer's geometry, its chip behaviour, the model picker, the model-switch carry/clamp/drop rule, and the aside. It owns no shared contract: the capability vocabulary is §0.3, the seed pipeline §0.11, concurrency §0.12, cost §0.13, the request body §0.6, the preset object §0.8, and the per-model manifest values §6.13–§6.15.

### 3.1 Anatomy and geometry

Geometry measured 1:1 from the reference product at 1440×900. **Colours are Openfield tokens (§2.2); only geometry is carried over from the measurements** — sizes, radii, blur radii and gaps are verbatim, every fill and border is the token that plays the same role, so the composer inverts correctly in light mode (§0.1).

| Part | Spec |
|---|---|
| Outer wrapper | `position: fixed`, `bottom: 16px`, centered, width `min(1120px, 100vw − 160px)`, `padding: 2px`, `radius: 26px`, `background: color-mix(in srgb, var(--of-surface) 96%, transparent)` |
| Inner form | `padding: 22px`, `radius: 24px`, `border: 1px solid color-mix(in srgb, var(--of-accent) 5%, transparent)`, `backdrop-filter: blur(10.45px)`; resting size 1116×142 at a 1440px viewport |
| Fieldset | `display: flex; flex-direction: row; gap: 12px` → **[left column]** `[prompt row]` + `[settings chip row]`, **[right aside]** |
| Left column | `flex: 1 1 auto; min-width: 0` (so the chip row can scroll rather than push) |
| Prompt row | attach button 32×32, `radius: 10`, `background: var(--of-elevated)`, `border: 1px solid var(--of-border)` · prompt editor, 14px, resting height 40px |
| Settings chip row | starts 56px below the prompt row top; horizontally scrollable, chips 40px tall, `radius: 12`, `background: var(--of-elevated)`, `border: 1px solid var(--of-border)`, label `var(--of-text-secondary)`, 16px/400 for value chips, 14px/500 for toggle/label chips; 12px gap |
| Scroll affordances | 16px chevron buttons ("Scroll settings left/right") fade in at each end only while the row overflows; wheel/trackpad horizontal scroll and shift+wheel also scroll it; scrollbar hidden |
| Right aside | 396×84: Character tile 84×84 · Preset tile 144×84 · Generate button 144×84 (`radius: 12`) |
| Z-order | above the feed, below dialogs; the feed reserves bottom padding so the last row scrolls clear of the bar (§2.3) |

**Responsive rule (desktop-first, ≥1280px target).** At ≥1280px the layout above is exact. Between 1024–1279px the aside keeps the Generate button and collapses the Character/Preset tiles into two 40px chips appended to the front of the chip row. Below 1024px the aside wraps to a third row under the chips and the Generate button goes full width. No horizontal page scroll at any width.

**States.** Idle · focused (border goes to `color-mix(in srgb, var(--of-accent) 20%, transparent)`) · drag-over (§3.2) · submitting (button spinner only — the bar stays fully interactive) · error (a single-line inline message between prompt row and chip row, dismissible, never a modal).

**Persistence.** Composer state (prompt, references, per-model settings, last model) is written to SQLite on a 500 ms debounce and restored on reload. **Reuse** (§0.1) loads a stored job set's prompt, references, model and settings into the composer and does not run; when the current prompt is non-empty the load is confirmed first, and settings the target model cannot accept are dropped with one toast listing them.

### 3.2 Prompt editor

- **Editor**: multi-line, auto-growing textarea. Resting height 40px, grows with content to a max of 112px, then scrolls internally; the bar grows downward-anchored so the bottom edge stays at 16px. Plain text only in v1 — no rich formatting — but mention tokens render as inline chips (below).
- **Placeholder**: "Describe the image you want to make." (our copy).
- **Keyboard**: `Enter` inserts a newline; `⌘/Ctrl+Enter` submits; `Esc` blurs and closes any open popover; `⌘/Ctrl+M` focuses the model chip (`⌘K` is the command palette everywhere — §0.9, §2.6); `@` opens the mention typeahead. Submitting from the keyboard runs the same validation path as the button.
- **Paste image**: pasting one or more images from the clipboard adds them as reference images. Pasting a mix of text and images inserts the text and attaches the images.
- **Drag & drop**: the **whole app window** is a drop target. On `dragenter` with files, a full-window overlay appears (dimmed backdrop, dashed 2px accent border inset 24px, label "Drop images to use as references"). Dropping anywhere attaches them to the composer; dropping onto a canvas node is handled by §7 instead.
- **Attach button** ("+", 32×32): opens the OS file picker, `accept="image/jpeg,image/png,image/webp,image/heic"` (`.jpg,.jpeg,.png,.webp,.heic` — the ingest set of §0.6; HEIC is transcoded to PNG on ingest), `multiple` (the reference product used single-file inputs; multi-select is our improvement). Non-matching files are rejected with a toast naming the file. Files are rejected above `min(20 MB, capabilities.references.maxBytes)`; files above the model's pixel limit are downscaled server-side on submit with a note in the job record.
- **Reference strip**: attached images render as a horizontal strip between the attach button and the editor, 56×56 tiles, `radius: 8`, 6px gap. Each tile has a hover ✕ (remove, 16px, top-right) and is drag-reorderable. The **first tile is the primary reference** and carries a 2px accent border — same convention as the reference thumbnails in the detail view (§4). Tile count is capped at `capabilities.references.max`; the attach button disables at the cap with tooltip "Nano Banana Pro accepts up to 14 reference images."
- **Per-reference weight**: shown only where `capabilities.references.strengthMode` declares it (§0.3). `"per-image"` → each tile gets a long-press/right-click weight popover with a 0–1 slider (default 1.0) and the weight badged on the tile; `"global"` → a single "Reference strength" chip appears in the settings row (the captured payload carries one `custom_reference_strength: 1` for the whole run, which is why a Higgsfield-style adapter is `global`); `"none"` → no weight UI, images are passed as plain references.
- **`@`-mentions** (ships M1, task M1-17 — §0.14). *Observed*: the source product's editor is a Lexical instance with typeahead listboxes, and its server-side "Elements" entity is referenced from the prompt with `@`. **That entity is not reproduced.** *Our design*: typing `@` opens a typeahead popover (anchored to the caret, 320px wide, ≤6 rows + "Search all…") over four groups — **Presets**, **Characters**, **Reference sets**, **Saved references** — resolving Openfield objects only (§0.8). Selecting one inserts an atomic token chip (`@Dusk Portrait`, accent-tinted, one backspace deletes the whole token). At submit the server resolves tokens in `normalize()` step 1 (§0.8): a Preset token contributes its template and reference images, a Character token its reference bundle and identity phrase, a Reference set token its ordered reference images at their stored weights and roles, a Saved reference an image; the token's own text leaves the literal prompt string. The resolved `promptAfterPreset` is frozen onto the job set (§0.11), so Reuse and Recreate are exact.

### 3.3 The settings chip row

The **model chip is pinned** as the first item and does not scroll; every other chip lives in the scrolling track, ordered by `capabilities.controlOrder` (§0.3). Chips are a `role="toolbar"`: ←/→ move focus, `Enter`/`Space` opens the popover, `Esc` closes and restores focus. Every popover is anchored **above** its chip, bottom-aligned to the chip's top edge, `background: var(--of-surface-sheet)`, `radius: 16`, rows of *title + muted 12px subtitle*, accent check on the selected row — matching the observed popover pattern.

Chip visual states: **default** (value = model default), **set** (value differs from default → label in full-opacity text), **active** (popover open → `color-mix(in srgb, var(--of-accent) 20%, transparent)` border), **emulated** (small `~` glyph before the label, explained in the popover), **disabled** (40% opacity, `aria-disabled`, tooltip explains why), **invalid** (destructive border + tooltip; blocks submit).

| Chip | `ControlId` | Trigger label | Control | Notes |
|---|---|---|---|---|
| Model | `model` | provider icon + model name + chevron, ~129px | Searchable popover, 402×642 | 3.4.1 |
| Aspect ratio | `aspect` | ratio glyph + value, e.g. `3:4`, ~72px | Radio list from the manifest | Proportional rectangle glyph per row |
| Resolution / Quality | `resolution` · `quality` | `2K`, `High`, ~62px | Radio list from the manifest | Separate chips when a model exposes both (e.g. OpenAI: Quality + Resolution) |
| Images | `batch` | `− 1/4 +`, ~106px | Stepper 1–4 | 3.4.2 |
| Enhance | `promptEnhance` | wand icon + `Off`/`On`, ~65px | Toggle + settings popover | 3.4.3 |
| Avoid | `negativePrompt` | `Avoid` (+ dot when set) | Popover with 3-line textarea | 3.4.4 |
| Seed | `seed` | `Seed 469445` + dice + lock | Number field + randomise + lock | 3.4.5 |
| Background | `background` | `Auto` / `Opaque` / `Transparent` | Radio list | 3.4.6 |
| Reference strength | `referenceStrength` | `Ref 1.0` | 0–1 slider | Only when `references.strengthMode === "global"` |
| Advanced | `advanced` | `Advanced` (+ count badge) | Schema-driven form | 3.4.7 |

### 3.4 Per-control specifications

#### 3.4.1 Model picker

Popover 402×642, anchored above the chip, top-aligned search input ("Search models…", magnifier icon, filters on model name, provider and description). Rows are 56px: 32px rounded provider icon tile, name 14px + badges, description 12px muted, accent check on the right of the selected row.

Our version does **not** hardcode a catalog. Rows come from the model registry (§6), which merges (a) allow-listed runtime discovery where the provider exposes it and (b) the adapter's static catalog (§0.3). Grouping differs from the reference product's editorial "Featured / All": we show **Recent** (last 5 used, session-persistent), then one section **per provider** in registry order, then **Needs a key** (models whose provider has no API key — rows greyed, subtitle "Add an OpenAI key in Settings", clicking jumps to Settings). This is the grouping §8.8 row 19 and task M1-04 build; **badges are capability-derived, never marketing**: `Edit` (`ops.imageEdit`), `14 refs` (`references.max`), `Transparent` (`background.values` includes `transparent`), the top tier of `resolution.tiers` (e.g. `2K`), `New` (registry `releaseDate` within 60 days), written in sentence case and uppercased by CSS (§0.15), plus a right-aligned price hint (`~$0.13 each`) when the manifest carries a pricing snapshot.

Selecting a model writes `?model=<providerId>:<modelId>` to the URL (deep-linkable, matching the observed behaviour — §0.2), swaps the chip row per §3.5, and closes the popover. Keyboard: type-to-filter, ↑/↓ to move, `Enter` to select.

#### 3.4.2 Batch stepper

`−  n/4  +`, 106px, range 1–4, default 1. The `−` button is disabled at 1 and `+` at `capabilities.batch.max` (≤ 4 in v1 everywhere — §0.10). Where `capabilities.batch.native === false` the adapter emulates the batch as N sequential/parallel calls and the chip shows the `~` emulated glyph with tooltip "Each image is made and billed separately." The batch count multiplies the cost estimate (§3.6) and produces N placeholder tiles in the feed.

#### 3.4.3 Prompt enhance (our local implementation)

Ships in v1 (M1, task **M1-16**). §8.8 row 13 reads **✅ M1 — local rewrite through a user-configured text model; chip disabled with "Add an OpenAI or Google key to use this" when none is configured** (§0.14). Off by default. The chip is a toggle showing `Off`/`On`; clicking the chevron area opens its settings popover:

- **Enhancer model**: a select over the registry's *text* models (user's own key — the same Settings-stored keys; no Openfield-hosted service, no third key).
- **Rewrite style**: `Detailed` (default) · `Cinematic` · `Clean up only`.
- **Mode**: `Preview first` (default) · `Apply automatically`.

Flow in preview mode: pressing Generate first calls the enhancer server-side, then shows a **diff sheet** above the bar (the 1120×540 hero sheet of §3.6) with the original prompt on the left, the rewrite on the right, changed spans highlighted, and actions `Use & generate` · `Edit` (loads the rewrite into the editor, cancels the run) · `Cancel`. In automatic mode the run proceeds immediately and a toast offers **Undo** for 8 s; Undo cancels queued jobs from that submit and restores the original prompt. Either way the job set stores both the sent `prompt` and `prompt_original` (§8.2), so Reuse restores what the user actually typed and the detail view shows both. The enhancer call is priced as its own line in the estimate tooltip and written to the usage log. If no text-capable key exists the chip is disabled with the copy above.

Models whose manifest declares `promptEnhance: "native"` send the provider's own flag instead of calling our enhancer — the popover then reads "Enhanced by the model" and hides the enhancer-model select. `"openfield"` uses the local path above; `"none"` hides the chip.

#### 3.4.4 Negative prompt

Popover with a 3-line textarea, placeholder "What to leave out", 400-char soft cap, `⌘/Ctrl+Enter` closes. Non-empty → chip shows a dot and the first 18 characters. Resolution follows §0.3: `negativePrompt: true` → sent as the provider's own field; `"negativePrompt"` in `capabilities.emulated` → appended to the prompt as a single trailing `Avoid: …` sentence (§0.8), the chip carries the `~` glyph and the popover says so; absent or `unsupported` → chip hidden (it is not in the core set).

#### 3.4.5 Seed

Chip contains a numeric field (0–2147483647), a **dice** button (randomise now) and a **lock** toggle. Seeds are generated server-side (§0.11); the composer never mints one.

- **Unlocked (default)**: the field shows the seed of the last completed run, greyed; the composer sends `seed: null` and the server generates one 32-bit seed per output and records it (§6.5 step 4).
- **Locked**: the entered seed is sent; for batch > 1 the server derives `seed, seed+1, … seed+n−1`.
- When the model supports seeds, the seed used is recorded per job and Recreate is exact. **No launch adapter declares seed support (§6.13, §6.14), so on every v1 model the Seed chip is disabled with a reason and Recreate is an exact replay of the request, not a reproduction of the image.**
- `capabilities.unsupported.seed.reason` is the tooltip, naming the model on the launch adapters ("Nano Banana Pro doesn't support seeds.", §3.5), and the chip renders disabled rather than hidden. This is deliberate: hiding it would hide the reason reproducibility is unavailable.

#### 3.4.6 Background transparency

Radio list `Auto` · `Opaque` · `Transparent`, from `capabilities.background.values` (as observed on GPT Image 2). Choosing `Transparent` clamps the output format to PNG or WebP; if the Output format control is set to JPEG the value is clamped and an inline note appears — "Saving as PNG to keep transparency." Hidden entirely when absent or `unsupported`.

#### 3.4.7 Advanced (schema-driven)

Provider-specific extras never get bespoke chips. Each manifest ships `capabilities.extraSchema` — a restricted JSON Schema (`enum`, `number` with min/max/step, `integer`, `boolean`, `string`, `string[]`, each with `title`, `description`, `default`) — and the Advanced popover renders it mechanically: enum → segmented control (≤4 options) or select; number → slider + numeric input; boolean → switch; string → single-line input. A "Reset" link per field and "Reset all" in the footer. The chip badges the number of fields differing from default (`Advanced 2`). Anything §0.3 names as a `ControlId` gets its own resolved control and never appears here; Advanced carries only what `extraSchema` declares. Values travel in `GenerateRequest.providerOptions` (§0.6) under the schema's own field names and reach the adapter verbatim. Examples at launch: Google `thinking` (Pro) and `grounding`; Higgsfield `style_strength`, `use_refiner`, `model_version`.

### 3.5 Capability-driven rendering

Every control on every surface resolves through the single function of §0.3 — `resolveControl(caps, id)` → `{ state, options?, default?, reason? }` — before render. There are exactly five `ControlState` outcomes and nothing else is allowed:

| `ControlState` | Where it comes from | UI outcome |
|---|---|---|
| `supported` | the capability's own `options[]` + `default` | Chip renders; the popover lists **the model's own option list**, never a house list; the model's default is preselected unless a carried value applies (3.5.1) |
| `partial` | `Capabilities.partial[controlId]` (`unavailable[]` + `reason`) | Chip renders; unavailable options are shown greyed with `reason` as subtitle and cannot be selected; the chip carries an info dot |
| `emulated` | `controlId` listed in `Capabilities.emulated[]` | Chip renders with the `~` glyph; popover header states how it is emulated and any cost consequence |
| `unsupported` | `Capabilities.unsupported[controlId].reason` | **Core set → chip renders disabled** with a tooltip naming the model, e.g. "Nano Banana Pro doesn't support seeds." Non-core → hidden |
| `absent` | key omitted from the manifest | Chip is not in the DOM |

**Core set** (always present so the bar never visually jumps between models): **Model · Aspect · Resolution/Quality · Images · Seed** — §0.3's set, unchanged. Everything else is hidden when `unsupported` or `absent`.

Rendering is pure: `renderChips(manifest, composerState)` returns the chip list from `controlOrder`; there is no per-model `if` in the UI. A model whose manifest is missing or fails validation renders as *prompt + batch + Generate* only, with an inline warning "Limited controls. Couldn't load this model's settings."

#### 3.5.1 Switching model mid-composition

Prompt, reference images and mention tokens are **never** dropped on a model switch (references beyond `references.max` stay attached but are marked "won't be sent" with an amber outline and block submit until removed or the count is reduced). For every other setting the rule is **carry → clamp → drop**, applied in that order:

| Setting | Rule on switch |
|---|---|
| Aspect ratio | **Carry** if the exact ratio exists in the new list. Else **clamp** to the numerically nearest ratio (compare `w/h`; tie → the wider one). If the old value was absent and the new model offers `Auto`, pick `Auto` |
| Resolution / Quality | **Clamp ordinally**: map the old value to its normalised index in the old ordered list and pick the nearest index in the new list, never exceeding the new maximum (so a 4K choice clamps down rather than silently costing more) |
| Images | **Clamp** into `[1, min(4, capabilities.batch.max)]` |
| Seed (locked) | **Carry** if `seed.supported`; if not, keep the value in the stash and disable the chip — the number is not lost |
| Enhance | **Carry** the on/off state; switch between `native` and `openfield` implementations silently |
| Avoid | **Carry** the text; if the new model lists `negativePrompt` in `emulated`, the chip gains `~`; if absent or `unsupported`, the text goes to the stash and the chip disappears |
| Background | **Carry** if the value exists in `background.values`, else **drop** to stash |
| Reference strength | **Carry** the number when the new model's `references.strengthMode` is also `global`/`per-image`, else stash |
| Advanced / provider options | **Drop** on a provider change. On a same-provider change, carry any key that still exists in the new `extraSchema` with a still-valid value; drop the rest |
| Preset / Character (aside) | **Carry**. Presets are ours and model-agnostic (§0.8); a Character carried onto a model without `identity.nativeCharacterRefs` switches to reference-bundle emulation and the tile shows `~` |

**Stash + notification.** Dropped and clamped values are kept in a per-model `carriedSettings` stash for the session; switching back to the earlier model restores them exactly. Any switch that changed ≥1 value raises one toast: "Adjusted 2 settings for GPT Image 2.5 Flare: 4:5 → 4:3, 2K → 1K · **Undo**" (8 s; Undo reverts the whole model switch). Nothing is silently changed and nothing is silently lost.

### 3.6 The aside: preset tile, character tile, and the primary action

**Preset tile (144×84)** — our open substitute for the proprietary style/moodboard system. Shows the active preset's thumbnail with its name and a blurred "Change" pill (12px/500, `radius: 8`, `backdrop-filter: blur(4.5px)`). Clicking opens the **hero sheet** — the observed non-popover pattern: a panel *above* the bar, 1120×540, `radius: 20`, `padding: 4`, ✕ top-right, page dimmed behind. The sheet has our own hero band (headline, one-line description, primary CTA "Create a preset"), a tab row (**Curated** | **Mine**), a right-aligned search field, and a 6-column card grid (16:9 thumbnail + name); the tabs, hero copy and empty state are §5.2's — this section specifies only the tile that opens the sheet.

A preset is the object specified in §5.3. `presetStrength` maps to a native parameter when `capabilities.styleStrength` is true, otherwise selects the preset's `light` template variant, otherwise the slider is disabled with a reason (§0.8).

**Character tile (84×84)** — "+" icon over a caps label, our open substitute for proprietary character IDs: a named bundle of 3–8 reference images plus an identity phrase (§0.8). Where `identity.nativeCharacterRefs` is true the adapter passes the native identifier; otherwise the bundle is injected as reference images, the seed is locked for the run where the model supports one, and the tile shows the `~` emulated glyph. Opens the same hero-sheet pattern with tabs **All | Mine** and a search field. The tile is hidden for models that declare neither native character support nor `references.supported`.

**Generate button (144×84, `radius: 12`, accent fill, `var(--of-on-accent)` text)**

- Label `Generate` (14–16px/600) with a **sub-label**: our replacement for the credit counter is a **cost estimate** — `About $0.27 · 2 images`. The composer computes it locally with the pure `estimate(manifest, req)` function (§0.13, §6.3) from the manifest already in memory — no HTTP round-trip on a chip change — and an optional `estimateRemote()` result upgrades the label in place; failing both, the literal text `Cost unknown` (never a guess presented as fact). Token-priced models (OpenAI) show a range: `About $0.12–0.19 · 2 images`, with the basis in the tooltip and the note "Prices as of Sep 23, 2026". Prompt-enhance adds its own line in the tooltip. Clicking the sub-label opens the usage log.
- **Disabled** only when the run cannot be sent: no model selected; the selected model's provider has no key (button becomes a secondary **"Add a key"** that deep-links to Settings); prompt empty *and* no reference images and the model is not reference-only; references over `references.max`; an Advanced field invalid. Each disabled reason has a tooltip.
- **Submitting**: an inline spinner replaces the sub-label **for the duration of the submit request only**. The button is *not* disabled and the form is *not* locked.
- **Not cleared, queueable** (explicitly matching the observed behaviour): after a successful submit the prompt, references and every setting stay exactly as they were, and the user can immediately press Generate again to queue another run. Concurrency is the server's: `globalConcurrency` 4, further clamped per provider by `min(providers.concurrency_cap, capabilities.limits.maxConcurrent)` (§8.4.2, §0.12). Beyond that, runs are queued and the button sub-label shows `2 queued` until they drain. `n` placeholder tiles are prepended to the feed on submit with the correct aspect ratio reserved (§2.4).

### 3.7 Per-model control matrix — launch adapters

**Which chips render**, per launch model, as researched 2026-09-23. **Option lists are the adapter static catalogs in §6.13–§6.15; this table shows only which chips render.** Registry ids are `ModelKey` (§0.2). `~` = emulated by the adapter.

| Model (`ModelKey`) | Chips, in order after Model | Images | Seed | Avoid | Background | References (`references.max`, `strengthMode`) | Aside |
|---|---|---|---|---|---|---|---|
| **Nano Banana Pro** `google:gemini-3-pro-image` | Aspect · Resolution · Advanced · 1/4 | 1–4 `~` | disabled (undocumented) | `~` | hidden | 14, `none` | Preset · Character `~` |
| **Nano Banana 2** `google:gemini-3.1-flash-image` | Aspect · Resolution · Advanced · 1/4 | 1–4 `~` | disabled (undocumented) | `~` | hidden | 14, `none` | Preset · Character `~` |
| **Nano Banana 2 Lite** `google:gemini-3.1-flash-lite-image` | Aspect *(the standard ten, verified at M0-07)* · Resolution *(single tier in §6.13 → rendered disabled)* · 1/4 | 1–4 `~` | disabled (undocumented) | `~` | hidden | 14, `none` | Preset · Character `~` |
| **GPT Image 2.5 Sunburst** `openai:gpt-image-2.5-sunburst` | Aspect · Quality · Resolution · Background · Advanced · 1/4 | 1–4 native `n` | disabled (unconfirmed) | `~` | Auto/Opaque/Transparent | 4 (cap; provider limit unconfirmed), `none` | Preset · Character `~` |
| **GPT Image 2.5 Flare** `openai:gpt-image-2.5-flare` | Aspect · Quality · Resolution · Background · Advanced · 1/4 | 1–4 native `n` | disabled (unconfirmed) | `~` | Auto/Opaque/Transparent | 4 (cap; provider limit unconfirmed), `none` | Preset · Character `~` |
| **GPT Image 2** `openai:gpt-image-2` | Aspect · Quality · Resolution · Background · Advanced · 1/4 | 1–4 native `n` | disabled (unconfirmed) | `~` | Auto/Opaque/Transparent | 4 (cap; provider limit unconfirmed), `none` | Preset · Character `~` |
| **Soul 2.0** `higgsfield:soul-v2-standard` *(only if the public API exposes it to a user key)* | Aspect · Quality · Enhance · Avoid · Seed · Ref strength · Advanced · 1/4 | 1–4 native `batch_size` | editable (native) | native | hidden | native `medias[]`, `global` (`custom_reference_strength` 0–1) | Preset (maps to native `style_id` + `style_strength`) · Character (native character id if exposed, else `~`) |

**Display names are the names the model's own company uses**: Google's Nano Banana names and OpenAI's GPT Image names (§6.13, §6.14). API ids stay in the model keys. The Resolution chip on all three OpenAI models offers **1K · 1.5K** only: the Images API documents 1024×1024 / 1536×1024 / 1024×1536 plus custom dimensions in multiples of 16, with no 2K and no 4K (§6.14, researched 2026-09-23). The reference product's chip set reflects its own proxy, not the OpenAI API; where they disagree the API wins.

As in the captured payload, the quality label and the aspect ratio resolve to explicit `width`/`height` in the request (e.g. 2K + 3:4 → 1536×2048); that mapping lives in each manifest, never in the UI.

### 3.8 Acceptance criteria

1. At 1440×900 the composer measures 1116×142 with the geometry in §3.1 (±1 px), and no page-level horizontal scrollbar appears at any width from 768 px up.
2. The prompt editor grows from 40 px to at most 112 px and then scrolls internally; the bar's bottom edge stays at 16 px throughout.
3. No computed style in the composer resolves from a raw hex or rgba literal: every fill, border and text colour traces to an `--of-` token (§0.1).
4. Pasting an image, dropping an image anywhere in the window, and the attach button all produce identical reference entries; a `.gif` is rejected with a named toast.
5. Switching a model set to `4:5` + top resolution tier to one offering neither clamps the ratio to the nearest offered and the resolution down (never up), keeps the prompt and references untouched, raises exactly one toast listing both changes, and restores the original values when the user switches back.
6. A control whose key is absent from the manifest is not in the DOM; a **core-set** control that is explicitly `unsupported` is in the DOM, `aria-disabled`, and its tooltip names the model; a non-core `unsupported` control is not in the DOM.
7. On a model whose manifest declares `seed.supported`, two consecutive identical submits with the seed unlocked record two **different** `jobs.seed` values; with the seed locked, batch 3 records `s, s+1, s+2`. The assertion is over the recorded `jobs.seed` rows, not the request body — the composer sends `seed: null`. On every v1 launch model the chip is disabled and `jobs.seed` stays NULL.
8. Prompt enhance is off on first run; turning it on in preview mode shows the diff sheet before any provider call, and Undo after an automatic enhance cancels queued jobs and restores the typed prompt.
9. After submit, prompt, references and all settings are unchanged, the button is enabled within the same frame the request resolves, and a second submit queues a second run.
10. The Generate sub-label shows an `About $` estimate that scales with the batch count, or the literal text "Cost unknown" — never a fabricated number — and changing a chip fires **no** network request to compute it.
11. With no key for the selected model's provider, the primary button reads "Add a key" and routes to Settings; no request is attempted.
12. Every chip is reachable and operable by keyboard alone, and each popover returns focus to its chip on close.

### 3.9 Open questions

- The `Off` chip with a wand icon on Soul 2.0 was read as prompt-enhance from context and its tooltip, but the toggle's on-state payload was not captured — our local enhancer design does not depend on it.
- The exact width and placement of the reference-image strip *inside* the reference product's prompt bar was not observed (only the 72 px reference thumbnails in its detail panel); the 56×56 strip in §3.2 is our design.
- Whether the reference product allows per-reference weights at all; the captured payload carries a single `custom_reference_strength`, which is why `global` is the default `strengthMode`.
- OpenAI's maximum reference-image count for edits (docs say "2+"); we cap at 4 pending the live probe in task **M2-15**.
- Whether the Higgsfield public API exposes style presets, character IDs and a cost-estimate endpoint to a user key; if not, the Soul 2.0 row in §3.7 ships without the native mappings and everything falls back to our preset/character system (§0.13).
- The keyboard shortcut the reference product uses to submit was not captured; `⌘/Ctrl+Enter` is our choice.

---

## 4. Image detail view and the editor

Clicking any tile in the feed opens the **detail view**: a full-viewport overlay that shows one asset large, everything we know about it, and — on the Edit tab — a working editing surface. It is the single place where an image is inspected, recreated, reused, exported and edited. The overlay never changes the underlying route stack: closing it returns the feed exactly as it was, at the same scroll offset.

This section owns the overlay's geometry, its tabs, the editing surface, the nine edit tools and the requirements the editor places on the data model. Shared contracts it used to restate — the action vocabulary (§0.1), the capability manifest (§0.3), the `Op` union and job states (§0.4), the request body and endpoints (§0.6), lineage columns (§0.7), mask polarity and the regional fallback (§0.9), the thumbnail ladder (§0.10), seeds (§0.11), cancellation (§0.12), cost (§0.13) and the v1 scope list (§0.14) — are cross-referenced, not repeated.

### 4.1 Overlay shell and geometry

Radix `Dialog` rendered into a portal, `position: fixed; inset: 0`, above the composer and the feed. Reference geometry below is measured at 1440×900 and holds from 1280px up; below 1100px the panel collapses (§4.10).

| Element | Spec |
| --- | --- |
| Backdrop | The asset itself, `object-fit: cover`, scaled to 110%, `filter: blur(48px) saturate(1.15) brightness(0.45)`, with a `var(--of-scrim)` layer above it. The blurred copy is the `@h360` thumb rung (§0.10), not the full file, so the overlay paints in one frame. |
| Media area | The viewport minus the panel gutter: `left: 0; right: 368px` (352 panel + 8 inset + 8 gap). The image is centred in that box and fit to height with a 15px inset on all sides, never upscaled past 100% of its natural size at zoom 1. At 1440w this reproduces the observed ≈x190–890 placement for a 3:4 asset. |
| Media-area overlay buttons | Bottom-right of the media box, two 32px round buttons, 8px apart: **Add note** (our replacement for the reference product's "Add comment") and **Expand image** (fullscreen). |
| Right panel | `top/right/bottom: 8px`, width **352**, height `calc(100vh - 16px)` (884 at 900), `border-radius: 20`, `background: color-mix(in srgb, var(--of-elevated) 75%, transparent)` + `backdrop-filter: blur(20px)`, `padding: 8`, `border: 1px solid var(--of-border)`. |
| Panel header | 32px round asset badge + asset title line + caption underneath; **Close** button 32px round, `background: var(--of-elevated-2)`, right-aligned. Since Openfield is single-user, the header shows the **source model badge** (provider glyph + model name) and the relative created time as the caption, instead of an author row. |
| Tabs | Segmented control, three items **106w × 32h**, 12px/500, `border-radius: 8`, container inset 8px below the header. |
| Content column | 318px wide, centred in the panel; all action buttons and rows below use this width. |

Colours are Openfield tokens (§2.2, namespaced per §0.1); only geometry — sizes, radii, blur radii, gaps — is carried over from the measurements. The accent (`--of-accent`) is our own and is used for selection rings, the active version and primary CTAs; we use none of the reference product's colours, glyphs or copy, and every label in this section is ours.

### 4.2 Tabs: Info · Edit · History

The reference product's third tab is **Comments** — a social thread on a shared asset. It is meaningless in a single-user local app, so we **replace it with History**, keeping the same 3×106px segmented geometry:

- **Info** — prompt, references, parameters (§4.3).
- **Edit** — the editor (§4.5–4.8).
- **History** — the lineage tree for this asset (ancestors up to the root, siblings from the same job set, and every asset derived from it), each row showing the `Op` that produced it (§0.4: `generate`, `inpaint`, `outpaint`, `grade`, `upscale`…), its model and its cost; clicking a row swaps the overlay to that asset without closing. Below the tree, a free-text **Notes** field (autosaving, markdown, full-text searchable from the feed's search) — this is what the "Add note" button in the media area focuses.

Tab state is remembered per session, not per asset: opening the next image with → keeps you on the tab you were on.

### 4.3 Info tab

**PROMPT section.** Section header row: 16px icon + `PROMPT` caps label (11px/600, letter-spacing 0.06em) on the left, a **Copy** button **68×24**, `border-radius: 6`, `border: 1px solid var(--of-border-strong)` on the right. Copy writes the raw prompt text (not the enhanced one) and flips to "Copied" for 1.2s.

- **Reference thumbnails row** directly under the header when the job had any: 72px squares, `border-radius: 8`, horizontally scrollable; the primary/first reference carries a 2px `var(--of-accent)` border. Clicking a thumbnail opens that reference full-size; ⌥-click adds it to the composer's reference strip.
- **Prompt text**, 14px/1.5, clamped to 6 lines, with a **See all ⌄ / Hide** toggle when it overflows. If the run used prompt enhancement, a second collapsed block **Enhanced prompt** appears beneath with the same treatment and a small "enhanced" badge.

**DETAILS section.** Collapsible (chevron in the header, open by default, state persisted). Key/value rows, key 12px muted left, value 12px right-aligned, 28px row height. The reference product shows four rows (Model, Quality, Size, Created); we show everything a local BYOK app can honestly show:

| Row | Value | Notes |
| --- | --- | --- |
| Model | e.g. `Nano Banana Pro` | resolved `displayName` from the model registry (§6.13) |
| Company | e.g. `Google` | provider glyph + name |
| Quality / Resolution | e.g. `2K` | whichever axis the model exposes; both rows if it exposes both |
| Size | e.g. `1856×2304` | actual pixel size of the stored file |
| Aspect | e.g. `3:4` | requested ratio, marked `~` if the model returned something else |
| Seed | integer, or `None` with tooltip "This model doesn't support seeds" | §0.11; no launch adapter declares seed support |
| Cost | e.g. `About $0.134` | from the usage log (§0.13); `About` prefix when the provider gave no billed figure |
| Duration | e.g. `18.4s` | submit → file on disk |
| Created | long local date-time | rendered through `Intl.DateTimeFormat` with the system locale (§2.12) — never a hardcoded US format |
| File | filename + size, click to copy path | |

Every row supports click-to-copy. A footer link **Copy settings as JSON** yields the frozen `NormalizedRequest` stored on the job set (§0.11), which is what makes a run reproducible outside the app.

### 4.4 Action row

Pinned to the bottom of the panel, 8px gap between rows, 318px content width. The three iteration actions and their exact spellings are defined in §0.1.

1. **Send to… — 318×40**, primary/accent, `border-radius: 10`. Opens a menu: **Canvas** (creates an Image node on a new or chosen canvas, pre-wired with this asset as its image input, §7), **Editor** (switches to the Edit tab). **Video is absent, not disabled** (§0.14): the job and asset model is modality-agnostic, so the entry appears when video lands, without a migration. Any item we do disable states its reason inline; we never show a dead control with no explanation.
2. **Recreate | Use as reference — 2 × 155×40**, `background: var(--of-elevated-2)`, `border: 1px solid var(--of-border-strong)`. This matches the observed `[Recreate | Reference]` slot.
   - **Recreate** replays the frozen `NormalizedRequest` stored on the job set — same model, same params, same recorded seed — without touching the composer, and prepends placeholder tiles to the feed exactly as a normal run does. When the model has no seed support the button carries a small `~` badge and the tooltip reads "This model can't make an exact copy. Expect changes."
   - **Use as reference** attaches the image to the composer's reference strip and loads nothing else.
3. **Download 155 | Favourite 46 | Share 46 | More 46**, all 40h, same secondary treatment, 8px gaps.
   - **Download** saves a copy through the OS save dialog; default filename `openfield_{created:yyyymmdd-hhmm}_{model}_{shortid}.{ext}`. Holding ⌥ downloads with a `.json` sidecar containing the full parameter set.
   - **Favourite** is a filled/outline heart, optimistic, written straight to SQLite.
   - **Share** is local-only — no social targets: **Copy file path**, **Show in Finder** (label follows the platform: "Show in Explorer" / "Show in file manager"), **Copy image**, **Copy prompt**, **Export with settings…**.
   - **More**: *Reuse* (loads prompt, references, model and every setting into the composer without running; settings the current model cannot accept are dropped with one toast listing them), *Save as preset…* (opens the preset editor pre-filled with prompt + settings), *Duplicate as draft*, *Add to folder ▸*, *Open folder*, *Copy settings as JSON*, *Delete* (destructive, `--of-danger`, confirm dialog, lineage-safe per §4.9).

Keyboard: `R` = Recreate, `U` = Use as reference, on this surface and on the feed tile alike (§2.6).

### 4.5 Keyboard, zoom and fullscreen

**§2.6 publishes the one global shortcut table** — `R` Recreate, `U` Use as reference, `F` Favourite, `⇧F` Expand image, `D` Download, `⌘K` command palette. This section adds only the keys that exist because the overlay exists, plus the Edit-tab tool letters.

| Key | Action |
| --- | --- |
| `→` / `←` | next / previous asset **in the feed's current order and filters**; the feed scrolls the corresponding tile into view behind the overlay; at either end the action is a no-op with a 120ms nudge animation |
| `Esc` | Info/History: close. Edit: first press cancels the active selection or tool back to Select, second press closes (with an unsaved-edit confirm if a mask or local adjustment is pending) |
| `⇧F` | toggle Expand image (panel hides, image fits the full viewport, a single floating Close button remains) |
| `+` / `-` / `0` | zoom in / out / fit-to-view |
| `Space` (hold) | temporary Hand/pan, in both tabs |
| `1` / `2` / `3` | Info / Edit / History |
| `V H M A D E R T` | editor tools (§4.6) — only live on the Edit tab |

**On the Edit tab, tool letters take precedence over surface actions, and Download moves to `⌘⇧S`.** That precedence rule is also stated in §2.6, so the two tables cannot drift.

Unlike the reference product (whose URL does not change while arrowing), we `history.replaceState` a `?asset=<id>` param so a reload or an accidental refresh restores the same overlay; `Esc` restores the feed URL. This is a deliberate, small local-first improvement, not a layout deviation.

Zoom is pointer-anchored (wheel + ⌘/ctrl, pinch on trackpad) from 5% to 1600%, clamped so the image can never be panned fully off-screen. Closing the overlay emits an `asset.viewed` event; the feed tile then carries the **Last viewed** eye badge (§2.4).

**Acceptance criteria.** Arrowing through 200 assets never triggers a full-image fetch for an off-screen asset (thumbnail first, full file lazily); `Esc` from a clean Edit tab closes in one press after the tool is already Select; `⇧F` then `Esc` returns to the panelled layout, not to the feed.

### 4.6 The editor

The Edit tab turns the media area into a canvas-style edit surface. Nothing here mutates the asset on disk: the surface composes the base asset, an optional mask layer, and local adjustment layers, and only **Generate**/**Apply** commits a new asset (§4.9).

- **Version strip** — vertical, pinned to the left edge of the media area, 40×40 thumbnails, 8px gap, `border-radius: 8`. First item is **Original** (the lineage root), then every version in creation order; the current one carries a 2px `var(--of-accent)` border. Selecting an older version loads it as the edit base — generating from it creates a *branch*, and branched versions render with a small fork glyph in the corner. The strip scrolls independently and pins Original and Current when it overflows.
- **Zoom cluster** — bottom-left, `[ − | 100% ▾ | + ]`; the middle control is a menu with Fit to view, 25/50/75/100/150/200%, and Actual size.
- **Tool bar** — floating, horizontally centred above the edit prompt bar, 36px square buttons, groups separated by a 1px divider:

| Tool | Key | What it produces | Required capability | Behaviour when unsupported |
| --- | --- | --- | --- | --- |
| Select | `V` | bounding box with resize + rotate handles, and the inline regional prompt (§4.7) | `ops.inpaint`, or the regional fallback (§0.9) | falls back to whole-image instruction edit, box hidden |
| Hand | `H` / hold Space | viewport pan | none (local) | always enabled |
| Edit area | `M` | rectangular mask region | `ops.inpaint` | regional fallback, **Approximate** badge |
| Lasso | `A` | freeform polygon mask | `ops.inpaint` | regional fallback, **Approximate** badge |
| Brush | `D` | painted raster mask, size 1–512px, hardness 0–100 | `ops.inpaint` | disabled, tooltip names the model |
| Eraser | `E` | unpaints mask | `ops.inpaint` | disabled with the same tooltip |
| Shapes | `R` | rectangle / ellipse / line; **Mask** mode fills the mask, **Overlay** mode composites locally | Mask mode: `ops.inpaint`; Overlay mode: local | Overlay mode always available |
| Text | `T` | local text overlay layer (font, size, colour, alignment) rasterised on Apply | local | always enabled |

`V`, `H`, `D`, `E` and `R` are the shortcuts the reference toolbar was observed to use, and `R` for Shapes matches the canvas Shape tool (§7.9) so the same tool has one key in both workspaces. **Edit area (`M`) and Lasso (`A`) are our own assignments; no shortcut was observed for them.** The observed image toolbar has no Text tool (Text lives in their canvas toolbar); we add it here because a local, non-generative text overlay is cheap, deterministic and something no BYOK model does reliably.

**Capability mapping.** The editor reads only §0.3's manifest keys: `ops.imageEdit`, `ops.inpaint`, `ops.outpaint`, `ops.upscale`, `ops.removeBackground`, `ops.detectText`, `ops.decomposeLayers`, `references.supported`, `seed.supported`, and `background.values` containing `"transparent"`. Every control on this surface is resolved through §0.3's single `resolveControl()` rule, so a tool row, a composer chip and a canvas node footer disable for the same reason and with the same copy. Which launch adapter declares what is stated once, in §6.13 (Google) and §6.14 (OpenAI); nothing here hardcodes a model name.

**Mask format.** Openfield's canonical mask is defined in §0.9 — alpha = 0 marks the region the model must regenerate, alpha = 255 preserves, and **RGB channels are ignored**. The editor exports exactly that, at the base image's exact pixel size. **Committing a mask uploads it once via `POST /api/masks`; the edit request carries only its `maskAssetId` — no base64 crosses the interface.** The edit body is §0.6's `GenerateRequest` with `mask: { assetId, invert?, featherPx? }`, never a data URL. Each adapter translates to its provider's polarity and covers it with a fixture test; the OpenAI polarity is unconfirmed until the live probe (task M2-15) lands.

**Regional fallback for instruction-only models.** Specified once in §0.9. In this surface it shows up as: the tool stays enabled, the committed asset carries an **Approximate** badge in the version strip and in the History row, and the tooltip says why. We never present an emulated regional edit as a true inpaint.

### 4.7 Edit prompt bar and the on-selection prompt

- **Edit prompt bar** — floating, bottom-centred in the media area, **≈590 × 60**, pill radius 30, `background: color-mix(in srgb, var(--of-surface) 96%, transparent)`, `backdrop-filter: blur(10.45px)`, 1px `var(--of-border)` hairline. Contents: **+** add reference image (28px round), a single-line-growing text field with placeholder **"Describe how to edit this image…"**, and a 40px round accent **Generate** button. To its right (outside the pill, 8px gap) sits the **cost estimate chip** — e.g. `~$0.04` — computed locally from the manifest per §0.13 and recomputed as settings change; it reads `Cost unknown` when the provider publishes no per-call price (§0.15).
- With no mask painted, Generate runs a whole-image instruction edit. With a mask or selection present, the same button runs a masked edit and the placeholder switches to **"Describe the change inside the selection…"**.
- **On-selection prompt.** Drawing or selecting a region shows a small floating prompt directly on the selection — placeholder "Describe the change…" plus a round accent sparkle button — anchored below the selection box and flipped above when it would fall off-screen. Submitting it is identical to submitting the bar with that mask; the bar dims to show which one is active.
- **While an edit runs:** the version strip appends a skeleton thumbnail with a spinner, the surface stays interactive, tools are not locked, and a **Cancel** pill sits over the skeleton. Cancellation semantics and the copy that goes with them are §0.12's, including the warning that a provider may still charge for work already started.
- **When the model lacks `ops.imageEdit` entirely**, the whole bar is replaced by a single inline notice: *"{Model} can't edit images. Pick a model that can."* with a model picker inline — the same picker as the composer, filtered to models whose manifest declares `ops.imageEdit`. Choosing one does **not** change the composer's model.

### 4.8 The EDIT IMAGE tool list (right panel)

On the Edit tab the panel body becomes a list of tool rows: 20px icon, label, optional badge, chevron. A row opens a sub-panel with a back arrow, the tool's settings, and a footer CTA showing the **estimated cost** (§0.13) where the reference product shows a credit pill. Rows whose capability is missing render disabled with an inline reason; rows backed by a plugin slot with no plugin installed render disabled with a **Plugin** badge and a "How to add this" link to the docs. **A disabled row is a shipped row** — it is visible, explained and testable, never absent.

**What M2 must demonstrate** (the falsifiable form of §8.7's definition of done): whole-image instruction edit on **both** launch providers; masked inpaint and mask-synthesised outpaint on OpenAI GPT Image once the live mask-polarity probe (M2-15) lands; the regional fallback on Gemini with the **Approximate** badge; Upscale shipping as local resample only; Remove background rendering disabled with its reason. No launch adapter declares `ops.upscale` or `ops.removeBackground`, so a disabled row with correct copy is the pass condition for M2-08 and M2-09.

When the Select tool is active the list is replaced by the **LAYERS** section (a `+` add-layer button and a row per layer — Base, mask, each local overlay — with a visibility eye and a ⋮ menu for rename/duplicate/delete/merge), as observed; the tool rows are disabled while a selection is live. **LAYERS ships in M2**: Base + mask + local overlay layers (text, shapes, grade), with visibility, reorder, rename and merge (§0.14). Generative *layer decomposition* stays the disabled plugin slot in row 1.

The dispositions below are §0.14's binding list. §6.10's "what replaces the closed pieces" row reads off this table — the two are one decision, not two.

| # | Tool | v1 status | How it works / what it needs |
| --- | --- | --- | --- |
| 1 | **Layer decomposition** | **Visible disabled plugin slot** | No BYOK provider in the launch set declares `ops.decomposeLayers`. The row renders with a **Plugin** badge and a "How to add this" link; the settings UI is built and disabled. Interface: `decomposeLayers(image, { resolution: "1K"\|"1.5K"\|"2K", mode: "standard"\|"fast", layers: number }) → { png, bbox, name, z }[]`. Layers returned by a plugin land in the LAYERS section as real layers. |
| 2 | **Edit text** | **Ships, M2** | Two-step: `ops.detectText` on any configured multimodal model (Gemini `generateContent` or OpenAI chat with image input) returns `{id, text, bbox}[]` under a strict JSON schema and lists every text run; editing a line and hitting Apply issues an `edit` — or an `inpaint` using the bbox, where `ops.inpaint` exists — asking for the new wording in the original typography. Disabled with a reason when no multimodal model is configured. |
| 3 | **Expand & crop** | **Ships, M2 — split local + provider** | Drag edges/corners on the canvas. **Crop is local** (pure pixel op, zero cost, instant) and keeps local layers intact. **Expand** pads the canvas to the new bounds; with **Fill with AI** off it leaves transparency, with it on it needs `ops.outpaint` — the padded region becomes the mask. Instruction-only models get the regional fallback (§0.9) with the Approximate badge. Toggle disabled with a reason when neither exists. |
| 4 | **Upscale** | **Ships partially, M2 — local resample + plugin slot** | v1 ships a **local Lanczos resample at ×2 and ×4**, labelled honestly: *"Resizes, adds no detail."* Higher factors (×8, ×16) and any detail-adding upscaler are the plugin slot: `upscale(image, { scale, denoise?, sharpen?, faceEnhance? }) → image`, satisfied by a local Real-ESRGAN binary or a v1.1 fal/Replicate adapter. Settings mirror the observed panel (scale ×1 ×2 ×4 ×8 ×16, sharpness, denoise, face enhancement) with everything the installed plugin does not support disabled per its manifest. No launch adapter declares `ops.upscale`. |
| 5 | **Remove background** | **Visible disabled slot** | Needs a segmentation model; `background: "transparent"` on the OpenAI API applies to generation, not to an arbitrary existing image, and Gemini gives no alpha guarantee, so no launch adapter declares `ops.removeBackground`. Interface: `segmentSubject(image) → maskPng`. The repo documents a local ONNX (BiRefNet/rembg-class) plugin as the reference implementation. The row is visible and disabled with that reason — **that copy is the M2-09 pass condition** — and once a plugin is installed the produced mask feeds the mask layer, so the cut-out is immediately editable. |
| 6 | **Colour grading** | **Ships, M2 — local, non-generative** | A WebGL filter stack: exposure, contrast, temperature/tint, saturation/vibrance, lift/gamma/gain, grain, bloom, halation, vignette — applied live at 60fps on the GPU, committed on Apply by re-rendering server-side at full resolution. Ships **Openfield's own presets**: Neutral, Mono, Duotone Split, Skin Soften, Filmic, Super-16, Vintage Glass, Balance, Detail Soften, Glow, Halo, Exposure Trim, Grain. **Match reference** extracts a grade from a dropped reference image by local 3D histogram matching. `.cube` LUT import and export. Cost shows `Free`, works offline, works on every model. |
| 7 | **Enhancer** | **Ships, M2 — via provider capability** | Instruction-edit presets, no bespoke model: *Smooth skin*, *Natural skin*, *Textured skin*. Each is a stored, user-editable prompt template in the preset library (§5) applied as a whole-image or masked edit. Needs `ops.imageEdit`. |
| 8 | **Relight** | **Ships, M2 — via provider capability, best-effort** | Draggable light-direction sphere ("Drag to change the light direction") plus quick-select Top / Front / Right / Left / Back / Bottom; Soft/Hard; Brightness 0–100 (default 50); Colour `#FFFFFF`. The widget compiles a structured instruction ("key light from the upper-left, hard-edged, bright, neutral white; preserve subject, framing and identity") and submits it as an instruction edit. The panel carries the note "Results vary by model." because no provider exposes a true relighting model under BYOK. |
| 9 | **Angles** | **Ships, M2 — via provider capability, best-effort** | Draggable camera widget; Rotation 0°, Tilt 0°, Zoom 0. Compiles to an instruction edit ("rotate the camera 30° to the right, tilt 10° down, move slightly closer; keep subject, lighting and style"). The panel states plainly that this is a re-render, not a 3D reprojection, and that identity drift is expected. |

**Preset names in rows 6–7 are Openfield's own; the observed product's names are recorded in the research notes only, never shipped** (§1.11, R12).

Every enabled row's footer CTA carries the estimated cost and, on completion, the run is written to the usage log under its §0.4 `Op` (`relight`, `upscale`, `grade`…) so per-tool spend is visible.

Editor footer, under the tool list: **Download · Favourite · More** — the same handlers as §4.4, acting on the currently selected version in the strip.

### 4.9 Versions, lineage and non-destructive history

The rule is absolute: **no operation ever overwrites an image file.** Every commit — generative or local — writes a new file under `~/.openfield` and a new asset row.

Requirements the editor places on the data model (the schema itself is specified in **§8.2**, whose `assets` table carries these columns):

1. **Parentage.** Each asset records `parent_asset_id` (null for a root generation) and a denormalised `root_asset_id` so the version strip and History tab load in one indexed query (`idx_assets_root`) rather than a recursive walk.
2. **Operation record.** Each derived asset records its `Op` — §0.4's single union: `generate`, `edit`, `inpaint`, `outpaint`, `variation`, `upscale`, `remove_bg`, `text_edit`, `relight`, `angles`, `enhance`, `decompose`, `crop`, `grade`, `overlay` — plus the full op parameters as JSON and a reference to the mask asset when one was used. This makes every version re-openable with its original settings: re-entering the colour-grading panel on a graded asset restores its sliders.
3. **Provenance.** `provider_id`, `model_id`, resolved model display name, seed, cost, duration, and a `generative` flag. **Local ops (`crop`, `grade`, `overlay`) write `generative = 0`, `cost_usd = 0` and `provider_id = 'local'`.**
4. **Approximation flag.** Assets produced through the regional fallback (§0.9) carry `approximate = 1` plus `approximate_reason`, so the badge survives restarts and export.
5. **Branching.** Siblings sharing a `parent_asset_id` are branches. The strip shows the linear path to the current asset and a fork glyph where branches exist; the History tab shows the full tree.
6. **Batch identity.** Assets from one submit share a `job_set_id`, which is how the feed groups them and how "Other images from this run" renders in History.
7. **Deletion is lineage-safe.** Deleting an asset tombstones the row (keeps id, op record and parent pointer, drops the file) so descendants never lose their chain — which is why `parent_asset_id` carries no foreign key (§0.7). The strip renders a tombstone slot labelled "deleted". A "Delete this version and every edit made from it" option exists in the confirm dialog and is never the default.
8. **Modality-agnostic.** Nothing in the lineage model is image-specific: `modality` sits on the asset, and every field above applies unchanged when video lands.

In-session undo/redo (⌘Z / ⇧⌘Z, depth 50) covers uncommitted work only — brush strokes, selections, slider moves, text placement. Once Generate or Apply commits, the previous state is a version in the strip, not an undo step; the app says so with a one-time hint the first time a user commits.

**Acceptance criteria.** Applying a colour grade, then an inpaint, then an upscale yields four files on disk and a four-item version strip; deleting the second version leaves the third and fourth openable with their parameters intact; "Copy settings as JSON" on the fourth returns a payload that, replayed against the same provider, reproduces the fourth from the third.

### 4.10 Responsive behaviour

At ≥1280px the layout above is exact. From 1100–1280px the panel keeps 352px and the media area simply narrows. Below 1100px (tablet) the panel becomes a bottom sheet at 60% viewport height with the same tab control and content column (318px centred, capped to `100vw - 32px`); the editor tool bar drops the divider groups into a single scrollable row, and the version strip moves from the left edge to a horizontal strip above the prompt bar. Below 900px the editor is read-only: Info and History remain, and the Edit tab shows "Editing needs a wider window."

### 4.11 Open questions

- The detail-view **zoom/pan affordances inside the Info tab** were not measured — only the Edit-tab zoom cluster was. Our `+ / − / 0` and wheel-zoom on the Info tab is our own addition.
- **Version-strip thumbnail spacing, scroll behaviour and branch representation** were not observed; the 8px gap, the pinning and the fork glyph are our design.
- **Mask encoding expected by the OpenAI edits endpoint** (which alpha polarity, whether the mask must match the input's exact dimensions and format) is undocumented in the research. Task **M2-15** is a live probe with a recorded fixture, and it is a blocking prerequisite for M2-05/M2-06.
- **Seed support on the Gemini image models** is not documented; until confirmed, Recreate on those models carries the `~` badge and its tooltip (§0.1, §0.11).
- Whether the **Higgsfield public API exposes inpaint / upscale / relight job types** at all (only the Soul v2 standard endpoint is confirmed) — this decides whether a Higgsfield adapter can light up rows 2–9 or only whole-image instruction editing.
- Exact behaviour of the reference product's **Expand & Crop with layers present** ("crop keeps pixels on layers") was read from the panel copy, not exercised; our local crop preserves layers, but the AI-fill interaction with layers is unspecified.
- The **"Add comment" button's** anchoring was not exercised; we did not observe whether comments pin to a point on the image. Our notes are asset-level only in v1.

---

## 5. Styles, presets, references and characters

The reference product's creative control surface is four proprietary systems — Soul style presets, Soul Moodboard, Soul HEX (Color Transfer) and Soul ID Character — all of which depend on models a BYOK client cannot call. Openfield reproduces the *interaction surface* and replaces the machinery with open, local, provider-agnostic equivalents. Everything in this section is data the user owns: SQLite rows under `~/.openfield` (DDL in §0.8, schema in §8.2), portable as JSON, compiled server-side into a plain generation request by `normalize()` (§6). Capability key names are §0.3's and are never redeclared here.

### 5.1 What we replace, and with what

| Their surface | Observed mechanism | Openfield substitute | Works on |
|---|---|---|---|
| Soul style presets (Style tile → `style_id`, `style_strength: 1`) | Server-side style catalogue bound to Soul checkpoints | **Presets**: prompt template with a `{prompt}` slot + negative prompt + reference images + per-provider param overrides | Every model |
| Soul Moodboard ("Build your moodboard") | Proprietary reference conditioning | **Reference sets**: named, ordered image groups sent as multi-image input, capped per model | Any model with `capabilities.references.max > 0` |
| Soul ID Character (trained on photos, CHARACTER tile) | Per-user identity training | **Characters**: named reference set + descriptor text + optional pinned seed (+ provider-native identity or LoRA where one exists) | Degrades honestly — see §5.7 |
| Soul HEX / Color Transfer chip (`New` badge, palette preset grid) | Proprietary colour conditioning | **Palettes**: local k-means extraction → hex injected into the prompt, a generated palette-card reference image, and a local post-process fallback | Every model |
| Recraft V4 Styles' own `Style` chip + `Precise/Flexible` | Provider-native style vocabulary | Provider-native style params surfaced straight from the capability manifest (§0.3), not through our preset system | Provider-specific |
| Topaz upscale (Edit panel, `Upscale · 3`) | Licensed third-party model | Local Lanczos ×2/×4 resample in v1; detail-adding upscale is an adapter/plugin slot (§4.8 row 4, §7.5) | Whatever the user configures |
| `custom_reference_strength: 1` | Single global reference weight | Per-reference `weight` (§5.6), native where supported, ordering + prompt hint otherwise | Every model |

Openfield ships **no scraped catalogue**. Bundled presets and palettes are written from scratch, MIT/CC0 licensed, with generic descriptive names. The same rule binds every other named list in the product: preset, palette, colour-grade and enhancer names are all ours (§4.8 rows 6 and 7), never the reference product's.

### 5.2 The Picker Sheet (one reusable component)

The reference product uses a single non-popover pattern for Style, Character and Color Transfer: a large panel that opens **above** the composer and dims the page behind it. Openfield implements it once as `<PickerSheet>` and instantiates it four times.

**Geometry** (measured at 1440×900; Openfield is desktop-first ≥1280px)

| Property | Value |
|---|---|
| Position | Fixed, horizontally centred; bottom edge 12px above the composer wrapper's top edge |
| Size | `width: min(1120px, 100vw - 64px)`; `height: min(540px, 100vh - 260px)` |
| Surface | radius 20, padding 4, `1px` border `color-mix(in srgb, var(--of-accent) 5%, transparent)`, sheet background `var(--of-surface-sheet)`, page behind dimmed with `var(--of-scrim)` |
| Close | 32×32 icon button, top-right inset 12px; also `Esc` |
| Hero band | 228px tall, full bleed inside the padding, own radius 16 |
| Body | scrolls independently; padding `24px 24px 16px` |

**Anatomy, top to bottom**

1. **Hero band** — headline written in sentence case and uppercased by CSS (24px/700, tracking `0.02em`), 2-line description (14px/400, muted, max-width 520px), one accent CTA pill (height 40, radius 20, 14px/600) that starts the *create* flow for this entity, and a right-aligned art slot (collage of the user's own recent items; a neutral generated gradient when the library is empty).
2. **Tab row + search** — tabs left (segmented, 32px tall, radius 8, 12px/500, optional count badge), search input right-aligned (32px tall, radius 8, leading magnifier icon, 240px wide). Search is debounced 150ms and matches `name`, `tags` and template text.
3. **Card grid** — 6 columns, column gap 12, row gap 16, card width 167, thumbnail 16:9 (167×94, radius 10, `object-fit: cover`), name beneath at 12px/500 clamped to 2 lines. Virtualised above 200 items.
4. **Empty state** — centred icon, title, one line of body, and the same CTA as the hero.

**States**: `idle` · `loading` (12 shimmer cards) · `empty` · `no-results` (search returned nothing: "Nothing matches *term*" + "Clear search") · `error` (import/validation failure surfaced inline, never as a toast that disappears).

**Card states**: default; hover (thumb scales to 1.02, name brightens, a `⋯` overflow button fades in top-right); selected (2px `--of-accent` border + accent check badge bottom-right); disabled (40% opacity + tooltip, used when the item is incompatible with the current model — e.g. a reference set on a model with `capabilities.references.max === 0`).

**Card overflow menu**: Edit · Duplicate · Export · Delete (destructive, `--of-danger`). Curated/bundled items show Duplicate · Export only. There is no "Reveal files" item: presets live in SQLite, and only exports have a path (§5.5).

**Keyboard**: `Esc` closes · `/` focuses search · `↑↓←→` moves the grid cursor · `Enter` selects and closes · `⌘⌫` deletes the focused user item (with confirm). Focus is trapped in the sheet and restored to the invoking chip/tile on close.

**Props**

```ts
type PickerSheetProps<T extends { id: string; name: string; thumbnailUrl?: string }> = {
  open: boolean; onOpenChange: (open: boolean) => void;
  hero: { headline: string; description: string; cta: { label: string; onClick(): void }; art?: ReactNode };
  tabs: { id: string; label: string; count?: number }[];
  activeTab: string; onTabChange(id: string): void;
  searchPlaceholder: string;
  items: T[]; renderCard?: (item: T) => ReactNode;
  selectedId: string | null; onSelect(id: string | null): void;   // null = clear
  disabledReason?: (item: T) => string | undefined;               // capability gating
  empty: { title: string; body?: string };
  columns?: number;   // default 6
  state: "idle" | "loading" | "error"; error?: string;
};
```

**The four instantiations** (all copy is Openfield's own):

| Instance | Opened from | Tabs | Hero headline / CTA | Empty state |
|---|---|---|---|---|
| Presets | Style tile (144×84, preview + "Change" pill) in the composer | `Curated` · `Mine` | "Make a look you can reuse" · "New preset" | "No presets of your own yet." |
| Reference sets | "Reference set" chip / the reference tray's *Manage* action | `Curated` (empty by default) · `Mine` | "Group your references" · "New reference set" | "No reference sets yet. Group a few images to start." |
| Characters | CHARACTER tile (84×84, `+` icon, caps label) | `All` + one tab per provider present in the registry | "Keep a face consistent" · "New character" | "No characters yet." |
| Palettes | Palette chip (composer settings row, 40px tall, radius 12; tinted with `--of-accent` when active) | `Curated` · `Mine` | "Pull colours from an image" · "Extract palette" | "No palettes yet. Extract one from any image." |

Palette cards render the thumbnail plus a swatch strip (N equal bands, 8px tall, sitting under the thumb) and the name — matching the observed Color Transfer grid.

The composer entry points themselves (tile sizes, chip widths, the "Change" pill) are specified in §3 *The composer*.

### 5.3 The preset model

A preset is a pure-data recipe. It never contains a model name as a requirement — only optional overrides. **This object is the canonical JSON wire and file shape** for all four entity kinds (§0.8); no other section defines a second shape.

```jsonc
{
  "schemaVersion": 1,
  "id": "of_preset_35mm_grain",
  "kind": "style",                      // "style" | "reference-set" | "character" | "palette"
  "name": "35mm Grain",
  "description": "Film look with visible grain and soft highlights.",
  "thumbnail": "thumb.webp",            // export-envelope path, relative to the bundle root
  "template": "{prompt}, shot on 35mm colour film, fine visible grain, soft highlight roll-off, natural skin tones",
  "variants": { "light": "{prompt}, subtle 35mm film grain" },
  "negativePrompt": "oversharpened, plastic skin, HDR halo",
  "strength": 1.0,                      // 0–1
  "references": [
    { "assetId": "01K6BQ9Z…", "weight": 0.7, "role": "style" }   // role: style | subject | composition | palette
  ],
  "referenceStrength": 1.0,
  "params": { "aspectRatio": "3:2" },   // neutral params, applied only if the model declares them
  "providerOverrides": {
    "openai:gpt-image-2.5-sunburst": { "quality": "high" },
    "google:gemini-3-pro-image":     { "imageConfig": { "imageSize": "2K" } }
  },
  "palette": { "hex": ["#2B2A26", "#8A7B62", "#D8CBB0"], "mode": "prompt" },
  "tags": ["film", "analogue", "portrait"],
  "author": "", "license": "CC0-1.0", "source": "",
  "createdAt": "2026-09-23T10:00:00Z", "updatedAt": "2026-09-23T10:00:00Z"
}
```

**`kind` is an envelope field, not a column.** It routes an import to `presets`, `reference_sets`, `characters` or `palettes` (§5.10); the `presets` table has no `kind` column and `GET /api/presets` has no `?kind=` filter (§0.6, §0.8). A live preset row stores this whole object in `payload_json`.

**References travel as ids in the store, as paths in a bundle.** In a row, each entry is `{assetId, weight, role}`. In an exported bundle the same entry is `{file, weight, role}` relative to the bundle root; import converts one to the other by ingesting each file as an ordinary upload (§5.5 step 5, §5.6).

**Template semantics.** `template` MUST contain the literal `{prompt}` — single brace, reserved exclusively for presets — exactly once. That is the whole contract, and it lets a preset be a prefix, a suffix, or a sandwich without three separate fields. A template with no `{prompt}` fails validation with "Include {prompt} exactly once." Prefix/suffix shorthand in the editor writes the template for the user. `{{name}}` is the user-variable syntax (§5.9) and resolves *before* templates, so a variable may itself contain text the preset wraps (§0.8).

**Compile.** The resolution order is §0.8's, run server-side in `normalize()` step 1 and frozen onto the job set (§0.11) so Reuse and Recreate reproduce it even after the preset has been edited. Two pieces of copy belong to this section rather than to §0: when a model has no native negative-prompt field, the appended `Avoid: …` form carries the inline note "This model has no Avoid field. Openfield adds it to the prompt instead."; and a `params` key the manifest does not declare is dropped silently from the request but visibly in the UI — the corresponding chip is hidden or disabled by `resolveControl` (§0.3).

**Strength.** `strength` maps to a native parameter when `capabilities.styleStrength` is true (their `style_strength`, Recraft's `Precise/Flexible`). Otherwise it selects the `light`/`full` variant and the slider is labelled "Strength (approximate on this model)". When neither a native param nor a `light` variant exists, the slider is disabled with the tooltip "Strength can't be changed for this preset on *Model*."

**Editor.** Every field above is editable in a right-hand drawer opened from the picker sheet: name, thumbnail (pick from any generated asset or upload), template with a live "Final prompt" preview against the currently selected model, negative prompt, reference thumbnails with weight sliders, a raw-JSON tab for `providerOverrides`, and tags. "Save as preset" also appears in the composer overflow and in the image detail Info tab, pre-filled from that generation's parameters.

### 5.4 Bundled starter presets

Twelve presets ship in `apps/server/seed/presets/` (read-only, `Curated` tab, seeded into `presets` with `builtin = 1`), chosen to span the useful range rather than to be fashionable. Names are ours.

| # | Name | Intent | Template sketch (`{prompt}` = user text) | Tags |
|---|---|---|---|---|
| 1 | **Neutral** | Default; a true no-op so "no style" is a first-class choice | `{prompt}` | `default` |
| 2 | **Soft Daylight** | Diffuse window light, gentle contrast | `{prompt}, soft diffused daylight, gentle contrast, natural colour` | `portrait, natural` |
| 3 | **Direct Flash** | On-camera flash, hard shadow, snapshot energy | `{prompt}, direct on-camera flash, hard falloff, deep background shadow` | `editorial, flash` |
| 4 | **35mm Grain** | Analogue film stock | see §5.3 | `film, analogue` |
| 5 | **Monochrome Contrast** | Black and white, heavy blacks | `{prompt}, black and white, deep blacks, bright specular highlights, high micro-contrast` | `bw` |
| 6 | **Studio Seamless** | Product/e-comm on seamless paper | `{prompt}, studio seamless backdrop, even softbox lighting, no cast shadows, centred subject` | `product, studio` |
| 7 | **Night Neon** | Wet street, mixed colour temperature | `{prompt}, night exterior, mixed neon and sodium lighting, wet reflective ground` | `night, urban` |
| 8 | **Overcast Document** | Flat grey light, reportage | `{prompt}, overcast flat light, muted colour, documentary framing, no stylisation` | `documentary` |
| 9 | **Pastel Haze** | Low contrast, lifted blacks | `{prompt}, pastel palette, lifted blacks, low contrast, soft atmospheric haze` | `soft, pastel` |
| 10 | **High Key Beauty** | Bright, shadowless, skin-forward | `{prompt}, high-key lighting, near-shadowless, luminous skin, white background` | `beauty` |
| 11 | **Golden Hour** | Low warm sun, long shadows | `{prompt}, low golden-hour sun, long shadows, warm rim light, slight lens flare` | `outdoor, warm` |
| 12 | **Flat Vector** | Non-photographic: flat shapes | `{prompt}, flat vector illustration, limited palette, clean geometric shapes, no gradients` | `illustration, graphic` |

Preset #1 is selected by default and the Style tile reads "Neutral" — the structural equivalent of the observed "General" default. Each bundled preset ships a locally generated 16:9 thumbnail (produced once at build time and committed, so a fresh clone with no API key still renders a full grid).

### 5.5 Sharing presets as JSON

**SQLite is the store of record.** `~/.openfield/presets/` holds only `exported/` and `imported/` material; the folder form is an import/export format, not a live store (§0.8, §8.1).

```
~/.openfield/presets/
  exported/
    35mm-grain/
      preset.json            # the object in §5.3
      thumb.webp
      refs/01.webp
    my-brand-look.openfield-preset.json   # single-file form, images inline as data URIs
  imported/                  # bundles the user dropped in, kept so an import can be replayed
```

Both forms are accepted on import. The single-file form is what "Export" produces by default, because it is one attachment to send someone.

**Bundle**: `*.openfield-presets.json` — `{ "schemaVersion": 1, "presets": [ ... ] }` — for sharing a whole pack. Selecting N cards in the sheet and choosing Export writes one bundle.

**Import**: drag a `.json` onto the picker sheet, or *Import* in the hero overflow. Openfield then:

1. Validates against `presetEnvelopeSchema` or `presetBundleSchema` from `@openfield/core` (zod), keyed on `schemaVersion`; unknown future versions are rejected with "This preset needs a newer version of Openfield."
2. Strips every unknown top-level key (forward-compat, no silent execution surface).
3. Rejects any `references[].file` that escapes the bundle root, any absolute path, and — by default — any `http(s)` image URL (a checkbox "Also download linked images" enables it explicitly; the app makes no network call on import otherwise).
4. Enforces limits: ≤ 64 references, ≤ 8 MB per image, ≤ 64 MB per bundle, template ≤ 4000 chars.
5. Ingests every image through `POST /api/uploads` (§5.6), rewrites `references[].file` and `thumbnail` to asset ids, and inserts the row into the table the envelope `kind` names (§5.3, §5.10).
6. On an `id` collision, offers **Keep both** (new id, name suffixed " (2)") / **Replace** / **Skip**, per item, in a review list that shows name, thumbnail, reference count and source file.

A dry-run preview lists exactly what will be written before anything touches disk or the database. `openfield presets validate <path>` does the same check from the CLI so pack authors can verify before publishing. A community pack is therefore just a git repo of folders — no registry, no server, no account.

### 5.6 Reference sets / moodboards

A **reference set** is an ordered, named group of images with per-image `weight` (0–1) and `role` (`style` | `subject` | `composition` | `palette`). It is the open replacement for Soul Moodboard, and it is the same shape as `preset.references` — a preset can *contain* a reference set by id.

**Ingest.** Accepted `.jpg .jpeg .png .webp` (matching the observed file input), plus `.heic` transcoded to PNG on the way in. Each upload goes through `POST /api/uploads` and lands in `uploads/YYYY/MM/DD/<ulid>.<ext>` as an `assets` row with `kind='uploaded'`, stored byte-for-byte; `assets.sha256` deduplicates re-uploads (§8.5.1 step 3). A 2048px-long-edge WebP working copy is generated in the thumb cache, not in place. Reference sets hold **asset ids**, never file paths.

**Per-model cap, surfaced.** `capabilities.references.max` drives the UI at all times:

- The composer reference tray shows a live counter `3 / 14`, using the current model's cap.
- At the cap, the `+` attach button is disabled with the tooltip "*Model name* accepts N reference images."
- When the user switches to a model with a lower cap, **nothing is deleted**. References beyond the cap are dimmed with a "won't be sent" badge and an inline bar appears: "3 of 6 references will be sent to *Model*. Drag to choose which." Order is the selection.
- If `capabilities.references.max === 0`, the tray collapses to a single line: "*Model* doesn't take reference images" with a "Switch model" affordance.
- Known caps as researched on 2026-09-23 — Gemini 3 family up to 14, OpenAI GPT Image "2+" (unconfirmed) — are **manifest defaults only**. If a provider returns a reference-count error, the adapter records the real cap in the registry and the UI updates.

**Weights, honestly.** Neither launch provider accepts per-image weights. So `weight` does three things, in order of how real they are: (1) it is passed natively when `capabilities.references.weights` is true (aggregator models in v1.1); (2) it sorts the reference array, which measurably matters on models that privilege the first image; (3) it emits a short ordered clause — `Primary reference (style): image 1. Secondary: image 2.` — only when `capabilities.references.weights` is false. The weight slider is labelled "Influence (only changes the order on this model)" in that case. We do not pretend it is a strength knob.

**Acceptance criteria.** Adding 20 images to a set and selecting a 14-reference model sends exactly 14, in weight order, and the UI states which 6 were dropped before Generate is pressed.

### 5.7 Characters and consistency — what BYOK actually gives us

Their CHARACTER tile trains an identity ("Upload photos from multiple angles to train your character"). **Openfield does not train anything in v1.** A character is a composition of three things the user already controls:

```jsonc
{
  "kind": "character",
  "name": "Ana",
  "referenceSetId": "of_refs_ana",      // 3–14 photos, varied angle/lighting
  "descriptor": "a woman in her late twenties, shoulder-length dark curly hair, light olive skin, small scar above the left eyebrow",
  "lockSeed": true, "seed": 469445,
  "injection": "prefix",                 // prefix | suffix | replace-token
  "token": "@ana",                       // for @-mention in the composer
  "providerIdentity": null               // e.g. a provider-native character id, or a v1.1 LoRA ref
}
```

At compile time the descriptor is injected (prefix by default, or substituted wherever `@ana` appears in the prompt), the reference set is attached subject to the model cap, and the seed is pinned if the model supports seeds.

| Technique | Requires | Honest expectation |
|---|---|---|
| Reference-image identity | `capabilities.references.max ≥ 3` | Good likeness on edit-capable models; drifts on pose/lighting changes. The best single lever we have. |
| Descriptor injection | Nothing | Keeps hair/age/build stable across runs where references drift. Cheap, always on. |
| Locked seed | `capabilities.seed.supported` | Reproduces a *run*, not an *identity*. Inert on every v1 model — see below. |
| Provider-native character id | A provider that exposes one (Soul ID, if its public API surfaces it with a user key) | Best result where available; adapter-specific; shown as a "Saved by model" badge on the character card. Unverified — see Open questions. |
| LoRA / fine-tune | fal.ai or Replicate training endpoints | **v1.1**, via the aggregator adapters. The character record already carries `providerIdentity` so a trained LoRA slots in without a schema change. |
| Local training | A GPU we do not assume | **Never in v1.** Openfield is a thin local client around remote APIs; it ships no training loop, no CUDA dependency, and no local weights. |

**The seed lever is inert at launch, and the UI says so.** No launch adapter declares `capabilities.seed.supported` (§0.11, §6.13, §6.14), so on every v1 model the character drawer's **Lock seed** row renders disabled with the reason "*Model* doesn't support seeds" — Seed is a core control and is disabled rather than hidden (§0.3) — and a character relies on references + descriptor alone. When an adapter that supports seeds arrives, the stored `lockSeed`/`seed` become live with no schema change.

The character editor states this plainly at the top of the drawer: "Openfield doesn't train anything. It reuses your photos and your description, and keeps the same Seed when the model allows it. Results vary by model." The picker sheet's card shows which levers are active as small badges (`6 photos` · `Description` · `Seed`), and greys the card on models that take no references, with the tooltip "*Model* doesn't take reference images. Only the description is used."

Characters, presets and reference sets are all `@`-mentionable in the composer's prompt editor (typeahead on `@`), shipping in v1 as M1-17 (§0.14, §3.2). The typeahead resolves **Openfield objects only** — presets, characters, reference sets, saved references; the reference product's server-side "Elements" entity is not reproduced.

### 5.8 Colour transfer (palettes)

**Extraction runs locally.** No API call, no key needed, works offline.

1. Decode the reference image, resize the long edge to 128px (area sampling).
2. Convert to OKLab.
3. k-means++ with a fixed RNG seed, `k` = user-chosen 3–8 (default 5), max 20 iterations, convergence at ΔE < 0.5.
4. Merge clusters within ΔE₀₀ < 5; re-run if fewer than 3 survive.
5. Sort clusters by population, convert centroids back to sRGB hex, record population %.

Deterministic by construction: the same file always yields the same palette. Budgeted at under 50 ms for the 128 px downsample — a target enforced by a benchmark, not a measured figure — so the sheet can show the swatch strip live as the user drags `k`.

**Three injection modes**, chosen per palette (`palettes.mode`), all available on every model:

| Mode | What Openfield does | When to use |
|---|---|---|
| `prompt` (default) | Appends `Colour palette: #2B2A26 (40%), #8A7B62 (35%), #D8CBB0 (25%) — dark warm brown, muted khaki, pale sand. Grade the image to this palette.` Hex *and* plain-language names (nearest-name lookup from a bundled colour-name table) because some models parse names far better than hex. | Any model |
| `reference` | Renders a 1024×1024 **palette card** (N vertical bands, area proportional to population) and attaches it as a reference image with `role: "palette"`, costing one reference slot — the counter in §5.6 accounts for it. | Models with reference support |
| `both` | Both of the above | Models that ignore hex alone |

**The fallback, because models do ignore this.** An `Apply palette to result` toggle (default off) runs a local, non-generative colour transfer on the returned image: mean/standard-deviation matching in OKLab (Reinhard) against the palette's distribution, with a `Strength 0–100%` slider and luminance preserved by default. It is a **local op** — `op = 'grade'`, `provider_id = 'local'`, `generative = 0`, `cost_usd = 0` (§0.4) — and it writes a **new asset version** with lineage back to the original, so the ungraded generation is never lost (§0.9, §8). After a generation where a palette was active, the detail view shows a one-line nudge: "Colours off? Apply this palette →". This is a deliberate echo of the observed non-generative Color Grading panel, and it is the only part of Openfield's colour handling guaranteed to work on every model.

**Bundled palettes** (8, `Curated` tab, our own names, each with a hand-picked hex list and a generated thumbnail, seeded from `apps/server/seed/palettes/` with `builtin = 1`): Muted Earth · Cold Steel · Warm Sand · Deep Teal · Ink & Bone · Sun Bleach · Neon Midnight · Faded Pastel.

The palette chip in the composer settings row follows the observed behaviour: it tints with `--of-accent` while a palette is active, and shows the palette name plus a 3-swatch mini strip in place of the default label.

### 5.9 Prompt library

Three tiers, all reachable from the prompt editor without leaving the keyboard.

**Recent prompts** — automatic. The last 50 distinct prompts are derived from the job history (no separate table), deduplicated case-insensitively on the *user-typed* text (not the compiled text). Opened with `↑` on an empty prompt field or via the prompt-row overflow. Each row shows the prompt (2-line clamp), the model it ran on, and a thumbnail of one result; Enter loads prompt + settings, `⇧Enter` loads the prompt only.

**Saved prompts** — explicit. `⌘S` in the prompt field, or "Save prompt" in the overflow. Fields: name, text, tags, optional linked preset. Stored as `saved_prompts` rows (§0.8, §5.10) behind `/api/prompts` (§0.6); they export to `presets/exported/` and import with the same validation rules as presets (§5.5). Listed in the same `<PickerSheet>` shell with tabs `Saved` · `Recent`.

**Variables and snippets** — composable.

- A snippet is a named fragment inserted by typing `/` followed by its name (`/lighting`, `/lens`), resolved at insert time into literal text. Bundled: `/lighting`, `/lens`, `/camera`, `/mood`, `/negative`.
- A variable is `{{name}}` written inline. On Generate, if any unbound `{{name}}` remains, a small inline panel above the Generate button asks for each value (remembering the last value per name), and the filled text is what gets saved to history. A variable may also declare choices in the saved prompt (`{{lighting|soft daylight|direct flash|golden hour}}`), which renders as a select instead of a text field — this is how one saved prompt becomes a small batch template.
- Variables resolve **before** preset templates — the first step of §0.8's resolution order — so a preset can wrap variable output. `{{name}}` and `{prompt}` never collide: single brace is the preset slot, double brace is a user variable.

### 5.10 Storage summary

Entities owned by this section. The tables are declared in `packages/db/src/schema/library.ts` (§8.2) and created by the initial migration; the routes are §8.3's. Neither is restated here.

| Entity | Table | Columns | Endpoints |
|---|---|---|---|
| Preset | `presets` | `id, name, description, payload_json, thumb_asset_id, builtin, origin, sort_order, created_at, updated_at` | `GET`/`POST` `/api/presets` · `PATCH`/`DELETE` `/api/presets/:id` |
| Reference set | `reference_sets` + `reference_set_items` | set: `id, name, created_at, updated_at`; item: `set_id, asset_id, position, weight, role`, `PRIMARY KEY (set_id, asset_id)` | `GET`/`POST` `/api/reference-sets` · `PATCH`/`DELETE` `/api/reference-sets/:id` |
| Character | `characters` | `id, name, descriptor, thumb_asset_id, reference_set_id, seed, lock_seed, injection, token, provider_identity_json` | `GET`/`POST` `/api/characters` · `PATCH`/`DELETE` `/api/characters/:id` |
| Palette | `palettes` | `id, name, hex_json, populations_json, source_asset_id, k, mode, builtin, created_at, updated_at` | `GET`/`POST` `/api/palettes` · `PATCH`/`DELETE` `/api/palettes/:id` |
| Saved prompt | `saved_prompts` | `id, name, text, tags_json, preset_id, created_at, updated_at` | `GET`/`POST` `/api/prompts` · `PATCH`/`DELETE` `/api/prompts/:id` |

Three consequences worth stating once. `presets` has **no `kind` column** — the §5.3 object lives whole in `payload_json`, and `name`, `thumb_asset_id`, `builtin` and `origin` exist only so the picker can query without parsing JSON. `reference_set_items.asset_id` and `palettes.source_asset_id` are **asset ids**, never sha256: uploads are ordinary assets (§0.7) and every other table keys the same way. And every job set stores the frozen `NormalizedRequest` (§0.11) — compiled prompt, negative prompt, ordered reference asset ids, preset id, character id, palette hex — so Reuse and Recreate reproduce a run exactly even after the preset has since been edited.

### 5.11 Acceptance criteria

- The same `<PickerSheet>` component renders all four libraries; a visual diff of the Presets and Characters sheets differs only in hero copy, tabs, cards and empty state.
- Importing a preset bundle from an untrusted source makes zero network requests unless "Also download linked images" is ticked, and writes nothing to disk or the database until the user confirms the dry-run list.
- Selecting a preset updates the Style tile label and, on the next Generate, the frozen request's compiled prompt shows the template applied with `{prompt}` replaced exactly once.
- Switching from a 14-reference model to a 2-reference model never deletes an attached reference and always states, before Generate, how many will be sent.
- A character on a model with `capabilities.references.max === 0` still generates, using the descriptor alone, and the card says so.
- Extracting a palette twice from the same file returns byte-identical hex values.
- "Apply palette to result" produces a new asset version with `generative = 0` whose parent is the original, and the original remains openable.
- Every preset, reference set, character, palette and saved prompt round-trips through export → delete → import with no data loss other than timestamps.
- **Deleting the `presets` and `palettes` rows and restarting re-seeds** the 12 bundled presets and 8 bundled palettes from `apps/server/seed/presets/` and `apps/server/seed/palettes/`, with thumbnails, without any API key configured.

### 5.12 Open questions

- Whether Higgsfield's public API exposes a style catalogue listing endpoint, Soul ID character creation, or Soul HEX at all with a user key — research found the Soul endpoint only, and no schema for the "70+ styles" or the Soul ID training flow. If it does not, the Higgsfield adapter ships without native styles/characters and falls back entirely to §5.3–§5.7.
- Their exact semantics for `style_strength` vs `custom_reference_strength` (both observed as `1` in the captured payload) — we know the field names, not their curves or interaction.
- Whether the observed Character sheet tabs (`All | Soul | Soul 2.0 | Soul Cinema`) filter by *trained-for* model or by *compatible* model; our provider-derived tabs assume the latter.
- The observed Moodboard build flow itself was not captured beyond its CTA ("Build your moodboard") — how many images it takes, whether it produces a derived artefact or just a group, and whether moodboards are model-scoped.
- Gemini seed support is not confirmed in the API documentation; until a live adapter probe confirms it, `capabilities.seed.supported` is `false` for the Gemini family and §5.7's Lock seed row stays disabled.
- OpenAI's real maximum reference-image count for edits (docs say "2+"), which sets `capabilities.references.max` for that family.
- Whether their Color Transfer palette presets are pure colour data or carry additional model conditioning — the observed grid shows a thumbnail plus swatch strip, which is consistent with either.
- Per-reference weighting on fal.ai / Replicate models (v1.1): whether enough models accept per-image weights to make `capabilities.references.weights` worth surfacing as a first-class control rather than an ordering hint.

---
## 6. Provider adapter architecture and BYOK

Openfield has no models of its own. Everything the Image tab and the Canvas can do is the union of what the installed **adapters** declare they can do, using **the user's own API keys**. This section defines that layer: the interfaces, the capability manifest that drives the UI, request/response normalisation, the job model, the error taxonomy, cost accounting, key security, the adapter authoring contract, the three launch adapters and the Settings surface.

§0 is binding over this section on every shared contract. §6 is the **declaration site** for the TypeScript types §0 fixes — `Capabilities`, `ControlId`, `Op`/`AdapterOp`, `GenerateRequest`, `NormalizedRequest`, `JobState`, `ErrorCode`, the cost types — which is why they appear here in full. Where a value in §6 and a value in §0 ever disagree, §0 wins and §6 is the defect.

**Where these types live in code (§0.16).** Every data type in this section is declared once as a zod schema in `packages/core/src/schemas/`, and its TypeScript type is `z.infer` of that schema:
- `provider.ts`: `ProviderId`, `ModelKey`, `ProviderMeta`, `CredentialField`, `CredentialSchema`, `PriceTable` and `RefreshReport` (§6.2)
- `manifest.ts`: `AspectRatio` through `ModelManifest`, plus `ControlState` (§6.3)
- `request.ts`: `SizeSpec`, `ReferenceInput`, `MaskInput`, `Op`, `AdapterOp`, `GenerateRequest`, `NormalizedRequest`, `PixelSize`, `PerImagePrice` and `Diagnostic` (§6.5)
- `job.ts`: `JobState`, `JobSetState`, `JobHandle` and `JobUpdate` (§6.7)
- `errors.ts`: `ErrorCode` (§6.8)
- `cost.ts`: `PriceModel`, `CostEstimate` and `CostActual` (§6.9)

Types that carry behaviour stay hand-written in `packages/providers/src/types/`:
- `provider.ts`: `Provider`, `CallContext`, `AssetSink`, `RedactingLogger`
- `model.ts`: `ImageModel`
- `registry.ts`: `ModelRegistry`
- `result.ts`: the in-process result types `GeneratedImage`, `ProviderUsage`, `SafetyVerdict` and `JobResult`

The code blocks below stay the normative shapes, and the zod schemas must match them field for field. The enum unions (`Op`, `JobState`, `ErrorCode`) are built from the `as const` arrays in `packages/core/src/constants.ts`.

Two rules govern the whole layer:

1. **The manifest is the UI.** No screen hardcodes "GPT Image has a Background chip". The composer chip row, the canvas node footers and the edit-tool list are all rendered from `Capabilities` through one function, `resolveControl()` (§6.3). Adding a model is a data change, not a UI change.
2. **Keys and provider traffic never leave the server process.** The browser talks only to `127.0.0.1`; adapters are the only code that holds credentials or opens an outbound socket. The one exception is deliberate and credential-free: the pure `estimate()` function (§6.9) ships to the browser because it reads `manifest.price` and nothing else.

### 6.1 Where adapters sit

```
browser (React)  ──HTTP/SSE──▶  Bun + Hono server  ──▶  registry ──▶ adapter ──▶ provider API
   never sees keys               job runner, asset store,            (fetch)
                                 usage log, SQLite
```

- `packages/core`: the zod schemas, and the types inferred from them, for every data shape in this section, plus the enum constants. Every workspace imports it.
- `packages/providers`: the behaviour interfaces, the registry, `normalize()`, the pure `estimate()` and `resolveControl()`, the conformance suite, and one folder per adapter. It has two entries. `@openfield/providers/manifest` is browser-safe (manifest types, `estimate()`, `resolveControl()`). `@openfield/providers/server` holds the registry, `normalize()` and the adapters. No DOM APIs, no imports from `packages/ui`; it runs under plain `bun test`.
- `apps/server`: owns the job runner, the SQLite tables through `packages/db` (§8.2), the asset store under `~/.openfield/assets` (§8.1), and the HTTP/SSE surface (§8.3). It is the only importer of `@openfield/providers/server`, so it is the only caller of adapter *methods*.
- `apps/web`: receives manifests as JSON through the typed client (§8.3.3), renders controls with `resolveControl()`, and computes costs with `estimate()`, both from `@openfield/providers/manifest`. It never imports `@openfield/providers/server` (§0.16 rule 2).

The job/asset records are modality-agnostic (§8.2): `modality: "image" | "video" | "audio"` is present from v1 even though only `"image"` is produced, so the v1.1 video work is an adapter + a renderer, not a schema migration.

### 6.2 Provider interface

```ts
// packages/providers/src/types/provider.ts (behaviour); data types in this block: packages/core/src/schemas/provider.ts

/** Stable slug: "openai" | "google" | "higgsfield" | "fal" | "replicate" | … */
export type ProviderId = string;

/** Globally unique model address (§0.2). Colon is the only separator; a slash form
 *  is used nowhere, and providers.id may not contain a colon. */
export type ModelKey = `${ProviderId}:${string}`;

export interface ProviderMeta {
  id: ProviderId;
  displayName: string;          // our own label, e.g. "OpenAI"
  docsUrl: string;              // linked from Settings → Keys
  consoleUrl: string;           // where the user creates a key
  /** Every API hostname this adapter may contact. Shown verbatim in Settings → Privacy. */
  networkHosts: string[];
  /** Every hostname an image may be downloaded from. Second allow-list; see §6.11. */
  assetHosts: string[];
  /** false ⇒ hidden behind Settings → Experimental and never auto-selected. */
  stable: boolean;
}

export interface CredentialField {
  name: string;                 // "apiKey", "keyId", "keySecret"
  label: string;
  secret: boolean;              // secret fields are write-only over HTTP and masked in the UI
  required: boolean;
  placeholder?: string;
  pattern?: string;             // client-side sanity check only, never a rejection reason
  envVars: string[];            // e.g. ["OPENFIELD_OPENAI_API_KEY", "OPENAI_API_KEY"]
  help?: string;
}

export interface CredentialSchema {
  fields: CredentialField[];
  /** Optional non-secret settings stored beside the key. */
  options?: CredentialField[];  // e.g. { name: "baseUrl" }, { name: "organization" }
}

export type CredentialValues = Record<string, string>;

export interface Provider {
  readonly meta: ProviderMeta;
  readonly credentials: CredentialSchema;

  /** Shape-only check. Pure, no network. Drives inline Settings validation. */
  validateCredentials(values: CredentialValues): Diagnostic[];

  /** One cheap round-trip that proves the key works. Settings → "Check key". */
  verifyCredentials(ctx: CallContext): Promise<{ ok: true; note?: string }>;

  /**
   * Model list. REQUIRED to return the adapter's static catalog; **network discovery
   * is optional** and, where implemented, is allow-listed by recognise() (§6.4).
   */
  listModels(ctx: CallContext): Promise<ModelManifest[]>;

  /** Does this adapter claim this provider-native id? Pure. Gates discovery (§6.4). */
  recognise(modelId: string): boolean;

  /** Bind a manifest to callable behaviour. Throws UnknownModelError for foreign keys. */
  model(key: ModelKey): ImageModel;

  /** Optional: refresh the declared price table from the provider. Never silent (§6.9). */
  refreshPricing?(ctx: CallContext): Promise<PriceTable | null>;
}

export interface CallContext {
  credentials: CredentialValues;   // injected by the server; never logged
  fetch: typeof fetch;             // the only way out: timeout, redacting log, host allow-list
  signal: AbortSignal;
  log: RedactingLogger;
  now: () => number;
  /** Where the adapter writes image bytes. Adapters never return data: URLs. */
  assets: AssetSink;
}

/** Support types, declared once so every adapter compiles against the same shapes. */
export interface AssetSink {
  /** Streams bytes into §8.5.1's ingest path and returns the written asset id. */
  write(stream: ReadableStream<Uint8Array>, meta: { mimeType: string; sourceUrl?: string })
    : Promise<{ assetId: string; width: number; height: number; bytes: number; sha256: string }>;
}
export interface RedactingLogger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** Applies the §6.11 redaction chain to any value before it is stored or displayed. */
  scrub<T>(value: T): T;
}
export interface PriceTable { models: Record<ModelKey, PriceModel>; fetchedAt: string; sourceUrl: string }
export interface RefreshReport {
  providerId: ProviderId;
  added: ModelKey[]; updated: ModelKey[]; removed: ModelKey[];
  /** Discovered ids recognise() rejected. Listed in Settings → Models → Not supported. */
  unrecognised: { modelId: string; seenAt: string }[];
  error?: ProviderError;
  checkedAt: string;
}
export class UnknownModelError extends Error { constructor(public key: ModelKey) { super(`Unknown model ${key}`); } }
```

### 6.3 Model interface and the capability manifest

`ModelManifest` is pure data (serialisable, cacheable, shippable to the browser). `ImageModel` is the manifest plus behaviour. The pair *is* the capability manifest the rest of the PRD refers to, and this type is the **only** manifest vocabulary in the document (§0.3).

```ts
// packages/core/src/schemas/manifest.ts (zod, types inferred); ImageModel: packages/providers/src/types/model.ts

export type AspectRatio =
  | "auto"
  | "1:1" | "2:1" | "1:2" | "3:2" | "2:3" | "4:3" | "3:4" | "5:4" | "4:5"
  | "6:10" | "14:10" | "10:14" | "16:9" | "9:16" | "21:9" | "27:16" | "16:27"
  | "9:8" | "8:9" | "1:4" | "4:1" | "1:8" | "8:1";

/** Long-edge target in pixels. "1K"=1024, "1.5K"=1536, "2K"=2048, "4K"=4096. */
export type ResolutionTier = "512" | "1K" | "1.5K" | "2K" | "4K";

export interface QualityLevel {
  id: string;        // provider-native value sent on the wire ("low", "high", "max", "auto")
  label: string;     // our copy, e.g. "High"
  hint?: string;     // our copy, e.g. "Sharpest detail"
}

export type OutputFormat = "png" | "jpeg" | "webp";
export type ReferenceRole = "subject" | "style" | "palette" | "composition" | "base" | "mask";

/** Every control any surface can render. Published here so §2–§5, §7 and §8 have
 *  one enum to convert against. */
export type ControlId =
  | "model" | "aspect" | "size" | "resolution" | "quality" | "batch" | "seed"
  | "negativePrompt" | "promptEnhance" | "background" | "references"
  | "referenceStrength" | "outputFormat" | "moderation" | "advanced" | "palette";

export interface Capabilities {
  ops: {
    textToImage: boolean;
    imageEdit: boolean;          // image(s) + instruction, no mask
    inpaint: boolean;            // requires a mask
    outpaint: boolean;           // native or mask-synthesised
    upscale: boolean;
    removeBackground: boolean;
    detectText: boolean;         // vision text-run detection (§4.8 row 2)
    decomposeLayers: boolean;    // plugin-only at v1 (§4.8 row 1)
  };

  references: {
    supported: boolean;
    max: number;                 // 0 when unsupported
    roles: ReferenceRole[];      // roles this model can actually honour
    mimeTypes: string[];
    maxBytes: number;
    maxPixels?: number;
    weights: boolean;            // provider honours a per-image weight
    strengthMode: "per-image" | "global" | "none";
  };

  size:
    | { mode: "aspect"; ratios: AspectRatio[]; default: AspectRatio }
    | { mode: "enum";   sizes: PixelSize[]; default: PixelSize; allowAuto: boolean }
    | { mode: "free";   minEdge: number; maxEdge: number; multipleOf: number; default: PixelSize };

  resolution?: { tiers: ResolutionTier[]; default: ResolutionTier };
  quality?:   { levels: QualityLevel[]; default: string };

  batch: { max: number; native: boolean };   // max is 4 in v1, everywhere (§0.10)
  seed:  { supported: boolean; range?: [number, number]; echoed: boolean };

  negativePrompt: boolean;
  promptEnhance: "native" | "openfield" | "none";
  styleStrength: boolean;                    // native style/preset strength parameter

  background?: { values: ("auto" | "opaque" | "transparent")[]; default: "auto" };
  transparency: boolean;                     // can emit an alpha channel at all

  streaming: { partialImages: boolean; maxPartials?: number; progressPercent: boolean };

  output: { formats: OutputFormat[]; default: OutputFormat;
            compression?: { min: number; max: number; default: number } };   // jpeg/webp only

  safety?: { moderation?: { values: string[]; default: string; label: string };
             /** Immutable provider behaviour the user must be told about, in our words. */
             notices?: string[] };

  identity: { nativeCharacterRefs: boolean; nativeStylePresets: boolean };

  limits: { maxPromptChars?: number; requestTimeoutMs: number;
            typicalLatencyMs: [number, number];   // p50, p95 — drives placeholder copy
            maxConcurrent: number };

  /** Chip order in the composer and in the canvas node footer (§3.3, §7.5). */
  controlOrder: ControlId[];
  /** Restricted JSON Schema rendered mechanically by the Advanced chip (§3.4.7). */
  extraSchema?: JSONSchema;

  /** Control exists but some options are unavailable. Keyed by ControlId. */
  partial?: Record<string, { unavailable: string[]; reason: string }>;
  /** Control is faked by the adapter (batch fan-out, appended negative prompt, …). */
  emulated?: ControlId[];
  /** Control is declared absent on purpose, with copy for the disabled tooltip. */
  unsupported?: Record<string, { reason: string }>;

  /** What normalisation does with a canonical field this model cannot honour. */
  unsupportedParamPolicy: "reject" | "drop-with-warning";
}

export interface ModelManifest {
  key: ModelKey;
  providerId: ProviderId;
  modelId: string;             // provider-native id sent on the wire
  displayName: string;
  description?: string;        // our copy, ≤ 90 chars (model-picker row subtitle)
  family?: string;             // groups rows in the picker
  badges?: ("new" | "preview" | "legacy" | "experimental")[];
  capabilities: Capabilities;
  price: PriceModel;
  source: "static" | "discovered" | "user";
  manifestVersion: string;     // bumped on any capability change; frozen onto the job set
  fetchedAt: string;           // ISO; the UI shows "Prices as of …"
}

export interface ImageModel extends ModelManifest {
  /** Map → POST. Returns as soon as the provider acknowledges. */
  submit(req: NormalizedRequest, ctx: CallContext): Promise<JobHandle>;

  /** Single status check. Idempotent; safe after a terminal state. */
  poll(handle: JobHandle, ctx: CallContext): Promise<JobUpdate>;

  /** Optional: SSE / chunked streaming, including partial images (§6.7). */
  stream?(handle: JobHandle, ctx: CallContext): AsyncIterable<JobUpdate>;

  /** Optional: provider-side cancellation. Absence is handled by the runner (§0.12). */
  cancel?(handle: JobHandle, ctx: CallContext): Promise<void>;

  /** Optional: ONE network round-trip for providers with a cost endpoint. Never on the
   *  render path; the result is cached per paramsHash (§6.9). The only async pricing path. */
  estimateRemote?(req: NormalizedRequest, ctx: CallContext): Promise<CostEstimate>;
}
```

**`estimate()` is not a method.** Cost before the run is the pure function `estimate(manifest, req)` exported from `@openfield/providers/manifest` (§6.9, §0.16), because the browser cannot call a method on an `ImageModel` and an HTTP round-trip per batch-stepper click is unacceptable.

**Legacy manifest names.** Four other naming schemes appear in the drafts. The mechanical rename table is §0.3's and is not restated here; `Capabilities` above is the only manifest vocabulary.

#### Capability → control binding (this is the parity contract)

Exactly one function decides every control on every surface — composer chips (§3.3), canvas node footers (§7.5), edit-tool rows (§4.8). No surface reads `capabilities` directly.

```ts
export type ControlState = "supported" | "partial" | "emulated" | "unsupported" | "absent";
export function resolveControl(caps: Capabilities, id: ControlId):
  { state: ControlState; options?: unknown[]; default?: unknown; reason?: string };
```

**The rendering rule (§3.5, verbatim).** *Core set (Model, Aspect, Resolution/Quality, Images, Seed) renders disabled with a reason when explicitly unsupported; every non-core control is hidden when unsupported or absent.* Seed is deliberately core-and-disabled: hiding it would hide the reason reproducibility is unavailable.

| State | Composer / node UI |
|---|---|
| `supported` | Control renders; the popover lists **the model's own options**, never a house list |
| `partial` | Control renders; unavailable options greyed with `reason` as subtitle; info dot on the chip |
| `emulated` | Control renders with a `~` glyph; the popover header explains the emulation and its cost consequence |
| `unsupported` | Core set → disabled with a tooltip naming the model. Non-core → hidden |
| `absent` | Not in the DOM |

| Manifest field | Control | Behaviour |
|---|---|---|
| `size.mode: "aspect"` | Aspect chip | Popover lists `ratios` in declared order, proportional glyph + label, check on selected |
| `size.mode: "enum"/"free"` | Size chip | Enum list, or W×H inputs snapped to `multipleOf` |
| `resolution` | Resolution chip | Lists `tiers` (`1K 1024px` / `1.5K 1536px` / `2K 2048px` / `4K 4096px`) |
| `quality` | Quality chip | Lists `levels` with `label` + `hint` |
| `background` | Background chip | Auto / Opaque / Transparent |
| `batch.max` | Stepper `− n/max +` | `−` disabled at 1, `+` disabled at `max` |
| `seed.supported` | Seed field | Dice = randomise; blank = server-generated per image (§0.11) |
| `negativePrompt` | Avoid field | Hidden when absent; disabled with a reason when explicitly `unsupported` |
| `promptEnhance !== "none"` | Enhance toggle chip | `"openfield"` shows a "Uses a text model" note (§3.4.3) |
| `references.supported` | `+` attach button, reference strip | `max` enforced client- and server-side |
| `references.strengthMode` | Reference strength slider | `"none"` ⇒ hidden |
| `styleStrength` | Preset strength slider | Otherwise the slider selects the preset's `light` variant, or is disabled with a reason (§0.8) |
| `ops.inpaint` / `ops.outpaint` | Edit-view tools (§4.8) | The row renders **disabled with its reason**, never hidden (§4.8) |
| `extraSchema` | Advanced chip | Rendered mechanically (§3.4.7) |
| `price` | Generate button sub-label | `About $0.27 · 2 images` (§6.9) |

**Acceptance criterion.** For the models observed in the reference product, the manifest must render the observed chips, **in the observed order, with no observed chip missing and no model-capability chip added**. Openfield-only controls (Advanced, Avoid, Seed, Reference strength, Palette) are excluded from the comparison and asserted separately.

| Observed model | Expected chip set |
|---|---|
| `gpt_image_2` | Aspect(Auto) · Quality(High) · Resolution · Background(Auto) · 1/4 |
| `gpt-image-2-5-sunburst` | Aspect(Auto) · Quality(High) · Resolution · 1/4 |
| `nano-banana-pro` | Aspect(3:4) · Resolution(1K) · 1/4 |
| `nano-banana-2` | Aspect(3:4) · Resolution(1K) · 1/4 |

The observed *default* resolution tier is not asserted for the OpenAI rows: **the reference product's chip set reflects its own proxy, not the OpenAI API; where they disagree the API wins** (§6.14 caps the documented long edge at 1536, so the observed 2K default is not reachable through the public API). A snapshot test asserts the rendered chip list per model key.

### 6.4 Model registry and runtime discovery

```ts
export interface ModelRegistry {
  providers(): Provider[];
  models(opts?: { ready?: boolean }): ModelManifest[];   // ready = credentials present
  get(key: ModelKey): ImageModel;                        // throws UnknownModelError
  refresh(providerId?: ProviderId): Promise<RefreshReport>;
}
```

Resolution order for a model list, last wins:

1. **Static catalog** shipped in the adapter (`models.ts`) — always present, so Openfield boots and renders a model picker with no keys and no network.
2. **Discovered** — `provider.listModels()` at server start (if credentials exist), on demand from Settings → Models → *Refresh*, and at most once per 24 h in the background.
3. **User overlay** — `~/.openfield/models.json`, hand-edited, merged last. This is how a user enables a model that shipped after this build: they paste an id and, optionally, capability overrides.

**Discovery is allow-listed, not additive (§0.3).** A discovered id is added to the picker **only if the adapter's own `recognise(id)` predicate accepts it**; a recognised id merges over the static catalog (static capabilities win, the discovered id and its version do not). Unrecognised ids are recorded in `RefreshReport.unrecognised`, shown under **Settings → Models → Not supported**, and never added to the picker. **There is no conservative-default path for discovered ids** — the conservative manifest (text-to-image only, `size.mode:"aspect"` with `["auto","1:1"]`, batch 1, price `unknown`) is reserved for `~/.openfield/models.json` entries the user added deliberately. The reason is concrete: neither launch provider documents an image-capability flag on its model list (§6.13, §6.14), so an additive rule fills the picker with text-only models that each fail on first use.

Discovery failures are non-fatal: the registry keeps the static catalog, records the error on the report, and Settings shows *"Couldn't update the model list. Showing the saved one (last checked …)."* Model ids are **never** hardcoded in the UI; deep links use `?model=<providerId>:<modelId>` (§0.2) and fall back to the default model with a toast when the key is unknown.

### 6.5 Canonical request and request normalisation

```ts
// packages/core/src/schemas/request.ts (zod, types inferred)

export type SizeSpec =
  | { kind: "auto" }
  | { kind: "aspect"; ratio: AspectRatio }
  | { kind: "pixels"; width: number; height: number };

export interface ReferenceInput {
  assetId: string;             // row in the assets table
  role: ReferenceRole;
  weight?: number;             // 0–1, only when references.weights
}

export interface MaskInput {
  /** A mask **asset id** and nothing else — no base64, no data URL (§0.9, conformance 16).
   *  The asset is an RGBA PNG at the base image's exact pixel size; **alpha = 0 marks the
   *  region the model should regenerate, alpha = 255 preserves**. RGB channels are ignored.
   *  The adapter converts to whatever polarity its provider requires. */
  assetId: string;
  invert?: boolean;            // applied by core before upload; never reaches the adapter
  featherPx?: number;          // applied by core before upload; never reaches the adapter
}

/** Every operation the product can record (§0.4). Used byte-identically by job_sets.op,
 *  assets.op, usage_log.operation and §4.9's operation record. */
export type Op =
  | "generate" | "edit" | "inpaint" | "outpaint" | "variation"
  | "upscale" | "remove_bg" | "text_edit" | "relight" | "angles" | "enhance" | "decompose"
  | "crop" | "grade" | "overlay";

/** The subset an adapter is ever asked to perform. */
export type AdapterOp = "generate" | "edit" | "inpaint" | "outpaint" | "upscale" | "remove_bg";
```

**Op → AdapterOp compile mapping**, applied in `normalize()`:

| Recorded `Op` | Submitted `AdapterOp` | Notes |
|---|---|---|
| `generate`, `edit`, `inpaint`, `outpaint`, `upscale`, `remove_bg` | itself | — |
| `relight`, `angles`, `enhance`, `text_edit` | `edit`, or `inpaint` when a mask is present and `ops.inpaint` | The widget compiles a structured instruction; the result is labelled best-effort (§4.8) |
| `variation` | `generate` | seed-jitter / prompt-list / model-list strategies (§7.5) |
| `decompose` | — | plugin only |
| `crop`, `grade`, `overlay` | — | **local ops**: `provider_id = 'local'`, `cost_actual_usd = 0`, `assets.generative = 0`, no provider call |

Lineage relations are **not** operations: `asset_edges.relation` is the small union `'derived' | 'reference' | 'import'`, and the operation lives on the asset (§0.4, §0.7).

```ts
/** The wire body of both POST /api/generate and POST /api/edit (§0.6; §8.3 owns the
 *  HTTP surface). /api/generate accepts op: "generate" only; /api/edit accepts the rest. */
export interface GenerateRequest {
  idempotencyKey: string;              // client ULID, one per job set (§0.2)
  model: ModelKey;
  op: Op;

  prompt: string;
  negativePrompt?: string;
  enhancePrompt?: boolean;

  size: SizeSpec;
  resolution?: ResolutionTier;
  quality?: string;                    // a QualityLevel.id
  background?: "auto" | "opaque" | "transparent";
  output?: { format: OutputFormat; compression?: number };

  batch: number;                       // 1 … capabilities.batch.max (≤ 4 in v1)
  seed?: number;                       // absent ⇒ server generates, when supported (§0.11)

  references?: ReferenceInput[];
  base?: ReferenceInput;               // edit / inpaint / outpaint / upscale source
  mask?: MaskInput;
  expand?: { top: number; right: number; bottom: number; left: number };  // outpaint, px

  presetId?: string;                   // resolved BEFORE the adapter sees it
  presetStrength?: number;             // 0–1
  characterId?: string;
  referenceSetId?: string;
  paletteId?: string;
  moderation?: string;

  source: "composer" | "detail_editor" | "canvas" | "api" | "recreate";
  canvas?: { canvasId: string; nodeId: string };

  /** Escape hatch. Never populated by first-party UI; surfaced only in Advanced → Custom. */
  providerOptions?: Record<string, unknown>;
}

/** What every adapter method actually receives. Declared here because estimate(),
 *  submit(), poll() and §6.5 step 6 all take it. */
export interface NormalizedRequest
  extends Omit<GenerateRequest, "presetId" | "presetStrength" | "characterId" |
                                "referenceSetId" | "paletteId" | "size"> {
  jobId: string;                       // ULID, one per output
  jobSetId: string;
  batchIndex: number;
  batch: number;                       // 1 when the runner fans out
  size: PixelSize | { aspect: AspectRatio };
  seed?: number;                       // filled only when capabilities.seed.supported
  promptAfterPreset: string;
  manifestVersion: string;
  paramsHash: string;                  // §0.11
}

export type PixelSize = { width: number; height: number };
export interface PerImagePrice { quality?: string; tier?: ResolutionTier; usd: number }
export interface Diagnostic { level: "error" | "warning"; field?: string; code: string; message: string }
```

Normalisation happens in core, once, before any adapter code runs. `normalize(model, req) → { request: NormalizedRequest; diagnostics: Diagnostic[] }`:

1. **Resolve the preset, character, reference set and palette.** The full resolution order is §0.8's and is logged verbatim onto the job set. The template placeholder is **`{prompt}`, single brace, exactly once** (§0.8); `{{name}}` is §5.9's user-variable syntax and resolves first. After this step `presetId`, `characterId`, `referenceSetId` and `paletteId` are gone and the adapter sees only plain prompt text and plain references. *This is our open substitute for provider-hosted style catalogues and colour-transfer presets — §6.10.*
2. **Validate against the manifest.** Unknown quality id, ratio not in `ratios`, `batch > max`, `references.length > max`, mask without `ops.inpaint` → a `Diagnostic`. A negative prompt on a model with `negativePrompt: false` is **never** a diagnostic: core appends it as a single trailing `Avoid: …` sentence per §0.8 and records the emulation on the job row, so the Info panel shows *"This model has no Avoid field. Openfield added it to the prompt instead."* `unsupportedParamPolicy: "reject"` turns a diagnostic into an `unsupported_param` error before submit; `"drop-with-warning"` strips the field and records the warning on the job row.
3. **Resolve size to pixels** where the provider wants pixels. `resolveSize(ratio, tier)`: long edge = tier px (512 / 1K 1024 / 1.5K 1536 / 2K 2048 / 4K 4096), short edge = `round(long × min/max)` snapped down to `multipleOf`, then clamped to `[minEdge, maxEdge]` in `size.mode: "free"`. In `size.mode: "aspect"` the long edge can never exceed the largest declared `resolution.tier` — which is exactly what bounds the OpenAI models at 1536 (§6.14). `3:4 @ 2K → 1536×2048`. The resolved pair is stored on the job so the Info panel can show `Size 1536×2048` alongside `Resolution 2K`.
4. **Fill seeds.** **Seeds are generated server-side here, one per output, only when `capabilities.seed.supported`; otherwise `jobs.seed` stays NULL.** This is the single source for seed generation (§0.11) — the composer always sends `seed: null` unless the user locked one, and a locked seed with `batch > 1` derives `seed, seed+1, … seed+n−1`.
5. **Plan the fan-out.** `batch.native ? one call with n : batch × single-image calls`, each with its own seed and its own per-attempt idempotency key (§6.7).
6. **Freeze.** The `NormalizedRequest` plus `{ modelKey, manifestVersion, promptAfterPreset }` is hashed into `paramsHash` and the whole object is written to `job_sets.request_json`. **Recreate replays that object**, never the UI state and never the current manifest, so a manifest change can never silently alter a re-run (§0.1, §0.11).

### 6.6 Response normalisation

```ts
export interface GeneratedImage {
  assetId: string;             // already written to the asset store by the adapter
  index: number;               // position within the job set
  width: number;
  height: number;
  mimeType: string;
  bytes: number;
  seed?: number;
  partial?: boolean;           // a progressive preview, superseded by the final frame
}

export interface ProviderUsage {
  inputTextTokens?: number;
  inputImageTokens?: number;
  cachedInputTokens?: number;  // billed at price.cachedInputPerMTok where reported (§6.9)
  outputImageTokens?: number;
  imagesBilled?: number;
  seconds?: number;
  raw?: Record<string, number>;
}

export interface SafetyVerdict {
  scope: "input" | "output";
  action: "allowed" | "filtered" | "blocked";
  category?: string;           // provider vocabulary, passed through verbatim
  message?: string;
}

export interface JobResult {
  images: GeneratedImage[];
  revisedPrompt?: string;      // shown in the Info panel as "Prompt (revised by model)"
  usage?: ProviderUsage;
  cost?: CostActual;
  safety?: SafetyVerdict[];
  /** Redacted provider payload minus image bytes. Kept for the Error log. */
  providerRaw?: unknown;
  timings: { submittedAt: number; firstOutputAt?: number; completedAt: number };
}
```

Adapters **must** stream image bytes into `ctx.assets` and return `assetId`s. Returning base64 up the stack is a conformance failure: it defeats the memory budget of a batch of large images and risks leaking bytes into log lines. Bytes are stored exactly as returned (§0.7, §8.5.1) — no re-encode, no EXIF strip.

### 6.7 Job model

Openfield mirrors the two-level shape observed in the reference product, because it is what the feed needs: a **job set** is one submit (params + N outputs); a **job** is one output tile (§0.1).

```ts
/** §0.4 is canonical; this is the declaration site. jobs.status and job_sets.status
 *  mirror these CHECK-for-CHECK. */
export type JobState =
  | "pending"      // accepted locally, not yet sent
  | "submitting"
  | "queued"       // provider-side queue
  | "running"
  | "succeeded" | "failed" | "canceled" | "interrupted";

export type JobSetState = JobState | "partial";   // some jobs succeeded, some failed

export interface JobHandle {
  jobId: string;                    // ULID, per §8.2
  providerRef?: string;             // request_id / prediction id
  statusUrl?: string;
  cancelUrl?: string;
  /** Anything the adapter needs to resume after a server restart. JSON-serialisable. */
  resume?: Record<string, unknown>;
  attempt: number;
}

export interface JobUpdate {
  state: JobState;
  progress?: number;                // 0–100 when the provider reports it
  etaMs?: number;
  partial?: GeneratedImage;         // progressive preview frame
  result?: JobResult;               // present on "succeeded"
  error?: ProviderError;            // present on "failed"
  nextPollAfterMs?: number;         // adapter may override the backoff schedule
}
```

**Lifecycle.** `pending → submitting → (queued)* → running → succeeded | failed`, with `canceled` reachable from any non-terminal state and `interrupted` reachable on restart. Synchronous providers are modelled identically: `submit()` performs the blocking HTTP call, resolves with a handle already carrying the result, and the first `poll()` returns `succeeded`. The runner therefore has exactly one code path for OpenAI's blocking `/v1/images/generations` and for a queue-based provider.

**Runner rules.**

| Concern | Rule |
|---|---|
| Concurrency | Effective per-provider cap = `min(providers.concurrency_cap, capabilities.limits.maxConcurrent)`; global cap = `settings.globalConcurrency`, default 4 (§8.4.2, §0.12). Excess sits in `pending`; the feed still shows its placeholder tiles |
| Poll schedule | 800 ms first poll, ×1.6 backoff, cap 5 s, ±20 % jitter; `nextPollAfterMs` and `Retry-After` win over the schedule |
| Retry | Only `retryable` codes (§6.8): `network`, `timeout`, `rate_limited`, `provider_unavailable`. `maxAttempts` 3 (1 + 2 retries), full-jitter backoff 1 s / 4 s / 15 s ±20 %; `Retry-After` always wins. Non-retryable errors fail immediately |
| Timeout | Per-attempt timeout = `limits.requestTimeoutMs` (default 120 000 generate, 300 000 upscale); whole-job deadline `jobDeadlineMs` 900 000, then `timeout` + cancel. These two values are canonical; §8.4.2's `jobTimeoutMs` is deleted |
| Cancellation | §0.12. Neither launch adapter implements provider-side cancel, so every v1 cancellation aborts the fetch, marks `canceled`, discards any late result and writes a `usage_log` row at full estimate with `discarded = 1`. The copy is verbatim: *"Canceled. You may still be charged for work that already started."* |
| Durability | Handles live in SQLite. On restart the runner re-attaches to every resumable non-terminal job and resumes polling; **jobs whose adapter cannot resume are marked `interrupted` (§8.4.5); they are never auto-resubmitted** (double-billing risk) |
| Idempotency | `idempotencyKey` is the **client-supplied job-set key** (§0.2); per-attempt provider headers are `` `${idempotencyKey}:${jobIdx}` ``, stable across retries, so a retried timeout cannot double-bill on providers that honour the header |

**Events to the browser.** One SSE stream, **`GET /api/events`** (§8.3.2 owns it; `GET /api/jobs/stream` does not exist). The event types this section depends on are `job.queued`, `job.started`, `job.progress`, **`job.partial`**, `job.output`, `job.failed`, `job.canceled` and `job_set.completed`. `job.partial` is what terminates `ImageModel.stream?()` and `capabilities.streaming.partialImages` — partial frames are written to `tmp/`, served from a volatile thumb path, never inserted into `assets`, and superseded by the final `job.output` (§0.6). Placeholder tiles (Generating pill + Cancel pill, aspect-ratio-correct) subscribe to the same stream.

### 6.8 Error taxonomy

```ts
export type ErrorCode =
  | "auth_missing" | "auth_invalid" | "auth_forbidden"
  | "billing_required" | "quota_exceeded" | "rate_limited"
  | "content_refused" | "content_flagged_input"
  | "unsupported_param" | "capability_unsupported" | "invalid_request" | "payload_too_large"
  | "provider_unavailable" | "provider_error"
  | "network" | "timeout" | "disk_full" | "canceled" | "unknown";

export class ProviderError extends Error {
  code!: ErrorCode;
  retryable!: boolean;
  userMessage!: string;      // our copy, shown verbatim in the UI
  retryAfterMs?: number;
  httpStatus?: number;
  providerCode?: string;     // provider's own code, shown in the Error log only
  field?: string;            // for unsupported_param / invalid_request
  hint?: { action: "open-settings" | "open-model-picker" | "edit-prompt" | "retry"; label: string };
}
```

`ErrorCode` is **canonical for anything that reaches a job row, a feed tile, a node band or an SSE frame** (§0.5). `retryable: true` for exactly `network`, `timeout`, `rate_limited`, `provider_unavailable`.

**HTTP transport codes are a separate, small set and never overlap**: `bad_request`, `not_found`, `conflict`, `internal` — plus *any `ErrorCode` above* when the failure originated in a provider call. §8.3's list carries nothing else. `jobs.error_code` and `job_sets.error_code` are commented "one of §0.5 `ErrorCode`" (§0.5 owns the taxonomy; this section is only its declaration site).

Every adapter exports **one** `mapError` signature — `mapError(res: Response, body?: unknown): Promise<ProviderError>` — because it must be able to read the body. Every call site is `throw await mapError(res, body)` or `error: await mapError(res, body)`. Unmapped conditions become `unknown`, never a thrown raw HTTP body.

**Spelling is US `canceled` / `canceling` in every enum, column, event name and UI string** (§0.1).

| Code | Typical trigger | What the UI shows |
|---|---|---|
| `auth_missing` | No key stored for the selected provider | Generate is disabled; button sub-label "Add a key to use this model", click → Settings → Keys |
| `auth_invalid` | 401 / bad key | Job fails; "This key was rejected." + *Change key* |
| `auth_forbidden` | Key lacks access to this model | Job fails; "Your key can't use `<Model>`." + *Choose another model* |
| `billing_required` | No payment method / credits at 0 | "This key is out of credit." + link to their console |
| `quota_exceeded` | Hard monthly/org limit | Same copy as billing, plus *Try again* disabled until the user dismisses |
| `rate_limited` | 429 | Tile stays in `running` with "Too many requests. Retrying in Ns"; auto-retry ×2, then fail |
| `content_refused` | Output blocked by provider safety | Muted refusal card: "The model wouldn't make this." + the provider's category if given + *Reuse*. Never retried |
| `content_flagged_input` | A reference image rejected | Names the offending reference thumbnail |
| `unsupported_param` | Manifest/reality mismatch, `reject` policy | Inline chip error before submit: "`<Model>` doesn't support `<setting label>`." (the setting's name as the UI shows it, never the wire field). Generate blocked until fixed |
| `capability_unsupported` | The op itself is not in this model's manifest | "This model can't do that." + *Reuse* |
| `invalid_request` | 400 we cannot attribute to one field | "These settings didn't work." + Error log |
| `payload_too_large` | Reference/base image over limit | "Reference image is too large (max N MB)." + offer to downscale locally |
| `provider_unavailable` | 5xx, 503, maintenance | "The model isn't responding. Retrying…" then "The model ran into a problem. Try again later." |
| `provider_error` | Mapped 5xx with a body; also an asset host outside `meta.assetHosts` (§6.11) | Generic failure card + Error log |
| `network` | DNS/TLS/socket | "Couldn't connect." |
| `timeout` | Per-attempt or job deadline | "This took too long." + *Try again* |
| `disk_full` | Ingest could not write the file (§8.5.1) | "Couldn't save. Your disk is full." + Free up space |
| `canceled` | User cancel | "Canceled. You may still be charged for work that already started." + a `usage_log` row flagged `discarded` |

§0.5 owns the failed-tile copy table that §2.4 renders; the column above is the same copy stated once for adapter authors.

The **Error log** (Settings → Help, and a link on every failure card) shows the redacted request payload, HTTP status, `providerCode` and the redacted response — enough to file a bug, with no credential material.

### 6.9 Cost estimation and usage accounting

The reference product prints a credit cost on every actionable control. Openfield keeps that affordance and replaces credits with **USD estimates**.

```ts
export type PriceModel =
  | { kind: "per_image"; currency: "USD"; tiers: PerImagePrice[]; pricedAt: string; sourceUrl: string }
  | { kind: "per_token"; currency: "USD";
      textInputPerMTok: number; imageInputPerMTok: number; imageOutputPerMTok: number;
      cachedInputPerMTok?: number;
      /** Adapter-declared output-token cost per (quality, size) — the only way to pre-estimate. */
      outputTokenTable: { quality: string; size: string; tokens: number }[];
      pricedAt: string; sourceUrl: string }
  | { kind: "per_second"; currency: "USD"; perSecond: number; pricedAt: string; sourceUrl: string }
  | { kind: "provider_estimate"; currency: "USD"; pricedAt: string; sourceUrl: string }
  | { kind: "unknown" };

export interface CostEstimate {
  currency: "USD"; min: number; max: number;      // max equals min when exact
  confidence: "exact" | "estimated" | "unknown";
  basis: string;               // "3 images × $0.134 (2K)" — a human string, shown in the tooltip
  pricedAt: string;
}

export interface CostActual {
  currency: "USD"; amount: number;
  confidence: "reconciled" | "estimated" | "unknown";
  basis: string;
}

/** Pure. Touches manifest.price only, never credentials. Exported from the browser-safe
 *  entry @openfield/providers/manifest and imported by apps/web, which already holds the
 *  manifest in memory (§0.16). */
export function estimate(manifest: ModelManifest, req: NormalizedRequest): CostEstimate;
```

- **Where prices come from.** The adapter declares them, with `pricedAt` and `sourceUrl`. The UI never presents them as authoritative: the Generate tooltip and the Usage screen both carry *"Prices as of `<date>`. They may have changed since."* A `~/.openfield/prices.json` overlay lets a user correct any number without a code change; `refreshPricing()` proposes a diff in Settings that the user accepts or rejects — prices are never changed silently.
- **Before the run.** **The composer computes the estimate locally from the manifest already in memory**, so the Generate sub-label updates live as chips change: `About $0.27 · 2 images`, or `About $0.10–0.34 · 2 images` when token-priced, or `Cost unknown` when `kind: "unknown"`. Canvas node run pills and edit-tool CTAs call the same function. `POST /api/models/:p/:m/estimate` exists for **server-side callers and the canvas run-all preview only** (§8.3), and returns `CostEstimate` exactly. Where an adapter implements `estimateRemote()` the sub-label renders the pure estimate first and upgrades in place when the round-trip resolves; the result is cached per `paramsHash` and never fires on the render path.
- **Cached input.** Where a provider reports cached input tokens they are billed at `cachedInputPerMTok`; **where the field is absent the reconciled figure is an upper bound and is labelled `≤`.**
- **After the run.** If the provider returns usage, `reconcile(usage, price)` computes `CostActual { confidence: "reconciled" }`; otherwise the estimate is stored with `confidence: "estimated"` and the Usage screen marks those rows `~`. A failed job writes a row with `cost_usd = 0` and `cost_source = 'unknown'`, and no cost is ever added to a spend total for a failure; a canceled-after-submit job writes a row at full estimate with `discarded = 1` (§0.13).
- **Usage log.** One row per terminal outcome, using §8.2's column names exactly: `ts, provider_id, model_id, job_set_id, job_id, operation, batch_index, size, quality, outcome, units, estimate_min, estimate_max, cost_usd, cost_source ('reconciled'|'estimated'|'unknown'), price_as_of, discarded, latency_ms, http_status`. Settings → Spending shows totals for Today / 7 days / 30 days / All time, grouped by provider and model, with a "Canceled but charged" line and an Export CSV action. Optional soft **spend guard**: a monthly threshold that, when crossed, requires one extra confirm click before each run. It is local bookkeeping only — Openfield cannot see the user's real provider invoice and says so.

### 6.10 What replaces the closed pieces

| Observed in the reference product | Openfield open substitute |
|---|---|
| Style tile + curated preset grid | **Preset library** — the canonical object is §5.3's; presets are stored in SQLite and resolved before the adapter (§0.8, §6.5 step 1). We ship our own written-from-scratch curated set; users save, import and export presets as JSON. Model-agnostic by construction |
| Trained-identity tile | **Character kit**: a named reference set + an identity prompt fragment, applied through `references[{role:"subject"}]` on models that accept references. No training in v1; `identity.nativeCharacterRefs` is `false` on every launch model and the tile is hidden for models without references |
| Colour-transfer panel + palette presets | **Palette object** (§0.8): extracted colours plus an injection mode — a prompt clause, a `role:"palette"` reference, or both. Hidden on models with no reference support when the mode needs one |
| Camera / Lens wheel pickers | Preset **fragment groups** (camera, lens) in the preset library — two dependent selects that append text; no provider feature required |
| Prompt-enhance toggle | `promptEnhance: "openfield"` — the local enhancer specified in §3.4.3 and shipping in M1 (`M1-16`): a pre-pass through a user-configured text model, off by default, with the rewritten prompt stored and shown in the Info panel. `"native"` where the provider has its own flag |
| Credits / free-gen counter | USD estimate + usage log (§6.9) |
| Upscale tool with a named third-party engine | **Local Lanczos resample ×2/×4 in v1, labelled *Resizes, adds no detail*** (§4.8 row 4). `ops.upscale` remains the slot for a detail-adding upscaler; no launch adapter declares it, so the AI-upscale row renders disabled with "None of your models can upscale. Add a key for one that can." A plugin or a v1.1 adapter fills it (§6.16). Advanced upscale controls are declared per adapter via `extraSchema`, never assumed |
| Background removal | `ops.removeBackground`. No launch adapter declares it, so the row renders disabled with its reason; a local ONNX plugin is documented as the reference implementation (§4.8 row 5) |
| Layer decomposition, relight, angles, enhancer, colour grading | **Capability-gated ops.** Relight, Angles and Enhancer ship as widget-compiled instruction edits (§4.8 rows 7–9); colour grading ships as a local non-generative WebGL stage in the image editor (§4.8 row 6); layer decomposition ships as a **visible disabled plugin slot** (`ops.decomposeLayers`, §4.8 row 1) |
| Per-job-set cost endpoint driving credit labels | Adapter-declared `PriceModel`, optionally `provider_estimate` via `estimateRemote()` (§6.9) |

### 6.11 Key management and security

**Storage.** `~/.openfield/config.json`, file mode `0600`, directory `~/.openfield` mode `0700`, both enforced on every write and re-asserted at boot. Shape:

```jsonc
{
  "version": 1,
  "providers": {
    "openai":     { "apiKey": "sk-…", "baseUrl": null },
    "google":     { "apiKey": "…" },
    "higgsfield": { "keyId": "…", "keySecret": "…" }
  }
}
```

**Precedence.** environment variable → config file → unset. Each `CredentialField` declares its `envVars` (`OPENFIELD_<PROVIDER>_<FIELD>` first, then the provider's conventional name such as `OPENAI_API_KEY`). When an env var is in effect, Settings shows the field read-only with *"Set by `OPENAI_API_KEY`"* and refuses to overwrite the file.

**Never in the browser.**

- `GET /api/settings/keys` returns status only — `{ providerId, present, source: "env" | "file", hint: "…4f2a" }`. There is **no** endpoint that returns a secret value; the field is write-only.
- `PUT /api/settings/keys/:providerId` accepts values, writes the file, and responds with status only.
- Adapters receive credentials from `CallContext`; no credential value may appear in a `JobResult`, a manifest, an SSE frame or an error object. A conformance test asserts this by property-scanning every fixture response for the credential string.

**Redaction.** All adapter logging goes through `RedactingLogger`, which (a) drops `Authorization`, `x-goog-api-key`, `api-key` and `cookie` headers, (b) replaces any substring equal to a loaded credential with `[hidden]`, and (c) applies conservative regex scrubs (`sk-[A-Za-z0-9_-]{16,}`, `AIza[0-9A-Za-z_-]{20,}`) as a second net. `providerRaw` is scrubbed with the same function before it reaches SQLite.

**Network posture.** The server binds `127.0.0.1` only (configurable port, never `0.0.0.0`); the four inbound guards are §0.6's and are mandatory on every method including GET. Outbound connections are restricted to the union of `meta.networkHosts` of enabled adapters **plus asset-download hosts, which must each appear in `meta.assetHosts: string[]`** — a second declared allow-list per adapter (e.g. `cdn.higgsfield.ai`). A download URL whose host is in neither list is refused with `provider_error`, logged with the host, and surfaced as *"Image blocked. It came from an unknown site."* **Redirects are not followed across hosts, and only `https:` is permitted.** Settings → Privacy lists both arrays verbatim. Without this, a provider response — or a typo-squatted proxy behind a user-supplied `baseUrl` — would be an SSRF primitive inside the one process that holds every key.

**No telemetry.** No analytics, no crash reporting, no update ping, no remote config, no bundled fonts or scripts from a CDN at runtime. The only outbound traffic is the provider calls a user's own click causes.

**The disclosure we state plainly**, in Settings and in the README: *"Openfield sends your prompt, reference images, masks and settings to the company behind the model you pick, using your key. Their terms, data retention and content rules apply. Openfield stores nothing online and sends nothing anywhere else."* Where a provider imposes something irreversible — an invisible output watermark, mandatory moderation — the adapter declares it in `safety.notices` and the model-picker row shows it.

**Acceptance criteria.** (1) `grep`ing the client bundle and every HTTP/SSE response for a configured key yields nothing. (2) Starting with `config.json` at mode `0644` triggers a chmod to `0600` and a warning in the log. (3) With no keys at all the app boots, renders the model picker from static catalogs, and disables Generate with actionable copy. (4) A request to a host in neither allow-list is blocked, with a test asserting the block.

### 6.12 Adapter authoring guide

**File layout** (one folder per provider):

```
packages/providers/src/openai/
  index.ts          // createOpenAIProvider(): Provider
  models.ts         // static catalog: ModelManifest[]
  capabilities.ts   // shared capability fragments + per-model overrides
  pricing.ts        // PriceModel per model, with pricedAt + sourceUrl
  map-request.ts    // NormalizedRequest -> provider payload
  map-response.ts   // provider payload -> JobResult
  errors.ts         // mapError()
  discovery.ts      // listModels() + recognise()
  README.md         // endpoints, auth, gaps, how fixtures were captured
  __fixtures__/     // recorded HTTP exchanges (secrets scrubbed at capture time)
```

Adapter folder names `types` and `manifest` are reserved (§0.16).

**HTTP goes through `ctx.fetch`, never the global `fetch`.** The server passes a wrapped fetch (timeout, redacting log, host allow-list), tests pass a stub, and `OPENFIELD_FAKE_PROVIDERS=1` makes the server pass a fetch that replays each adapter's `__fixtures__`, so the whole app runs end to end with no keys and no network. That switch is for development and e2e only, and the server logs it at boot.

**Registration** is static in v1: `packages/providers/src/registry.ts` exports `builtinProviders = [openai(), google(), higgsfield()]`, re-exported by `@openfield/providers/server`. No dynamic plugin loading, no `eval`, no remote adapter fetch; adding an adapter means a PR. (Third-party loadable adapters are deliberately deferred; see §6.16.)

**Capability declaration rules.**

1. Declare only what you have **verified against the live API or official docs**. Unverified ⇒ `false` / omitted, and a line in the adapter README. A false positive breaks the UI contract; a false negative only hides a control.
2. Never declare an aspect ratio you do not map. Every entry in `size.ratios` must produce a valid payload in the conformance golden tests.
3. `quality.levels[].id` is the exact wire value. Labels and hints are ours, and the zip between them is asserted by a test — an off-by-one here ships a control that sends the wrong tier.
4. `batch.native: true` obliges you to return exactly `n` images or a `provider_error`.
5. If the provider mutates the prompt, return `revisedPrompt`. If it watermarks or moderates unconditionally, say so in `safety.notices` — and never transcode bytes you make that claim about (§0.7).
6. `price.pricedAt` and `price.sourceUrl` are mandatory for anything other than `kind: "unknown"`.
7. `limits.typicalLatencyMs` must come from at least 10 observed runs; it drives placeholder copy, not correctness.
8. `meta.assetHosts` lists every host an image may be downloaded from. An empty array means "this provider returns bytes inline" and is the safest declaration.

**Conformance suite** — `bun test packages/providers/conformance`. Runs in `offline` mode against `__fixtures__` in CI and in `live` mode (`OPENFIELD_CONFORMANCE=live`, real key) before a release. A new adapter merges only when all of these pass:

| # | Test |
|---|---|
| 1 | Manifest parses with `modelManifestSchema` from `@openfield/core` in strict mode (no unknown fields) |
| 2 | Every declared aspect ratio and every declared quality id maps to a valid payload (golden snapshots) |
| 3 | `size.default`, `resolution.default` and `quality.default` are members of their own option lists |
| 4 | The exported `estimate(manifest, req)` is pure for this manifest: no network, no clock, deterministic, returns USD |
| 5 | `submit()` returns a `JobHandle` that survives `JSON.parse(JSON.stringify(h))` and can be polled after a simulated restart |
| 6 | `poll()` is idempotent and safe to call after a terminal state |
| 7 | Batch: `batch.native` honours `n`; non-native fan-out yields exactly `n` distinct assets |
| 8 | Seed: when `seed.supported && echoed`, the returned seed equals the requested seed |
| 9 | Cancel: terminal `canceled` within 2 s; no asset rows written |
| 10 | 401 fixture → `auth_invalid`, `retryable: false`, non-empty `userMessage` |
| 11 | 429 fixture with `Retry-After: 12` → `rate_limited`, `retryAfterMs === 12000` |
| 12 | 500/503 fixture → `provider_unavailable`, `retryable: true` |
| 13 | Moderation-refusal fixture → `content_refused`, `retryable: false` |
| 14 | Timeout: an aborted fetch surfaces `timeout`, not `unknown`, through `await mapError(res, body)` |
| 15 | Unsupported param honours `unsupportedParamPolicy` (reject → error before submit; drop → warning diagnostic) |
| 16 | Response normalisation: every image has `assetId`, `width`, `height`, `mimeType`, `bytes`; no base64 crosses the interface |
| 17 | Redaction: no credential substring and no `Authorization` header value appears in any log line, error, SSE frame or stored `providerRaw` |
| 18 | `listModels()` with a bad key raises `auth_invalid` and the registry still serves the static catalog; discovered ids `recognise()` rejects land in `RefreshReport.unrecognised`, never in the picker |
| 19 | Only hosts in `meta.networkHosts ∪ meta.assetHosts` are contacted (fetch spy); a download URL on any other host raises `provider_error` |
| 20 | Golden payload snapshots for three canonical requests: t2i 3:4 @1K batch 2; edit with 2 references; inpaint with a mask |
| 21 | Mask polarity: the canonical mask (alpha 0 = edit) is converted to the provider's documented polarity, asserted against a recorded fixture pair |

**Worked skeleton.**

```ts
// packages/providers/src/acme/index.ts
import type { Provider, ImageModel, ModelManifest, CallContext } from "../types";
import { UnknownModelError } from "../types";
import { ACME_MODELS } from "./models";
import { toAcmePayload } from "./map-request";
import { fromAcmePayload } from "./map-response";
import { mapError } from "./errors";

const BASE = "https://api.acme.example/v1";

export function createAcmeProvider(): Provider {
  return {
    meta: {
      id: "acme",
      displayName: "Acme",
      docsUrl: "https://docs.acme.example",
      consoleUrl: "https://console.acme.example/keys",
      networkHosts: ["api.acme.example"],
      assetHosts: ["cdn.acme.example"],
      stable: true,
    },
    credentials: {
      fields: [{
        name: "apiKey", label: "API key", secret: true, required: true,
        envVars: ["OPENFIELD_ACME_API_KEY", "ACME_API_KEY"],
        placeholder: "acme_…",
      }],
    },

    validateCredentials: (v) =>
      v.apiKey?.trim() ? [] : [{ level: "error", field: "apiKey", code: "required", message: "Enter an API key." }],

    recognise: (id) => /^acme-image-/.test(id),

    async verifyCredentials(ctx) {
      const res = await ctx.fetch(`${BASE}/models`, { headers: auth(ctx) });
      if (!res.ok) throw await mapError(res, await safeJson(res));
      return { ok: true };
    },

    async listModels(ctx): Promise<ModelManifest[]> {
      try {
        const res = await ctx.fetch(`${BASE}/models`, { headers: auth(ctx) });
        if (!res.ok) throw await mapError(res, await safeJson(res));
        const remote = ((await res.json()).data as { id: string }[]).filter((m) => this.recognise(m.id));
        return mergeOverStatic(ACME_MODELS, remote);   // static capabilities always win
      } catch (err) {
        ctx.log.warn("model discovery failed; using static catalog", { err });
        return ACME_MODELS;
      }
    },

    model(key): ImageModel {
      const manifest = ACME_MODELS.find((m) => m.key === key);
      if (!manifest) throw new UnknownModelError(key);
      return {
        ...manifest,

        async submit(req, ctx) {
          const res = await ctx.fetch(`${BASE}/images`, {
            method: "POST",
            headers: { ...auth(ctx), "content-type": "application/json",
                       "idempotency-key": `${req.idempotencyKey}:${req.batchIndex}` },
            body: JSON.stringify(toAcmePayload(manifest, req)),
            signal: ctx.signal,
          });
          if (!res.ok) throw await mapError(res, await safeJson(res));
          const body = await res.json();
          return { jobId: req.jobId, providerRef: body.id, statusUrl: body.status_url, attempt: 0 };
        },

        async poll(handle, ctx) {
          const res = await ctx.fetch(handle.statusUrl!, { headers: auth(ctx), signal: ctx.signal });
          if (!res.ok) throw await mapError(res, await safeJson(res));
          const body = await res.json();
          switch (body.status) {
            case "IN_QUEUE":    return { state: "queued" };
            case "IN_PROGRESS": return { state: "running", progress: body.progress };
            case "COMPLETED":   return { state: "succeeded", result: await fromAcmePayload(body, ctx) };
            default:            return { state: "failed", error: await mapError(res, body) };
          }
        },

        async cancel(handle, ctx) {
          if (handle.cancelUrl) await ctx.fetch(handle.cancelUrl, { method: "DELETE", headers: auth(ctx) });
        },
      };
    },
  };
}

const auth = (ctx: CallContext) => ({ authorization: `Bearer ${ctx.credentials.apiKey}` });
```

Pricing lives in `pricing.ts` as data; the shared pure `estimate(manifest, req)` reads it (§6.9). An adapter writes an `estimateRemote()` only when the provider has a **verified** cost endpoint.

### 6.13 Launch adapter — Google Gemini image

> Model ids, capability values and prices below are **as researched on 2026-09-23** and are the adapter's *static catalog*, overridden at runtime by recognised discovery and by `~/.openfield/models.json`. Treat them as a starting point to verify at implementation, not as guarantees.

**Endpoints.** `POST https://generativelanguage.googleapis.com/v1beta/models/{modelId}:generateContent`, with `generationConfig.responseModalities: ["IMAGE"]` and `generationConfig.imageConfig`.
**Discovery.** `GET /v1beta/models`, filtered through `recognise(id)` (known image-family id patterns only). **Image-model detection from `GET /v1beta/models` is not documented (researched 2026-09-23)**: no image-model `models.list` is published and `supportedGenerationMethods` is not documented to flag image output. The adapter therefore treats discovery as a way to learn about **new versions of known families, not new capabilities**; every unrecognised id goes to Settings → Models → Not supported (§6.4).
**Auth.** `x-goog-api-key: <apiKey>` header (never the `?key=` query form — it would land in logs). One credential field, `apiKey`.
**Hosts.** `networkHosts: ["generativelanguage.googleapis.com"]`, `assetHosts: []` — images arrive inline as `inlineData`.
**Naming.** `displayName` is the Nano Banana name Google gives each model (Nano Banana Pro, Nano Banana 2, Nano Banana 2 Lite). The Gemini API id stays in `modelId` and the `key`, and is what gets verified against Google's docs.

| Canonical field | Gemini mapping |
|---|---|
| `prompt` | `contents[0].parts[].text` |
| `references[]` | `contents[0].parts[].inlineData { mimeType, data }`, max 14, order preserved; `role` is expressed in the prompt template, not on the wire. `references.weights: false`, `strengthMode: "none"` |
| `base` (edit) | first `inlineData` part |
| `size` (aspect) | `generationConfig.imageConfig.aspectRatio`; `"auto"` omits the field |
| `resolution` | `generationConfig.imageConfig.imageSize` (`"512" \| "1K" \| "2K" \| "4K"`, uppercase K; the reference's `ImageConfig` spells the smallest tier `512`) |
| `batch` | **client fan-out** — `batch.native: false`, N parallel calls. The manifest's `emulated` array is the union of every emulated row in this table: `emulated: ["batch", "negativePrompt"]` |
| `seed` | not exposed ⇒ `seed.supported: false` (Seed chip disabled with a reason, §6.3) |
| `negativePrompt` | no native field ⇒ `negativePrompt: false` plus `emulated: ["negativePrompt"]`; core appends it as a trailing `Avoid: …` sentence and the chip carries `~` (§0.8, §3.4.4) |
| `quality` | n/a — resolution is the only quality axis |
| `background` / transparency | not exposed ⇒ chip hidden |
| `output.format` | not exposed ⇒ `output.formats: ["jpeg"]`, chip hidden (JPEG is the only documented image output type). **Bytes are stored exactly as returned (§8.5.1)**; format conversion happens only on export (§8.5.4), where the dialog warns *"Changing the format may remove the hidden AI watermark."* |
| `moderation` | not exposed |

**Manifest values (static catalog).** `"auto"` is the first ratio and the default on every Gemini model.

| `displayName` | `key` | Ratios | Resolution tiers | Refs | Batch | Price (declared) |
|---|---|---|---|---|---|---|
| Nano Banana Pro | `google:gemini-3-pro-image` | auto, 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 | 1K, 2K, 4K (default 1K) | 14 | 4 (fan-out) | per_image: $0.134 (1K/2K), $0.24 (4K) |
| Nano Banana 2 | `google:gemini-3.1-flash-image` | the Pro list + 1:4, 4:1, 1:8, 8:1 | 512, 1K, 2K, 4K (default 1K) | 14 | 4 (fan-out) | per_image: $0.045–$0.151 by tier |
| Nano Banana 2 Lite | `google:gemini-3.1-flash-lite-image` | the Pro list | 1K only | 14 | 4 (fan-out) | per_image: $0.0336 |
| Nano Banana | `google:gemini-2.5-flash-image` | auto, 1:1 | 1K | 14 | 4 (fan-out) | unknown; badge `legacy` |

> Verified at M0-07 against Google's resolution tables: only Nano Banana 2 lists 1:4, 4:1, 1:8 and 8:1; Pro and Lite list the standard ten. Nano Banana (`gemini-2.5-flash-image`) is left out: Google shuts it down on October 2, 2026, and discovery lists it as not supported. `packages/providers/src/google/README.md` records each source and what is still unverified until a live run.

Common: `ops.textToImage: true`, `ops.imageEdit: true`, `ops.inpaint/outpaint/upscale/removeBackground/detectText/decomposeLayers: false`, `promptEnhance: "openfield"` (the local enhancer of §3.4.3), `styleStrength: false`, `streaming.partialImages: false`, `unsupportedParamPolicy: "drop-with-warning"`, `safety.notices: ["Images include a hidden AI watermark."]`, `limits.typicalLatencyMs: [3000, 9000]`, `limits.requestTimeoutMs: 120000`, `limits.maxConcurrent: 4`.

**Known gaps.** No seed ⇒ Recreate replays the request, not the image, and the Info panel says *"This model can't make an exact copy. Expect changes."* (§0.1). No native negative prompt — Openfield appends it as an `Avoid: …` instruction and the chip shows `~` (§0.8). No transparent background. Mask-based inpainting is not exposed, so masked edits on Gemini go through the regional fallback with the **Approximate** badge (§0.9) and the canvas Inpaint node is unavailable on these models. Batch is client fan-out, so cost scales exactly linearly and a partial batch failure leaves a mixed job set (allowed: each job tile fails independently, and the job set is `partial`). Per-request image count and Batch-API pricing are not wired in v1.

### 6.14 Launch adapter — OpenAI GPT Image

**Endpoints.** `POST https://api.openai.com/v1/images/generations` (t2i, JSON) and `POST /v1/images/edits` (edit + inpaint, multipart: `image[]`, optional `mask`). The adapter requests `b64_json` so image bytes arrive inline.
**Discovery.** `GET /v1/models`, filtered through `recognise(id)` (`/^gpt-image-/`). Image capability is **not** documented as discoverable (researched 2026-09-23), so the same allow-listed rule as §6.13 applies.
**Auth.** `Authorization: Bearer <apiKey>`; optional non-secret `organization` option. A custom `baseUrl` waits for the generic OpenAI-compatible provider of §6.16 (§6.18).
**Hosts.** `networkHosts: ["api.openai.com"]`, `assetHosts: []`.

| Canonical field | OpenAI mapping |
|---|---|
| `prompt` | `prompt` |
| `size` + `resolution` | `size`: `"auto"`, `"1024x1024"`, `"1536x1024"`, `"1024x1536"`, or a custom `WxH` on multiples of 16 produced by `resolveSize(ratio, tier)`. The Resolution chip stays separate in the UI, and `resolveSize()` **clamps the long edge to 1536** |
| `quality` | `quality`: `low` / `medium` / `high` / `max` / `auto` |
| `batch` | `n` — `batch.native: true`, max 4 in v1 |
| `background` | `background`: `auto` / `opaque` / `transparent` |
| `output.format` | `output_format`: `png` / `jpeg` / `webp`; `output.compression` → `output_compression` 0–100 (jpeg/webp only). Applied by the provider, not by us — the returned bytes are still stored verbatim (§8.5.1) |
| `moderation` | `moderation`: `auto` / `low` (Settings-level default, per-run override in Advanced) |
| `references[]` | `/v1/images/edits` multipart `image[]`. `references.weights: false`, `strengthMode: "none"` |
| `base` + `mask` | `image` + `mask`; **the adapter converts Openfield's canonical mask (alpha 0 = edit, §0.9) to whatever polarity the live probe establishes for `/v1/images/edits`, covered by a fixture test (conformance 21). Polarity is unconfirmed in the research.** `invert` and `featherPx` are applied by core before upload; the request carries a mask **asset id** only |
| `expand` (outpaint) | **synthesised**: pad the base onto a transparent canvas of the target size, derive a mask covering the padding, call `/v1/images/edits`. `ops.outpaint: true` with a manifest note that it is mask-synthesised |
| `seed` | not documented ⇒ `seed.supported: false` until verified live |
| `negativePrompt` | no native field ⇒ `negativePrompt: false` plus `emulated: ["negativePrompt"]`; core appends it as a trailing `Avoid: …` sentence and the chip carries `~` (§0.8, §3.4.4) |
| streaming | partial images available on the streaming path ⇒ `streaming.partialImages: true`, `maxPartials: 3`, surfaced as `job.partial` (§6.7) |

**Quality ladder.** The id→label zip is exact, because an off-by-one ships a control that sends the wrong tier:

| Wire id | Label | Hint |
|---|---|---|
| `low` | Low | Fastest and cheapest |
| `medium` | Medium | Balanced |
| `high` | High | Sharpest detail |
| `max` | Max | Best quality |
| `auto` | Auto | Let the model choose |

> The observed product exposes a five-tier ladder including **Extra High**; if the API confirms a matching tier, declare it as an additional `QualityLevel` — **do not fabricate one.**

**Manifest values (static catalog).**

| Model | `key` | Quality levels | Ratios | Resolution tiers | Batch | Badges |
|---|---|---|---|---|---|---|
| GPT Image 2.5 Sunburst | `openai:gpt-image-2.5-sunburst` | low, medium, high, max, auto | auto, 1:1, 3:2, 2:3, 16:9, 9:16, 4:3, 3:4, 21:9, 27:16, 16:27, 9:8, 8:9 | 1K, 1.5K (default 1K) | 4 native | `new` |
| GPT Image 2.5 Flare | `openai:gpt-image-2.5-flare` | low, medium, high, max, auto | same 13 | 1K, 1.5K (default 1K) | 4 native | `new` |
| GPT Image 2 | `openai:gpt-image-2` | low, medium, high | auto, 1:1, 3:2, 2:3, 16:9, 9:16, 4:3, 3:4, 21:9 | 1K, 1.5K (default 1K) | 4 native | `legacy` |

> **Sizes above 1536 on the long edge are not documented for the Images API (researched 2026-09-23).** The `2K` and `4K` tiers are added only after a live probe confirms them; until then the largest declared tier is `1.5K`, so `resolveSize()` can never produce a long edge above **1536** and snaps both edges to multiples of 16. Ratios beyond the three documented named sizes are reached through the documented custom-size form, which is why every declared ratio still maps (conformance 2).

Common: `ops.textToImage/imageEdit/inpaint/outpaint: true`, `ops.upscale/removeBackground/detectText/decomposeLayers: false`, `transparency: true`, `references.max: 4` (conservative until the documented limit is confirmed), `promptEnhance: "openfield"` (§3.4.3), `styleStrength: false`, **`limits.requestTimeoutMs: 180000`** — the research records complex prompts taking up to ~2 minutes (not confirmed against official docs), and 150 s leaves no headroom — `limits.typicalLatencyMs: [8000, 120000]`, `limits.maxConcurrent: 2`, `unsupportedParamPolicy: "reject"`.

**Pricing.** `kind: "per_token"` — text input $5.00/1M, image input $8.00/1M, image output $30.00/1M, with `cachedInputPerMTok` declared once the discount rate is confirmed (as researched 2026-09-23). Because there is no published per-image rate, the adapter ships an `outputTokenTable` mapping (quality × size) → output tokens, derived from measured runs and marked `estimated`; the Generate button therefore shows a **range** (`About $0.10–0.34 · 2 images`). If the response carries a `usage` block, `reconcile()` computes `CostActual { confidence: "reconciled" }`. **Whether the Images API returns `usage` is unconfirmed (2026-09-23) and must be established by the same live probe as the mask polarity (`M2-15`); until then the adapter ships `confidence: "estimated"` and the Usage screen marks those rows `~`.** Where cached input tokens are not reported, a reconciled figure is an upper bound and is labelled `≤` (§6.9).

**Known gaps.** Seed unconfirmed. `n` ceilings per quality/size unclear — we cap at 4 and surface any provider rejection as `invalid_request` naming the batch field. Maximum reference-image count undocumented (we declare 4). Mask polarity and the `usage` block are both unconfirmed and both close with `M2-15`. No character-identity feature. Long runs can approach two minutes; the placeholder tile shows its "Still working" line on the §2.4 schedule.

### 6.15 Launch adapter — Higgsfield (conditional, experimental)

This adapter is built in M3 (`M3-16`) against the real public API, using the owner's key. The facts below are from research and are verified with that key in M3; anything the key can't reach stays undeclared. If the public API isn't reachable with a user key, the adapter is present but `meta.stable: false` and hidden behind Settings → Experimental. Openfield is fully functional without it, and nothing in the product depends on it.

**Endpoint (only one confirmed).** `POST https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard`.
**Auth.** `Authorization: Key ${keyId}:${keySecret}` — a **two-field** credential schema (`keyId`, `keySecret`, both secret), which is precisely why `CredentialSchema` is a field list rather than a single string.
**Hosts.** `networkHosts: ["api.higgsfield.ai"]`, `assetHosts: ["cdn.higgsfield.ai"]`.
**Job model.** Submit returns `request_id` + status URL; we poll (webhooks are unusable here — a `127.0.0.1`-bound app has no inbound address, so webhook support is declared but never enabled in v1).

| Canonical field | Higgsfield mapping |
|---|---|
| `prompt` | `prompt` |
| `size` | `resolution: "WxH"`, resolved by `resolveSize()` |
| `quality` | `quality` (provider vocabulary; exposed as-is with our labels) |
| `batch` | `batch_size`, native |
| `seed` | `seed` (declared supported, echoed — to be confirmed live) |
| `negativePrompt` | `negative_prompt` |
| `enhancePrompt` | `enhance_prompt` (`promptEnhance: "native"`) |
| Openfield preset | `style` + `style_strength` (`styleStrength: true`) **only** when the user supplies a provider style id (see gaps); otherwise the preset resolves to prompt text like every other adapter |
| `references[]` | reference-image parameter, count unverified ⇒ declared `max: 1` until confirmed |
| Cost | **`kind: "unknown"` at launch; the Generate button reads *Cost unknown*.** Upgrade to `provider_estimate` (via `estimateRemote()`, §6.9) only if a live probe confirms the endpoint's path and response shape, and `confidence` is then `"estimated"`, never `"exact"` |

**Known gaps.** **No public per-job cost endpoint has been verified** — the only evidence is a third-party blog with no path, request or response shape recorded, and the private `/fnf/*` cost table observed in the walkthrough is out of bounds (§1.11). Endpoints for anything beyond Soul v2 standard are undocumented ⇒ one model in the static catalog. No documented style-listing endpoint, so the provider's style ids cannot be enumerated: the UI offers a free-text "Style ID" advanced field plus a user-editable `~/.openfield/higgsfield-styles.json`, and our own preset library remains the default path. Identity/character training is undocumented ⇒ `identity.nativeCharacterRefs: false`. The node-graph editing product appears to be UI-only with no public API ⇒ no canvas integration. Rate limits and concurrency policy undocumented ⇒ `limits.maxConcurrent: 2` conservatively. Retention of output media on the provider's CDN is undocumented, so the runner assumes it is time-limited and downloads every asset to `~/.openfield/assets` immediately on completion — from `cdn.higgsfield.ai` only (§6.11) — and never links to a remote URL.

### 6.16 v1.1 — queue providers and OpenAI-compatible endpoints

Three extensions are designed for now and shipped later. Nothing in §6.2–§6.9 changes to accommodate them; that is the test of the design.

- **fal.ai** — a *schema-driven* adapter. Its queue states (`IN_QUEUE → IN_PROGRESS → COMPLETED`) map 1:1 onto `queued/running/succeeded`; submit/status/result/cancel map onto `submit/poll/cancel`. Each model publishes a JSON input schema, so `listModels()` can build a `Capabilities` object automatically via a **schema→capability inference table** (`image_size` enum → `size.mode:"enum"`; `num_images` → `batch.max`; `seed` → `seed.supported`; `negative_prompt` → `negativePrompt`), with a hand-written override map for the models we curate. Anything not inferable lands in `extraSchema` and is rendered by the generic Advanced form (§3.4.7).
- **Replicate** — same shape via `POST /v1/predictions` + `GET /v1/predictions/{id}`, states `starting/processing/succeeded/failed/canceled` mapping directly onto ours, and per-model `openapi_schema` feeding the same inference table. Its 60-second synchronous mode is an optimisation inside `submit()`, invisible to the runner.
- **Generic OpenAI-compatible endpoint** — a provider whose credential schema adds a required `baseUrl`, reusing the OpenAI request/response mappers wholesale. Because it points at an arbitrary host, it is `meta.stable: false`, its `networkHosts` and `assetHosts` are derived from the user's own `baseUrl`, and Settings shows an explicit warning that prompts and images go to that host. Capabilities default to the conservative manifest and are edited by the user in `~/.openfield/models.json`.

Both queue adapters also fill the capability slots no launch adapter declares — `ops.upscale`, `ops.removeBackground`, `ops.decomposeLayers` — which re-enables the corresponding edit tools (§4.8) and the canvas Upscale node (§7.5) without any UI work.

### 6.17 Settings surface

Eleven sections write requirements into a screen no section owned. Settings is a single route (`/settings`) with a **left rail** of nine panes, in this order:

**API keys · Models · Defaults · Appearance · Storage · Spending · Privacy · Help · Experimental**

Rules that hold across every pane: secrets are write-only (§6.11); everything that is not a secret or a boot-time value lives in the `settings` table as a JSON value keyed by the `settings` key below, reached through `GET`/`PATCH /api/settings` (§8.3); a pane never invents a default — the owning section does. Panes render in this order and each one states, in one line at the top, what it can and cannot see (e.g. Usage: *"Tracked on this computer. Your actual bill may differ."*).

| Pane | Setting | `settings` key | Default | Specified in |
|---|---|---|---|---|
| API keys | Your keys (per provider, write-only; env-var badge when overridden) | *(none — `config.json`, mode 0600)* | unset | §6.11 |
| API keys | Check key · last 4 characters · last error | *(read-only, from `providers` table)* | — | §6.2, §8.2 |
| API keys | Custom server address (OpenAI and compatible services) | *(none — `config.json`)* | `null` | §6.14, §6.16, §6.18 |
| API keys | Runs at once, per company | *(`providers.concurrency_cap`)* | openai 2 · google 4 · higgsfield 2 | §0.12 |
| Models | Update model list · last checked | `modelRefreshedAt` | — | §6.4 |
| Models | Check for new models every | `modelRefreshHours` | `24` | §6.4 |
| Models | **Not supported**: discovered ids (read-only list) | *(from `RefreshReport`)* | — | §6.4 |
| Models | Your own model list (open the file, check it for errors) | *(file: `~/.openfield/models.json`)* | absent | §6.4 |
| Models | Your own prices (open the file) · price updates to review | *(file: `~/.openfield/prices.json`)* | absent | §6.9 |
| Defaults | Default model | `defaultModel` | first ready model | §8.3 |
| Defaults | Default aspect ratio | `defaultAspect` | manifest default | §8.3, §6.3 |
| Defaults | Default batch size | `defaultBatch` | `1` | §0.10 |
| Defaults | Runs at once | `globalConcurrency` | `4` | §0.12, §8.4.2 |
| Defaults | Enhance: default mode and model | `enhanceMode`, `enhancerModel` | `off`, unset | §3.4.3 |
| Defaults | Allow approximate area edits (one-time explainer) | `regionalFallback` | `true` | §0.9, §4.6 |
| Appearance | Theme | `theme` | `system` | §2.2 |
| Appearance | Grid size | `feedZoom` | `3` | §0.10, §2.3 |
| Appearance | Show tips while generating | `tipsCard` | `true` | §2.4, §2.9 |
| Storage | Library location (read-only readout) | *(none — env/`config.json`)* | `~/.openfield` | §8.1 |
| Storage | Space used by images, thumbnails and trash | *(read-only, `GET /api/stats`)* | — | §8.6 |
| Storage | Thumbnails: "On", or "Thumbnails are off. Images show at full size, so scrolling may be slower." | *(read-only, checked at boot)* | on when `sharp` loads | §0.10, §8.5.2 |
| Storage | Thumbnail quality | `thumbQuality` | `82` | §0.10, §8.5.2 |
| Storage | Empty the trash automatically (Never, or after a number of days) | `trashRetentionDays` | `null` (never) | §8.6 |
| Storage | Clear thumbnail cache · Empty trash · Clean up files · Back up · Rebuild search | *(actions, `POST /api/maintenance/*`)* | — | §8.6, §0.7 |
| Spending | Totals for today, 7 days, 30 days, all time, by company and model · Canceled but charged · Export CSV | *(read-only, `GET /api/usage`)* | — | §6.9 |
| Spending | Monthly spending limit | `spendGuardUsd` | `null` (off) | §6.9 |
| Privacy | Allowed connections: `networkHosts` ∪ `assetHosts` per enabled adapter (read-only) | *(from `ProviderMeta`)* | — | §6.11 |
| Privacy | The disclosure paragraph and "No tracking" statement (read-only) | — | — | §6.11 |
| Help | Error log: redacted request, HTTP status, `providerCode`, redacted response | *(read-only)* | — | §6.8, §0.5 |
| Help | Log detail · Copy report (keys removed) | `logLevel` | `info` | §6.11 |
| Experimental | Show experimental models (`meta.stable: false`) | `showExperimental` | `false` | §6.2, §6.16 |
| Experimental | Also save canvases as files | `canvasFileWriteThrough` | `false` | §7.8 |
| Experimental | Upscale plugin: the program to run (it reads one image and writes a larger copy) | `upscaleCommandPath` | `null` | §7.5, §4.8 |

**Acceptance criteria.** (1) Every setting the rest of the PRD references appears in exactly one row above, with the same key the API returns. (2) A pane with no configured provider still renders and tells the user what to do next (§2.10's first-run path). (3) Changing any row writes through `PATCH /api/settings` and takes effect without a restart, except `OPENFIELD_HOME` and the server port, which say so inline.

### 6.18 Open questions

Every item below is a **provider fact we could not verify**, and each names the milestone task that closes it. Resolved vocabulary and UI questions are decided in §0 and are not restated here.

- **OpenAI mask polarity** for `/v1/images/edits` — unconfirmed in the research; the adapter converts from Openfield's canonical alpha-0-is-edit mask either way. Closed by **`M2-15`** (live probe of polarity, dimensions and format, fixture recorded, §6.14 note updated). Blocking prerequisite for `M2-05`/`M2-06`.
- **Whether `POST /v1/images/generations` returns a `usage` block.** Until confirmed, every OpenAI cost row ships `confidence: "estimated"` and the Usage screen marks it `~`. Closed by the same probe, **`M2-15`**.
- **Exact maximum reference-image count for OpenAI image edits**, and whether it differs between Sunburst, Flare and GPT Image 2. We declare 4. Closed by **`M2-15`** (same live session).
- **Whether Gemini exposes any multi-image-per-call parameter.** If it does, the fan-out in §6.5 step 5 becomes a cost optimisation rather than a necessity. Closed by **`M0-07`** (Google Gemini image adapter).
- **Output-token counts per (quality × size) for OpenAI.** Must be measured before launch; until then the Generate button shows a range. Closed by **`M3-11`** (cost engine: price snapshots, estimate, reconciliation, usage log).
- **Higgsfield public API reach** — real endpoint paths beyond Soul v2 standard, the style-id catalogue, rate limits, and whether any documented cost endpoint exists. None of it was observable in the UI walkthrough (the observed traffic was the product's private endpoints, which we do not build against, §1.11). Closed by **`M3-16`**, which builds the adapter and verifies these facts with the owner's real key; if it does not resolve, the adapter ships `meta.stable: false` behind Settings → Experimental and nothing else changes.
- ~~Whether to allow a user-supplied provider `baseUrl` override in v1.~~ **Closed at `M0-05`: deferred to the v1.1 OpenAI-compatible provider.** No launch adapter reads a custom address, and honouring one would widen the host allow-list (§0.6), so `PATCH /api/providers/:id` takes only `enabled` and `concurrencyCap`, and `providers.base_url` stays unused until then. A company with `enabled = false` makes no outbound call: new runs are refused, queued runs wait, and its models count as not ready.
- **Price-refresh feasibility** — whether any launch provider exposes a machine-readable price document worth wiring `refreshPricing()` to, or whether the `~/.openfield/prices.json` overlay is the whole story for v1. Closed by **`M3-11`**.

---
## 7. Canvas

This section owns the node graph, the port system, the run engine's semantics and the canvas document format. Every shared contract it touches is §0's: job states and the runner's rules (§0.4), error codes (§0.5), the HTTP and SSE surface (§0.6), mask polarity (§0.9), the thumbnail ladder (§0.10), fingerprints and seeds (§0.11), concurrency, priority and cancellation defaults (§0.12), cost accounting (§0.13) and the v1 scope list (§0.14). Where §0 owns a contract, this section references it and states no numbers of its own.

### 7.1 Purpose and scope

Canvas is Openfield's second workspace: an infinite node graph where **references, prompts and generators compose into repeatable workflows**. Where the Image tab (feed §2, composer §3) is a single prompt bar over a feed — one prompt, one run, one row of results — Canvas is the place where a user wires an upload into a generator, a generator into an edit, and then re-runs the whole thing with a different reference or a different model.

Canvas is not a parallel universe. Every node run produces the **same job sets, jobs and assets as the composer** (§8): the same queue, the same `~/.openfield` files, the same SQLite rows, the same detail view on click-through. **Canvas runs appear in the Image tab feed and the Assets library like any other run** — that is a decision, not an option. A canvas-produced asset carries `assets.op_params.source = "canvas:<canvasId>:<nodeId>"` (§0.2) and shows an "Open in Canvas" action in the detail view (§4); conversely, any asset in the library can be pulled into a canvas through the Assets node. Canvas outputs are additionally auto-filed into a library folder named after the canvas — this gives us the practical behaviour the reference product gets from backing a canvas with the same entity as an asset folder, without conflating the two entities in our schema.

v1 is **image-only** (§0.14), but every part of the spec below — port types, node type ids, result shape, run plan — is modality-agnostic, so video and audio nodes drop in without a schema migration.

### 7.2 Library choice: React Flow

**We build on React Flow (`@xyflow/react`), MIT licensed.**

Justification:

- **MIT** — compatible with our MIT release; no copyleft contamination (unlike ComfyUI's GPL).
- **It is what the reference product uses.** The observed canvas DOM carries `react-flow__node`, `react-flow__handle` and `react-flow__edge` class names, so our node/handle/edge geometry, selection outlines, bezier edges, pane panning and resize handles land on parity behaviour for free rather than being reverse-engineered.
- **Headless and controlled.** Nodes and edges are our state; React Flow renders and hit-tests. Custom node types are plain React components, so our nodes are ordinary shadcn/Tailwind UI, not a bespoke canvas renderer.
- **The primitives we need already exist:** `Background` (dots variant), `MiniMap`, `NodeResizer`, `isValidConnection`, `onConnectEnd` (needed for drop-on-empty-canvas), `reconnectEdge`, `onlyRenderVisibleElements` culling, parent/child nodes with `extent: 'parent'` (needed for Frames), box selection, and `fitView`/`fitBounds`.

**What we build on top** (the actual work of this section):

| Layer | What it is |
|---|---|
| Typed port system | A port type table, a compatibility matrix, `isValidConnection` bound to it, drag-time port highlighting, and the compatibility-filtered add-node menu on drop-to-empty. |
| Node chrome | A shared `<NodeShell>` (label above frame, port rails, body, footer strip, run pill, state overlay, collapse) so every node in the catalogue looks and behaves identically. |
| Run engine | DAG compilation, fingerprint-based dirty tracking and caching, fan-out, cost preview, and the compiled run plan the server executes (7.7). |
| Document layer | JSON schema (`canvasDocumentSchema`, zod, in `packages/core/src/canvas/`), autosave, undo/redo command stack, version history, import/export, templates. |

React Flow is a rendering and interaction library; it has no opinion about any of the four rows above.

### 7.3 Canvas index (`/canvas`)

The landing page for the workspace, mirroring the observed index layout.

**Header.** Page title, our own one-line subtitle, and on the right: a search field (icon that expands to an input, filters by name), a sort menu (*Last edited* — default, *Name*, *Created*), and the tab row.

**Tabs.** `All canvases` · `Templates`.

**Grid.** 4 columns at ≥1280px, 3 at ≥1024px, 2 at ≥768px, 18px gap (same rhythm as the library grid, §2.8).

- **First cell is always "New canvas"**: a dashed card with a `+` circle. Click → `POST /api/canvases` (§8.3) → navigate to `/canvas/{id}` with the name `Untitled`.
- **Canvas card**: 16:9 preview (radius 12), name (14px/500, single line, ellipsis), meta line `Edited 10m ago`: relative time under 7 days, then the date in the person's locale (e.g. `Jul 23, 2026`, §2.12).
- **Card hover / right-click → `⋯` menu**: Open · Rename (inline edit on the card) · Duplicate · Export… · Version history · Delete. Delete is destructive-styled and opens a confirm dialog that echoes the canvas name; it removes the `canvases` row and its `canvas_versions` but **never** the assets it produced (those stay in the library).
- Double-click opens.

**Preview capture (M4-15).** On save, if the graph bounds changed materially and ≥60 s have passed, capture the preview by temporarily mounting a **second, off-screen `<ReactFlow>` instance** with `onlyRenderVisibleElements={false}` and the LOD bucket forced to full detail (7.10), fitted to the graph bounds, then rasterise it with `html-to-image` (MIT). **Graphs above 150 nodes skip the render entirely** and fall straight through to the fallback chain: newest result image in the graph → generated dot-grid placeholder showing the node count. The result is written to `canvases/previews/<id>.png` and recorded on `canvases.preview_path` (§8.2) — an **internal file, never an `assets` row**, which is what keeps previews out of the user's library.

**Templates tab.** Same grid, each card badged `Template`, primary action *Use template* (duplicates the template document into a new canvas and opens it). v1 ships **four** image-only starter templates, written by us, not copied, and bundled as `apps/server/seed/templates/*.ofcanvas.json`: **From a reference** · **Image edit** · **Storyboard (4 panels)** · **Compare styles** (M4-14; §8.8 row 43). An *Upscale pass* template is deliberately absent — the Upscale node is latent in v1 (7.5, §0.14) and such a template would open `blocked`. Templates are ordinary exported canvas documents, no special format, so a user can drop their own file into `~/.openfield/canvases/templates/` (or import it and hit *Save as template*, 7.8).

**Empty state.** Illustration + "No canvases yet" + the two primary paths (*New canvas*, *Start from a template*).

### 7.4 Editor chrome (`/canvas/{id}`)

**Top bar.** Left: Openfield mark with a chevron menu (Back to canvases, Back to Create, Settings) followed by a name pill `Untitled ⌄`; the pill's menu is **Version history · Rename · Duplicate · Export… · Delete**. The name is also editable by double-clicking the pill. Right: a save-state chip (`Saved` / `Saving…` / `Offline. Retrying…`) and the run controls (`Run all`, and `Stop` while anything is in flight). No avatar, no bell, no Share, no Chat — single user, no auth, no telemetry.

**The pane.** Infinite canvas on `var(--of-surface)`, dotted background (`<Background variant="dots" gap={24} size={1} />`) drawn in `var(--of-border)`. **Every colour in this section is a §2.2 `--of-` token; no raw hex or rgba literal appears anywhere in §7** (§0.1). Node surfaces are `var(--of-elevated)` with a `1px solid var(--of-border)` frame; selection, active ports and the run pill use `var(--of-accent)` on `var(--of-accent-fg)`. The reference product's lime accent is not reproduced.

- Pan: two-finger scroll, space-drag, middle-drag, or the Pan tool (`H`).
- Zoom: pinch, `⌘`+scroll, or the zoom cluster. Range **10%–400%**.

**Zoom cluster (bottom-left).** `[ − ] [ 100% ⌄ ] [ + ] | [ Fit ] | [ Minimap ]`

- The percentage button opens a menu with **25 / 50 / 75 / 100 / 150 / 200%** (observed), plus *Zoom to fit* (`⇧1`) and *Zoom to selection* (`⇧2`).
- *Fit* runs `fitView({ padding: 0.15 })`.
- *Minimap* toggles a 180×120 `<MiniMap/>` sitting directly above the cluster; nodes are tinted by category (reference / generate / edit / utility) from the accent ramp, the viewport rectangle is draggable, and a click jumps. The toggle state persists in `ui_state`.

**Out-of-view helper.** When no node bounding box has intersected the viewport for >400 ms, a pill fades in at the top centre of the pane: **"Nothing in view"** with a **"Back to nodes"** button that runs fit-view (our copy; the behaviour is the observed one). Separately, when a run finishes on a node outside the viewport, a toast appears: *"Image Generator finished"* + *Jump to node*.

**Bottom-centre toolbar.** A floating rounded bar of 36px icon buttons on `var(--of-elevated-2)`, grouped with `var(--of-border)` hairline dividers, each with a tooltip showing its label and shortcut:

| Group | Tools (v1) |
|---|---|
| Navigation | **Select `V`** · **Pan `H`** (or hold Space) |
| Annotate | **Note `N`** · **Shape `R`** · **Text `T`** |
| Structure | **Frame `F`** |
| Find / add | **Find `⌘F`** · **Add node `A`** (the `+` button) |

Slots observed in the reference toolbar that v1 deliberately leaves empty: **Draw**, **Reaction**, **Comment**, **Page**, and **Table** (deferred with the Table node, §0.14). They are registered in the toolbar's tool manifest but hidden behind feature flags (`canvas.tools.draw`, `.comments`, `.table`, …) so adding one later is a manifest entry, not a layout change. Nothing ships visibly disabled.

**Find (`⌘F`).** An input in the top-right of the pane; matches node titles, prompt text and model names; `↵` / `⇧↵` cycle matches, each match is ringed and centred (`fitBounds` on that node at current zoom, never zooming past 100%).

**Add-node menu.** Opened by the `+` tool, by `A`, or by double-clicking empty canvas. A 320px panel anchored at the insertion point: autofocused fuzzy search over name/description/keywords, then a grouped list. Rows are a 24px icon tile + name (14px) + description (12px in `var(--of-text-secondary)`). `↑↓` navigate, `↵` inserts at the anchor, `Esc` closes. Groups follow the observed catalogue shape:

- **Quick** — a fixed starter set (Prompt, Image Generator, Upload, Assets, Preset, Note), reordered by recent use once the user has run nodes. The reference product's Quick group is a fixed curated list; MRU ordering is ours.
- **References** — Upload, Assets.
- **Image** — Image Generator, Edit image, Variations, Upscale *(latent — only listed when an adapter advertises `ops.upscale`; see 7.5)*, Preset.
- **Utilities** — Prompt, Note, Frame.
- **Video / Audio** — not rendered in v1. The group, and the deferred **AI text** and **Table** rows, are registered in the catalogue manifest but hidden until they ship (§0.14, §0.15: nothing unshipped is teased in the UI).

### 7.5 Node catalogue (v1)

**Common node anatomy** (the shared `<NodeShell>`):

- **Label above the frame** — 12px/500 in `var(--of-text-secondary)`, editable on double-click (defaults to the node type name; a renamed node keeps its custom title in `title`).
- **Selection** — 2px `var(--of-accent)` outline; resizable via 4 corner handles (`NodeResizer`) on nodes that declare `resizable`.
- **Port rails** — inputs on the left edge, outputs on the right edge, as **24px circular icon buttons** evenly distributed vertically (observed). Hovering a port shows a tooltip with the port's name and type (e.g. `Reference images ×n`).
- **Annotation handles** — every node additionally exposes four non-data handles (top/right/bottom/left) used only for **annotation arrows**: dashed edges with no type that are excluded from the DAG and from execution. This mirrors the `arrow-source-*` / `arrow-target-*` handles observed on the reference Prompt node.
- **Body** — the node's result or editor area.
- **Footer strip** — inline controls + model chip + **run pill** showing the estimated cost (e.g. `~$0.13`), which both runs the node and is the node's primary affordance. Chips are resolved by the one `resolveControl()` rule in §0.3 from the model's manifest, in `controlOrder` — the node footer and the composer never disagree about a control.
- **Collapse** — an icon at the bottom-right collapses the node to a 56px-tall header with a thumbnail strip; collapsed state is persisted.

**Default geometry** (observed, adopted for parity): Image Generator **300×300**, min 240×240. Prompt node **296×151**, min 240×96.

#### Catalogue

| Node (`type`) | Inputs | Outputs | Inline controls | Runs? |
|---|---|---|---|---|
| **Prompt** `prompt` | `text` (optional, prepended) | `text` | Textarea ("Write your prompt"), char count, `{{variable}}` chips (§0.8) resolved from a connected Table *(v1.1)* | No |
| **Upload** `image.upload` | — | `image ×n` | Drop zone / file picker (`.jpg .jpeg .png .webp .heic`, §0.6), thumbnail strip, reorder, remove | No |
| **Assets** `image.asset` | — | `image ×n` | *Choose…* opens the library picker; or *Folder mode* (all images in folder X, newest-first, capped by a `limit` field, re-resolved at run time) | No |
| **Image Generator** `image.generate` | `prompt` (`text`), `input_images` (`image ×n`), `preset` (`preset`) | `image ×n` | Inline prompt field, model chip, and the manifest-resolved chip row (§0.3): aspect/size, quality or resolution, batch stepper (max `batch.max`, 4 in v1 — §0.10), seed (core, disabled with a reason when `seed.supported: false`), per-model extras | **Yes** |
| **Edit image** `image.edit` | `image` (required), `mask` (optional), `instruction` (`text`) | `image ×n` | *Edit mask…* (opens the mask editor), instruction field, model chip, strength (when the model exposes `styleStrength`), batch stepper | **Yes** (M4-19) |
| **Upscale** `image.upscale` | `image ×n` | `image ×n` | Scale factor (`×2 ×4`, clamped by the manifest), model chip, provider-specific extras | **Latent — v1.1** |
| **Variations** `image.variations` | `image` and/or `prompt` | `image ×n` | Count (2–8), strategy (*Same prompt* / *Prompt list* / *Model list*), the varying axis' list editor | **Yes** (M4-21) |
| **Preset** `preset` | — | `preset` | Preset picker (library §5), inline preview of prompt template + reference thumbnails, *Edit a copy* | No (M4-20) |
| **Note** `note` | — | — | Sticky text, 6 tint choices from the accent ramp, resizable | No |
| **Frame** `frame` | — | — | Title, background tint, collapse; children attach via `parentId` + `extent: 'parent'` | No |
| **AI text** `text.llm` | `text ×n` | `text` | System/user template with `{{input}}` placeholders, text-model chip, streamed output preview, token cost | **v1.1** (§0.14) |
| **Table** `table` | — | `text ×n` (one row per record, as named variables) | Spreadsheet-style grid; first row = variable names; rows fan out (7.7) | **v1.1** (§0.14) |

Node-specific notes:

- **Image Generator** is the centre of gravity and is capability-driven exactly like the composer: the chips shown are derived from the selected model's manifest (§6.3, resolved by §0.3), so a model with no background control simply has no background chip, and a model with `references.supported: false` disables the `input_images` port (greyed, tooltip "This model doesn't take reference images") and marks any attached edge invalid-but-preserved.
- **Edit image** — when the chosen model declares `ops.inpaint: false` (instruction-only editing), the `mask` port and the mask editor are hidden and the node degrades to instruction editing, with a one-line explainer in the footer; where core's regional fallback applies, the result carries the **Approximate** badge (§0.9). The **mask editor** is a modal over the node: brush, eraser, rectangle and lasso select, invert, feather (0–32px), zoom cluster, and an opacity slider over the base image. **Masks are stored as RGBA PNG alpha assets at the base image's exact pixel size (§0.9) and referenced by id**: committing a mask uploads it once via `POST /api/masks` and the run carries only its id, so a mask is reusable, survives reloads and never crosses the provider interface as base64. On the wire that id is `mask: { assetId, invert?, featherPx? }` inside §6.5's `GenerateRequest` (§0.6) — `maskAssetId` is the shorthand this section uses for that field, never a flat request property.
- **Upscale — the open substitute, latent at launch.** The reference product's upscale is a third-party integration we cannot use. Ours is a **capability slot**: the node is listed only when at least one installed adapter advertises `ops.upscale`. **No launch adapter does (§0.14), so v1 ships the node latent and it is out of M4's definition of done.** The model-native high-resolution tiers cover the common case, and the detail editor ships local Lanczos resample labelled *"Resizes, adds no detail."* (§0.14 row 4). v1.1's fal.ai/Replicate adapters light the node up automatically, and the **command plugin slot** — a user-configured executable that receives an input path and writes an output path, letting anyone wire a local ESRGAN/Topaz CLI without us shipping it — lands with them.
- **Preset — our own style recipes.** The reference product's style catalogue and moodboards are proprietary; our Preset node emits a `preset` value from the user's own library (§5). The payload is the §5.3 object (§0.8): a prompt template whose `{prompt}` slot appears exactly once, optional reference images, and parameter overrides. **Merge precedence:** node defaults < preset overrides < fields the user has explicitly touched on the node. Each field the preset currently controls shows a small lock glyph in the node footer, clickable to take manual control (M4-20).
- **AI text** and **Table** are **v1.1** (§0.14): a runnable LLM node would make a text-model key a *canvas* dependency, which the locked image-only v1 scope refuses. **The fan-out mechanism they would have used stays in v1** — Variations needs it (7.7).

#### Node states

Every runnable node renders exactly one of these states; the state is drawn as a band across the node body plus a dot on the label. Job states themselves are §0.4's — the bands below are this surface's rendering of them, never a second enum.

| State | Rendering | Actions |
|---|---|---|
| `idle` | Neutral; run pill shows the estimated cost | Run |
| `queued` | `var(--of-accent-soft)` shimmer band + "Queued · 2nd in line" | Cancel |
| `running` | Progress bar (determinate when the adapter reports progress, otherwise indeterminate) + elapsed timer; `job.partial` frames (§0.6) render as streamed previews where the model supports them | Cancel |
| `done` | Result rendered in the body; chips over the preview show quality, aspect and `×N` batch. The asset is already in the library — there is nothing to "send" | Open · Re-run · Download |
| `cached` | Result rendered plus a muted `Reused` chip; the node was skipped during the last run | Re-run anyway; `⌥`-click run bypasses the cache |
| `stale` | Dot on the label in `var(--of-accent)`, result dimmed to 60%, chip "Inputs changed", or "Made with older settings" for a late arrival (7.7) | Re-run · Re-run from here |
| `failed` | `var(--of-danger-soft)` band with the §0.5 failure copy for the job's `ErrorCode`, truncated to 2 lines and expandable | The §0.5 primary action for that code · Copy error · Error log |
| `canceled` | Neutral `var(--of-elevated-2)` band reading **"Canceled. You may still be charged for work that already started."** (§0.12) | Run |
| `blocked` | Hatched `var(--of-border-strong)` band naming the blocker: missing API key, model unavailable with current keys, required input not connected, or an upstream node failed | The fix action for that blocker |

Result rendering: one image fills the body with `object-fit: contain`; 2–4 results render as a 2×2 grid; >4 render a 2-row scrolling strip with a `×N` chip. Clicking a result opens the same detail view the feed uses (§4), with its lineage pointing back at this node.

### 7.6 Typed ports and connection rules

**Port types.** `text`, `image`, `mask`, `preset`. Reserved for later modalities and already accepted by the schema validator: `video`, `audio`.

**Arity.** Each port declares `single` or `multi`. A `multi` input accepts N edges and presents them to the node as an ordered array; the order is the connection order and is drag-reorderable in the node's inline thumbnail strip (this is how `input_images` behaves). A `single` input accepts one edge; connecting a second replaces the first (with an undoable toast: "Replaced connection · Undo").

**Compatibility matrix.**

| From ↓ / To → | `text` | `image` | `mask` | `preset` |
|---|---|---|---|---|
| `text` | ✅ | ❌ | ❌ | ❌ |
| `image` | ❌ | ✅ | ⚠️ coerced | ❌ |
| `mask` | ❌ | ✅ | ✅ | ❌ |
| `preset` | ❌ | ❌ | ❌ | ✅ |

⚠️ `image → mask` is allowed with an explicit coercion: **luminance → alpha, white = alpha 0 = edit region** (§0.9 — alpha 0 is what the model regenerates). The edge renders with a small coercion glyph at its midpoint and the target port tooltip states the rule. A coerced mask is committed like any other: uploaded via `POST /api/masks` and passed as `maskAssetId`. Everything else is rejected.

**Drag-to-connect.**

1. Pressing on a port starts a pending edge drawn as a **dashed curve** following the cursor (observed).
2. While a drag is in flight, every **compatible** port in the graph brightens to full opacity and gains a 2px `var(--of-accent)` ring; **incompatible** ports drop to 35% opacity and refuse hover. This is the primary invalid-connection feedback — users mostly never see an error.
3. Dropping on a compatible port connects. Dropping on an incompatible port snaps the edge away and shows a 2.5 s toast naming both sides: *"Text can't go into an image input on Image Generator."*
4. Connections that would create a **cycle** are rejected at drop time with *"That would create a loop."* (Kahn's algorithm run on the prospective graph.)
5. `isValidConnection` enforces all of the above; nothing relies on post-hoc cleanup.

**Drop on empty canvas.** Releasing a pending edge over empty pane opens the add-node menu **at the drop point**, filtered by compatibility — matching the observed behaviour (from an image output the reference product offers the image-consuming generators first, then an "Other" group). Our menu renders:

- **Connects to this** — nodes with at least one port that accepts the dragged type. Ordered by catalogue order.
- **Other** — the rest of the catalogue; picking one inserts the node **unconnected**.
- Search field on top, same keyboard model as the normal add-node menu.

Choosing a node creates it positioned so that its accepting port lands at the drop point, and the edge is committed. `Esc` or clicking away cancels both node and edge.

**Edges.** Thin bezier curves in `var(--of-border-strong)`; 1.5px default, 2.5px + `var(--of-accent)` on hover, 2.5px + accent + endpoint dots when selected.

- Click selects; `⌫`/`Delete` deletes; `⇧`-click multi-selects edges.
- Hovering an edge reveals a 16px `×` button at its midpoint (`EdgeLabelRenderer`).
- Either endpoint can be dragged to a new port (`reconnectEdge`), subject to the same validity rules; dropping a reconnect on empty pane deletes the edge.
- Right-click → Delete · (v1.1: *Insert node here*).
- Annotation arrows are visually distinct (dashed, arrowhead, muted) and are never selectable as data edges.

### 7.7 Execution engine

**Where the engine runs.** The DAG compiler, fingerprinting and dirty propagation run in the browser (they are pure over the document). Scheduling and execution run in the server: the client POSTs a compiled run plan and the server owns ordering, concurrency, retry and crash recovery. The run is `POST /api/canvases/:id/run` and `POST /api/canvases/:id/runs/:runId/cancel` (§0.6, §8.3); `canvas_runs` (§8.2) persists it so a run survives a reload, and progress arrives on the single `GET /api/events` stream as `canvas_run.updated` plus the ordinary `job.*` frames (§0.6).

**Compilation.** The document is compiled to a DAG on every structural change: runnable nodes become tasks, data edges become dependencies, annotation edges are dropped. Cycles are impossible by construction (rejected at connect time), but the compiler re-checks and refuses to submit an invalid graph.

**Run scopes.** Each maps to one `scope` value in the run request.

| Scope | `scope` | Trigger | Behaviour |
|---|---|---|---|
| Run this node | `node` | Node run pill, `⌘⏎` | Runs one node. If upstream nodes are stale or have never run, a popover offers *"3 earlier nodes need to run first"* → **Run them too** / **Cancel**. |
| Run from here | `downstream` | `⇧⌘⏎`, node `⋯` menu | Runs this node plus every node reachable from it. |
| Run all | `all` | Top-bar *Run all*, `⌥⌘⏎` | Runs every runnable node in topological order. |
| Run selection | `selection` | Multi-select context toolbar | Runs the selected nodes plus whatever upstream is needed to satisfy them. |

**Dirty tracking and caching (M4-16).** Each node computes the **fingerprint defined once in §0.11** — the same hash function the composer uses for `paramsHash`, over `typeId`, `typeVersion`, normalized params, `modelKey`, `manifestVersion` and the upstream fingerprints in port order. A node is `cached`, and is returned in the run response's `skipped[]`, when `fingerprint === result.fingerprint` and every referenced asset still exists. Any change to params, model or an upstream fingerprint marks the node `stale` and propagates staleness transitively downstream (visually: the stale dots cascade immediately, before any run). `⌥`-click on a run pill bypasses the cache.

A result carries the fingerprint it was submitted with. On arrival the runner compares it to the node's current fingerprint: on a match the node goes `done`; on a mismatch the asset is still filed in the library and the node renders `stale` with the chip "Made with older settings · Open · Re-run". Undo and redo never cancel an in-flight run; a node with a run in flight refuses reparenting and deletion (the op is rejected with the toast "Wait for this node to finish, or cancel it").

**Seeds.** The seed control offers `Random`, `Fixed` (with the value, and a *Use last seed* action after a run) and `From input`; **`Fixed` and `From input` are offered only when `capabilities.seed.supported`** (§0.11). On models without seeds — which is every launch model (§6.13, §6.14) — the node **always caches on unchanged inputs** and the run pill reads *"Each run gives a new result."*

**Fan-out (M4-17).** An output carrying *k* items feeding a `single`-arity input produces an implicit **map**: the downstream node runs *k* times, once per item. The node displays a `×k` badge, its body becomes a labelled result grid, and its cost estimate is multiplied by *k*. Three uses:

- **Batch compare**: a generator with `batch: 4` feeding an Edit node runs the edit four times.
- **Multi-model compare**: the Variations node's `Model list` strategy emits one run per model; results render in a labelled grid with the model name under each tile.
- **Table fan-out** *(v1.1, with the Table node)*: a Table with *r* rows feeding prompt variables produces *r* runs, each with that row's substitutions; the result grid is labelled by the row's first column.

A safety rail: any single run whose fan-out exceeds **32 jobs** requires explicit confirmation regardless of cost.

**Concurrency and priority.** Canvas runs enqueue job sets into the **same queue as the composer** — one queue, one set of provider connections, one usage log. Defaults: `globalConcurrency = 4` (§8.4.2), further clamped per provider by `min(providers.concurrency_cap, capabilities.limits.maxConcurrent)`. Scheduling is `job_sets.priority DESC, job_sets.created_at, jobs.idx` with round-robin across providers: composer runs and single-node canvas runs enqueue at priority **10**, run-downstream and run-all at **5**, so a 30-node batch cannot starve a user who just hit Generate. The numbers live in §8.4.2 and §0.12; this section states none of its own. Queued nodes display their position.

**Cancellation.** The node's `×` cancels that node's job set (§8.3); the top bar's *Stop* cancels the whole run via `POST /api/canvases/:id/runs/:runId/cancel`. Nodes not yet started go `canceled` synchronously, nothing spent. **Neither launch adapter implements provider-side cancel (§6.13, §6.14), so canceling a run already sent aborts our fetch only: the provider may complete and bill the work, and no asset is produced.** The usage log records it at full estimate with `discarded = 1`, and the node's `canceled` band reads *"Canceled. You may still be charged for work that already started."* (§0.12, §0.13.)

**Cost preview (M4-18).** Every run pill shows the estimated cost for that node at its current settings, computed locally from the manifest by the pure `estimate(manifest, req)` function (§0.13) — no round-trip per stepper click. Any multi-node run first opens a confirmation popover, populated by the same run request with `dryRun: true` (which returns `estimate` and `skipped[]` without enqueuing anything):

```
Run all: 5 nodes, 8 images
  Image Generator (Nano Banana Pro, 2K ×4)     ~$0.54
  Edit image (GPT Image ×4)                    ~$0.18–0.31
  2 nodes reused                                Free
  1 node                                        Cost unknown
  ──────────────────────────────────────────
  Total  About $0.72–0.85            [ Cancel ]  [ Run ]
```

Estimates come from the manifest's pricing snapshot (§6, §0.13), always carry `pricedAt`, and are always rendered as estimates — a range for token-priced models and an explicit "Cost unknown" row where a provider publishes no rate. Runs whose estimate exceeds the spend-confirmation threshold (Settings → Spending, §6.17) always require this confirmation, even for a single node. Actual costs, once known, are reconciled into `usage_log` with the canvas and node ids attached (§0.13).

### 7.8 Persistence

**Document format.** One JSON document per canvas, validated by `canvasDocumentSchema` (zod, `packages/core/src/canvas/schema.ts`), the single source of truth. The browser validates with it on edit, import and save. The server validates `PATCH /api/canvases/:id` bodies and the bundled templates with the same schema (§0.16). It also generates the catalogue manifest used by the agent extension point in 7.11. Document migrations for `canvases.schema_version` bumps (§8.2) live beside it in `packages/core/src/canvas/migrations/`.

```jsonc
{
  "schema": "openfield.canvas/1",
  "id": "01JB8Z…",                          // ULID (§0.2)
  "name": "Untitled",
  "createdAt": "2026-09-23T09:12:04.118Z",
  "updatedAt": "2026-09-23T09:41:55.002Z",
  "viewport": { "x": -320, "y": -140, "zoom": 0.75 },
  "nodes": [
    {
      "id": "n_gen_1",                       // document-local, stable across saves
      "type": "image.generate",
      "typeVersion": 1,
      "position": { "x": 480, "y": 120 },
      "size": { "w": 300, "h": 300 },
      "parentId": "n_frame_1",               // Frame membership, null at top level
      "collapsed": false,
      "title": null,                         // null = use the type's default label
      "params": {
        "model": "google:gemini-3-pro-image", // ModelKey, colon-separated (§0.2)
        "prompt": "",
        "size": { "kind": "aspect", "ratio": "3:4" },
        "resolution": "2K",
        "batch": 4,                          // ≤ capabilities.batch.max, 4 in v1 (§0.10)
        "seed": { "mode": "random" },        // pinned/from-input only when seed.supported (§0.11)
        "enhancePrompt": false,
        "providerOptions": {}                // opaque, validated by the adapter
      },
      "presetLocks": ["size"],               // fields currently driven by a Preset input
      "result": {
        "state": "done",
        "assetIds": ["01JB…", "01JB…"],
        "jobSetId": "01JB…",                 // same entity as a composer run (§8.2)
        "fingerprint": "sha256:9f2c…",       // §0.11
        "costUsd": 0.536,
        "ranAt": "2026-09-23T09:40:12.660Z"
      }
    }
  ],
  "edges": [
    { "id": "e_1", "source": "n_prompt_1", "sourceHandle": "text",
      "target": "n_gen_1", "targetHandle": "prompt", "order": 0, "kind": "data" },
    { "id": "e_2", "source": "n_note_1", "sourceHandle": "arrow-source-right",
      "target": "n_gen_1", "targetHandle": "arrow-target-left", "kind": "annotation" }
  ],
  "comments": [],                            // reserved; see 7.11
  "meta": { "appVersion": "0.1.0", "previewPath": "canvases/previews/01JB8Z….png" }
}
```

`meta.previewPath` is an internal file relative to `OPENFIELD_HOME` (§0.2, §0.7), **not an asset id** — previews never enter the user's library.

**Storage.** The document of record is the `graph` JSON column of the **`canvases`** row, with snapshots in **`canvas_versions`** and the card image at `preview_path`; §8.2's Drizzle schema owns both tables and this section restates none of it. A Settings toggle additionally write-throughs each save to `~/.openfield/canvases/{id}.json`, so a user can keep their graphs in git.

**Autosave.** Local state is the source of truth while editing; mutations flow through a single `applyOp(doc, op)` reducer. Saves are **debounced 800 ms** after the last mutation, force-flushed every 10 s while dirty, and flushed on blur, route change and `beforeunload`. The request is `PATCH /api/canvases/:id` (§8.3) carrying the full document plus `graphVersion`; if the server's version has moved (two browser tabs on the same canvas), the save is rejected with `conflict` (§0.5) and the editor shows a non-destructive banner — *"This canvas changed in another tab"* — with **Reload** / **Keep mine**. The save-state chip in the top bar always reflects reality (`Saved` / `Saving…` / `Offline. Retrying…`, with exponential backoff).

**Undo/redo.** Client-side command stack, **100 entries**, `⌘Z` / `⇧⌘Z`. Continuous gestures coalesce: a drag is one entry, a burst of typing coalesces on a 500 ms idle. Undo covers add/delete/move/resize/collapse, param changes, edge add/delete/reconnect, paste, group/ungroup, and template application. Undo **does not** un-generate: undoing a run clears the node's `result` pointer, but the asset it produced stays in the library (it was paid for and may be referenced elsewhere). Redo re-attaches the same asset ids without re-running. Undo and redo never cancel an in-flight run, and a node with a run in flight refuses reparenting and deletion — the full rule is in 7.7.

**Version history.** Snapshots are taken (a) every 5 minutes in which the document changed, (b) on an explicit *Save version* (`⇧⌘S`, prompts for a name), and (c) immediately before any destructive bulk operation — import, template apply, or a delete of >5 nodes. The history drawer lists snapshot time, name, node/edge count and a preview; each row offers **Preview** (loads the snapshot read-only into the pane with an exit bar) and **Restore** (which itself first snapshots the current state, so restoring is never lossy). Retention: the last 50 automatic snapshots plus every named one.

**Import / export.**

- **Export canvas** → `{name}.ofcanvas.json` — the document above, with `result.assetIds` preserved.
- **Export canvas + images** → `{name}.ofcanvas.zip` — `canvas.json`, `assets/{id}.{ext}`, and a `manifest.json` listing asset hashes, so the file is portable between machines.
- **Import** validates against `canvasDocumentSchema`, rejects with a precise message on failure (`Node 3: image count must be 1–4`), remaps all ids, and **reconciles models**: if a node references a model that isn't available with the user's current keys, it imports in the `blocked` state with a *"Pick another model"* action whose picker is filtered to models satisfying that node's required capabilities (§0.3). Missing assets import as placeholders that keep the graph runnable.
- **Save as template** writes the same file to `~/.openfield/canvases/templates/<id>.ofcanvas.json` and adds it to the Templates tab. The tab lists user templates beside the four bundled ones in `apps/server/seed/templates/`.

### 7.9 Selection and manipulation

- Click selects; `⇧`-click adds/removes; dragging on empty pane with the Select tool draws a box selection; `⌘A` selects all; `Esc` clears.
- A **floating context toolbar** appears above a multi-selection's bounding box: Align (left / centre / right / top / middle / bottom) · Distribute (horizontal / vertical) · Group into frame · Duplicate · Run selection · Delete.
- **Group into frame** (`⌘G`) creates a Frame sized to the selection + 32px padding and re-parents the selected nodes (`parentId`, `extent: 'parent'`); dragging the frame moves its children; `⇧⌘G` ungroups. Dragging a node onto a frame joins it; dragging it out detaches it.
- **Copy/paste** (`⌘C` / `⌘X` / `⌘V`) writes the selected sub-graph (nodes + internal edges, `result` stripped) to the clipboard as `application/json` with a `text/plain` fallback carrying the same JSON — so paste works **across canvases and across browser windows**, remapping ids and preserving internal edges. Paste lands at the pointer, or offset +24/+24 when pasted into the same canvas at the same position.
- **Duplicate** `⌘D` (offset +24/+24) and `⌥`-drag duplicate-drag.
- **Nudge**: arrows 1px, `⇧`+arrows 10px. **Snapping**: 8px grid, `⌥` to bypass; alignment guides appear when an edge is within 4px of a neighbour's edge or centre.
- **Delete** `⌫`/`Delete` removes selected nodes and edges; deleting a node deletes its incident edges; deleting a Frame offers *Delete frame only* vs *Delete frame and contents*. A node with a run in flight is not deletable (7.7).

**Keyboard shortcuts.** §2.6 publishes the one global shortcut table; the list below adds only this surface's own bindings. `R` is **Shape**, matching the observed canvas toolbar (§0.9).

| Key | Action | Key | Action |
|---|---|---|---|
| `V` / `H` | Select / Pan (hold Space to pan) | `⌘⏎` | Run selected node |
| `N` / `R` / `T` / `F` | Note / Shape / Text / Frame | `⇧⌘⏎` | Run from here |
| `A` | Add node | `⌥⌘⏎` | Run all |
| `⌘F` | Find in canvas | `Esc` | Close menu / clear selection |
| `⌘Z` / `⇧⌘Z` | Undo / Redo | `⇧1` / `⇧2` | Zoom to fit / to selection |
| `⌘C` `⌘X` `⌘V` `⌘D` | Copy / Cut / Paste / Duplicate | `⌘0` | Zoom 100% |
| `⌘A` | Select all | `⌘+` / `⌘-` | Zoom in / out |
| `⌘G` / `⇧⌘G` | Group into frame / Ungroup | `⌘S` | Save |
| `⌫` | Delete selection | `⇧⌘S` | Save named version |

A `?` overlay lists these alongside the global table; every toolbar tooltip shows its own shortcut.

### 7.10 Performance targets

| Target | Budget |
|---|---|
| Interactive graph size | **500 nodes / 1000 edges at 60fps** pan, zoom and drag on an M-series laptop |
| Degradation ceiling | 2000 nodes / 4000 edges at ≥30fps, with LOD active |
| Open a 500-node canvas | < **1.5s** from route change to interactive |
| Add-node menu open → first paint | < **100ms** |
| Node drag frame cost | < **8ms** per frame |
| Autosave serialization | < **50ms** for documents up to 2MB (moved to a worker above that) |

How we hit them:

- **Viewport culling** via `onlyRenderVisibleElements`, plus **level of detail**: below 40% zoom, node bodies render as a title + thumbnail card with no inputs, textareas or chips; below 20% zoom, nodes render as flat tinted rectangles with a 1-line title. LOD is driven by a single zoom-bucket value in context so a zoom change re-renders one provider, not every node. **The preview capture in 7.3 is the one place both are switched off**, on a second off-screen instance, which is why it is bounded at 150 nodes.
- **Store shape**: graph topology in a zustand store; **node params in per-node stores** so typing in one prompt field never re-renders the graph. Node components are memoized with explicit equality on `(data.version, selected, dragging, lodBucket)`.
- **Thumbnails**: results render from the local thumbnail cache using the same `@h` ladder as §8.5.2 (200/280/360/456/640 + `@p1440`), always the smallest rung ≥2× the rendered box; full resolution only in the lightbox. `loading="lazy"`, `decoding="async"`, `content-visibility: auto` on node bodies.
- **Edges**: bezier by default; above 300 visible edges we switch to `simplebezier` and disable all edge animation.
- **Run engine off the render path**: compilation, fingerprinting and event handling live outside React state and push updates in batched (≤10Hz) renders. Scheduling and polling are the server's (7.7), so a closed tab does not stop a run.

### 7.11 Out of scope for v1 — and the seams left for it

None of the following ship in v1 (§0.14). Each has a designed-for seam so it is an addition, not a rewrite.

- **Multiplayer cursors and presence.** Every mutation already goes through one `applyOp(doc, op)` reducer with a closed set of op types (`addNode`, `moveNode`, `setParam`, `addEdge`, `deleteEdge`, `reparent`, …). That is the shape a CRDT needs: the v1.1 path is to back the document with a Yjs doc and replay the same ops, changing nothing above the reducer. A `<PresenceLayer/>` renders in the pane as a no-op component today and becomes the cursor/selection overlay later.
- **Per-canvas chat.** The editor's right side is a **drawer host** that takes registered panels; v1 registers *Version history* and *Node settings*. Chat is one more registration.
- **Comments.** The document schema already carries a `comments: []` array whose entries anchor to either a `nodeId` or a viewport point (`{x, y}`), and the toolbar's comment slot exists behind `canvas.tools.comments`. Shipping comments is a panel, a pin renderer and a table — no schema migration.
- **AI text and Table nodes.** Both are listed as v1.1 in the §7.5 catalogue table and hidden from the add-node menu (7.4); the fan-out mechanism they need already ships for Variations.
- **Ask Agent (LLM graph builder).** The extension point is deliberately narrow and safe:

  1. A BYOK text model (the same key store and Settings UI as the prompt enhancer, §6.11/§6.17) receives a system prompt containing **(a)** the canvas JSON Schema (generated from `canvasDocumentSchema` with zod's JSON Schema export), **(b)** the node catalogue manifest — auto-generated from the same zod definitions that validate documents, so it can never drift — and **(c)** the current document with `result` fields elided down to asset ids and captions.
  2. The user's request is sent, and the model must reply with a **graph patch**: a JSON array of the reducer's own domain ops (`[{ "op": "addNode", "node": {…} }, { "op": "addEdge", … }]`), not free-form JSON and not code.
  3. The patch is validated in three passes — zod schema, referential integrity (every `source`/`target` exists, every port type is compatible), and acyclicity — then checked against the installed manifests so it cannot propose a model the user has no key for.
  4. A **diff preview** is shown ("Adds 3 nodes and 4 connections, changes 1 model. Apply / Discard"); applying is a **single undoable transaction**.
  5. The agent **never runs anything**. It may *propose* a run, which surfaces as the ordinary cost-preview confirmation. Its own token spend is written to the usage log like any other provider call.

### 7.12 Acceptance criteria

- Creating a canvas from the index lands on `/canvas/{id}` in under 1s with an empty dotted pane and an autosaved document.
- Dragging from an image output to empty pane opens a node menu whose first group contains only nodes with an image-accepting port; picking one creates the node **and** the edge in a single undo entry.
- Connecting a `text` output to an `image` input is impossible by hover and produces a named toast on drop; connecting a node to its own ancestor is rejected as a loop.
- Changing a generator's prompt marks it and every downstream node `stale` within one frame, with no run triggered.
- Running a graph twice with no changes issues **zero** provider calls the second time and marks every node `cached` — including on the launch models, which declare `seed.supported: false` and therefore cache on unchanged inputs with no seed pinned (§0.11).
- A result that arrives after its node's params changed files its asset in the library and leaves the node `stale` with "Made with older settings" — it never overwrites the newer settings and never silently disappears.
- A canvas run's results appear in the Image tab feed and the Assets library, and the detail view offers "Open in Canvas" back to the originating node.
- *Run all* on a 5-node graph (2 runnable, 2 cached, 1 unpriced) shows a cost-preview popover whose per-node rows sum to the displayed total, with token-priced models shown as a range and unpriced providers shown as "Cost unknown".
- Reloading the browser mid-run does not stop it: the run resumes from `canvas_runs` and the nodes re-attach to their job sets.
- Cancelling mid-run stops queued nodes and keeps every asset already **written to the library**; runs canceled after submit are recorded in the usage log as billed-but-discarded, and the node band says so.
- Exporting a canvas and importing it on a machine with different API keys produces a runnable graph where unavailable models are `blocked` with a substitute picker rather than silently swapped.
- A 500-node canvas pans and zooms at 60fps and opens in under 1.5s; its index card preview shows real nodes, and a 200-node canvas falls back to its newest result image rather than rendering a blank card.
- Reloading the browser mid-edit loses at most 800ms of work.

### 7.13 Open questions

- Inner UI of the reference product's Video, Voice, LLM Assistant, Page, Table, Upload and Assets nodes was not captured — our specs for Upload and Assets (and, at v1.1, Table and AI text) are our own design, not parity.
- The reference version-history UI was not opened; our drawer design is not parity-checked.
- Multi-select, group, align and copy/paste behaviour on the reference canvas was never exercised; no delete/duplicate shortcut was observed. Our shortcut table is ours.
- Whether the reference canvas re-runs nodes automatically when an upstream node changes, or whether it caches unchanged nodes at all, was not observed — our dirty/cached model is a design decision.
- Whether the reference "Frames/Pages" are React Flow parent nodes or decorative rectangles is unknown; we implement them as parents.
- Whether edges can be reconnected, or a node inserted onto an existing edge, in the reference product was not tested.
- What the reference "Page" node is (document? sub-canvas?) is unknown; we ship no equivalent.
- No per-canvas node count limit or performance ceiling was observable; our targets are self-imposed.
- Whether Higgsfield exposes any canvas/graph functionality through its public API is undocumented (the API research notes it as "appears to be UI-only") — so a Higgsfield adapter, if shipped, contributes models to canvas nodes, never a canvas backend.

---
## 8. Data model, local API, queue and delivery plan

This section specifies everything behind the glass: where bytes live on disk, the SQLite schema, the loopback HTTP API the React app talks to, the job queue that drives it, the image pipeline that replaces the reference product's CDN proxy, and the milestone plan that gets us from empty repo to Canvas. UI behaviour is specified in §2 (shell, feed, library), §3 (composer), §4 (detail view & editor), §5 (presets, references, characters, palettes) and §7 (canvas); provider adapters and capability manifests in §6. Where those sections need persistence or an endpoint, it is defined here.

**§0 outranks this section on every shared contract.** The job state machine (§0.4), the operation union (§0.4), the error taxonomy (§0.5), the request body and event list (§0.6), the lineage columns (§0.7), the preset/reference-set/character/palette tables (§0.8), the mask convention (§0.9), the zoom-and-thumbnail ladder (§0.10), the seed pipeline (§0.11), the concurrency and cancellation defaults (§0.12), the cost model (§0.13) and the v1 scope list (§0.14) are stated there and are not restated here. What follows is their persistence, their wire form and their delivery schedule.

---

### 8.1 Storage layout under `~/.openfield`

Everything Openfield owns lives in one directory, referred to internally as `OPENFIELD_HOME` (default `~/.openfield`, overridable by the `OPENFIELD_HOME` env var). Nothing is written outside it except files the user explicitly exports.

```
~/.openfield/
├── config.json                 # 0600 — API keys, server port, home overrides. NEVER in git, NEVER in the db.
├── config.json.bak             # 0600 — previous config, written before each save
├── openfield.db                # SQLite, WAL mode — all metadata, lineage, presets, canvases, usage
├── openfield.db-wal
├── openfield.db-shm
├── assets/                     # canonical, full-resolution originals — date-sharded
│   └── 2026/
│       └── 09/
│           └── 23/
│               ├── 01K6BQ7Y2M8N4P0R.png        # <ulid>.<ext> — generated output
│               └── 01K6BQ8A1C4D7E9F.webp
├── uploads/                    # user-supplied reference images, same sharding
│   └── 2026/09/23/01K6BQ9Z….jpg
├── thumbs/                     # derived, disposable, content-addressed by source hash
│   └── 3f/                     # key: <sha256>@h<rung>[@2x].webp — rungs 200/280/360/456/640 (§0.10)
│       ├── 3f9c1a…@h456.webp   # feed thumb at row-height 456, dpr=1
│       ├── 3f9c1a…@h456@2x.webp  # dpr=2 variant, capped at the original's dimensions
│       ├── 3f9c1a…@h200.webp
│       └── 3f9c1a…@p1440.webp  # detail-dialog preview, long edge 1440
├── presets/                    # JSON exports/imports of the user preset library (§8.3)
│   ├── exported/
│   └── imported/
├── canvases/                   # canvas graph exports, user templates, auto-generated 16:9 preview PNGs
│   ├── exports/
│   ├── templates/              # user-saved canvas templates (§7.8); bundled ones ship in apps/server/seed/templates/
│   └── previews/01K6BR….png
├── logs/
│   ├── openfield.log           # rolling, 10 MB × 5, secrets redacted
│   └── jobs.ndjson             # one line per job transition, for post-mortems
├── backups/                    # `VACUUM INTO` snapshots: openfield-2026-09-23T12-04Z.db
└── tmp/                        # in-flight downloads, orphan quarantine, import staging
    └── orphans/
```

**Why date-sharded originals and content-addressed derivatives.** Originals are the user's library: they must be browsable in Finder/Explorer without the app, and "the day I made it" is the only sort a human uses, so `assets/YYYY/MM/DD/<ulid>.<ext>` wins over a `ab/cd/<sha256>` blob store. ULID filenames are lexicographically time-ordered, collision-free and carry no user text. Deduplication is not lost: `assets.sha256` is stored and indexed, so re-importing identical bytes is detected and surfaced ("You already have this") without forcing a hash-shaped tree on the user. Thumbnails are the opposite case — pure cache, never browsed by hand, regenerable at any time — so they are keyed by `sha256@height`, shared automatically between duplicate assets, and safe to delete wholesale.

**There is no `refs/` tree.** Reference images are ordinary uploads under `uploads/YYYY/MM/DD/<ulid>.<ext>` with an `assets` row (`kind='uploaded'`), and reference sets hold asset ids, never paths or hashes (§0.7). Painted masks are likewise ordinary assets (`kind='mask'`). `presets/` holds only `exported/` and `imported/` material — SQLite is the store of record (§0.8). Streamed partial frames live in `tmp/` and are never filed as assets (§0.6).

**Paths in the database are always relative to `OPENFIELD_HOME`** (`assets/2026/09/23/01K6….png`). Copying `~/.openfield` to another machine, another OS or an external drive is a complete, working migration. No absolute path, no drive letter, no username ever enters the db.

**Split of config vs settings.** `config.json` holds only secrets and boot-time values (provider keys, port, home). Everything else — default model, default aspect ratio, feed zoom step, concurrency caps, thumbnail quality, trash retention — lives in the `settings` table, so the db can be backed up, inspected or shared without leaking a key. Env vars override `config.json` at read time and are never written back: `OPENFIELD_OPENAI_API_KEY` (falling back to `OPENAI_API_KEY`), `OPENFIELD_GOOGLE_API_KEY` (→ `GOOGLE_API_KEY`/`GEMINI_API_KEY`), `OPENFIELD_HIGGSFIELD_KEY_ID` + `OPENFIELD_HIGGSFIELD_KEY_SECRET` (the researched Higgsfield auth is `Authorization: Key ${id}:${secret}`).

---

### 8.2 SQLite schema

One file, `openfield.db`, opened by the Bun server through `bun:sqlite` with the `drizzle-orm/bun-sqlite` driver. **The Drizzle schema in `packages/db/src/schema/` is the single source of truth** for every table, column, default, CHECK, index, unique constraint and foreign key (§0.16). `drizzle-kit generate` turns each schema change into a committed, reviewable SQL migration in `packages/db/migrations/`. Drizzle can't express the FTS5 index and its triggers, so they live in a hand-written migration in the same folder (8.2.3). Migrations are forward-only and applied on boot (8.2.4).

Conventions for every table below:
- Timestamps are ISO-8601 UTC `TEXT`.
- Ids are ULIDs in `TEXT` primary keys (§0.2), generated in application code. `$defaultFn` hooks run in JS and add nothing to the generated SQL.
- Flags use Drizzle's boolean mode, `integer("x", { mode: "boolean" })`: `0`/`1` on disk, `boolean` in TypeScript and in the drizzle-zod row schemas. The default is a raw SQL literal (`sql.raw("1")`), because a plain `true`/`false` default would make drizzle-kit print `DEFAULT true`/`DEFAULT false`. The generated SQL stays `INTEGER NOT NULL DEFAULT 1`, and SQL written by hand (queries, §8.2.2) compares flags with `= 1`/`= 0`. No flag has a 0/1 CHECK.
- JSON columns are `text({ mode: "json" }).$type<T>()`: `TEXT` on disk, parsed and serialised by Drizzle, typed by the core schema named in `T`.
- `text({ enum })` narrows the TypeScript type only. The database enforces the same list through a named CHECK that `oneOf()` builds from `@openfield/core/constants`. A column with no CHECK in this schema has none on purpose (`error_code`, `assets.op`, `usage_log.operation`, every `modality` except `models.modality`).
- CHECK and partial-index SQL uses bare column names, never `${t.column}`. A drizzle-kit table rebuild (`__new_<table>`) then can't carry a stale table qualifier.
- Drizzle emits a table-level `unique()` and a column-level `.unique()` as a named `CREATE UNIQUE INDEX` (`jobs_job_set_id_idx_unique`, `job_sets_idempotency_key_unique`) rather than an inline `UNIQUE`, and prints `REAL` defaults as `1` rather than `1.0`. Both are equivalent to the inline `UNIQUE` and the `1.0` literal.
- `.primaryKey()` always adds `NOT NULL`, so every single-column `TEXT` primary key is `TEXT PRIMARY KEY NOT NULL`. That is stricter than the bare `TEXT PRIMARY KEY`, which SQLite (for legacy reasons) lets hold NULL. No valid row has a NULL id, and Drizzle can't express the looser form.
- No table is `WITHOUT ROWID`. `assets` needs its implicit rowid for the FTS5 external-content index.

```ts
// packages/core/src/constants.ts: the one list behind each zod enum, each Drizzle enum type and each CHECK
export const MODALITIES           = ["image", "video", "audio"] as const;
export const JOB_STATES           = ["pending", "submitting", "queued", "running",
                                     "succeeded", "failed", "canceled", "interrupted"] as const;   // §0.4
export const JOB_SET_STATES       = [...JOB_STATES, "partial"] as const;                         // §0.4
export const ACTIVE_JOB_STATES    = ["pending", "submitting", "queued", "running"] as const;
export const OPS                  = ["generate", "edit", "inpaint", "outpaint", "variation", "upscale",
                                     "remove_bg", "text_edit", "relight", "angles", "enhance", "decompose",
                                     "crop", "grade", "overlay"] as const;                       // §0.4
export const JOB_SOURCES          = ["composer", "detail_editor", "canvas", "api", "recreate"] as const;
export const AUTH_KINDS           = ["api_key", "key_secret_pair", "none"] as const;
export const CREDENTIAL_SOURCES   = ["env", "file", "unset"] as const;
export const MODEL_SOURCES        = ["static", "discovered", "user"] as const;
export const ASSET_KINDS          = ["generated", "uploaded", "imported", "edited", "mask"] as const;
export const FILE_STATES          = ["ok", "missing", "quarantined"] as const;
export const EDGE_RELATIONS       = ["derived", "reference", "import"] as const;                 // §0.4
export const PRESET_ASSET_ROLES   = ["reference", "palette", "thumb"] as const;
export const REFERENCE_SET_ROLES  = ["style", "subject", "composition", "palette"] as const;
export const CHARACTER_INJECTIONS = ["prefix", "suffix", "replace-token"] as const;
export const PALETTE_MODES        = ["prompt", "reference", "both"] as const;
export const CANVAS_RUN_SCOPES    = ["node", "downstream", "all", "selection"] as const;
export const USAGE_OUTCOMES       = ["succeeded", "failed", "canceled"] as const;
export const COST_SOURCES         = ["reconciled", "estimated", "unknown"] as const;
// ERROR_CODES (§0.5) lives here too. error_code columns are typed with it and carry no CHECK.
```

```ts
// packages/db/src/schema/_helpers.ts
import { sql, type SQL } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";

/** `column IN ('a','b',…)` from a core constant, with a bare column name (see conventions). */
export const oneOf = (column: string, values: readonly string[]): SQL =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(",")})`);

/** Boolean in TS, 0/1 in SQLite. The sql default keeps the migration at DEFAULT 0|1. */
export const flag = (name: string, dflt: 0 | 1) =>
  integer(name, { mode: "boolean" }).notNull().default(sql.raw(String(dflt)));

export const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
```

```ts
// packages/db/src/schema/providers.ts
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { AUTH_KINDS, CREDENTIAL_SOURCES, MODALITIES, MODEL_SOURCES } from "@openfield/core/constants";
import type { Capabilities, PriceModel } from "@openfield/core/schemas";
import { flag, json, oneOf } from "./_helpers";

// No secret ever lands here. credential_ref is a POINTER into config.json / env.
export const providers = sqliteTable("providers", {
  id:               text("id").primaryKey(),                      // 'openai' | 'google' | 'higgsfield' | 'fal' | 'replicate'
  displayName:      text("display_name").notNull(),
  adapter:          text("adapter").notNull(),                    // built-in adapter module id
  authKind:         text("auth_kind", { enum: AUTH_KINDS }).notNull(),
  credentialRef:    text("credential_ref"),                       // e.g. 'keys.openai': a path, never a value
  credentialSource: text("credential_source", { enum: CREDENTIAL_SOURCES }).notNull().default("unset"),
  credentialHint:   text("credential_hint"),                      // last 4 chars only, for the Settings UI
  baseUrl:          text("base_url"),
  enabled:          flag("enabled", 1),
  concurrencyCap:   integer("concurrency_cap").notNull().default(2),
  lastOkAt:         text("last_ok_at"),
  lastError:        text("last_error"),
  createdAt:        text("created_at").notNull(),
  updatedAt:        text("updated_at").notNull(),
}, () => [
  check("providers_auth_kind_check", oneOf("auth_kind", AUTH_KINDS)),
  check("providers_credential_source_check", oneOf("credential_source", CREDENTIAL_SOURCES)),
]);

// Cache of the model registry (§6). Rows are refreshed by runtime discovery where the
// provider allows it, otherwise seeded from the adapter's shipped manifest.
export const models = sqliteTable("models", {
  providerId:   text("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
  modelId:      text("model_id").notNull(),                       // provider-native id, e.g. 'gemini-3-pro-image'
  displayName:  text("display_name").notNull(),
  family:       text("family"),                                   // grouping key for the picker's sections
  modality:     text("modality", { enum: MODALITIES }).notNull().default("image"),
  badges:       json<string[]>("badges"),                         // §6.3 badges: ["new"], ["legacy"]
  capabilities: json<Capabilities>("capabilities").notNull(),     // the capability manifest (§0.3)
  pricing:      json<PriceModel>("pricing"),                      // pricing snapshot + as_of date
  source:       text("source", { enum: MODEL_SOURCES }).notNull(),
  enabled:      flag("enabled", 1),
  sortOrder:    integer("sort_order").notNull().default(0),
  discoveredAt: text("discovered_at"),
  updatedAt:    text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.providerId, t.modelId] }),
  check("models_modality_check", oneOf("modality", MODALITIES)),
  check("models_source_check", oneOf("source", MODEL_SOURCES)),
]);
```

```ts
// packages/db/src/schema/jobs.ts
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { ACTIVE_JOB_STATES, ERROR_CODES, JOB_SET_STATES, JOB_SOURCES, JOB_STATES, OPS } from "@openfield/core/constants";
import type { NormalizedRequest } from "@openfield/core/schemas";
import { json, oneOf } from "./_helpers";
import { providers } from "./providers";
import { canvases, canvasRuns } from "./canvas";

// A JOB SET is one submit: one Generate click, one edit commit, or one canvas node run, with
// N outputs. A JOB is one output and one feed tile (§0.1).
export const jobSets = sqliteTable("job_sets", {
  id:              text("id").primaryKey(),                           // ULID
  idempotencyKey:  text("idempotency_key").unique(),                  // client ULID, one per job set (§0.2)
  op:              text("op", { enum: OPS }).notNull(),               // exactly §0.4 Op
  modality:        text("modality").notNull().default("image"),
  providerId:      text("provider_id").notNull().references(() => providers.id),
  modelId:         text("model_id").notNull(),
  prompt:          text("prompt").notNull().default(""),              // as submitted (after enhance, after preset)
  promptOriginal:  text("prompt_original"),                           // pre-enhance text when §3.4.3 rewrote it
  negativePrompt:  text("negative_prompt"),
  requestJson:     json<NormalizedRequest>("request_json").notNull(), // the frozen NormalizedRequest (§0.11). Recreate
                                                                      // replays THIS, never the current UI or manifest.
  batchSize:       integer("batch_size").notNull().default(1),
  priority:        integer("priority").notNull().default(10),         // §0.12: composer/single-node 10, run-all 5
  status:          text("status", { enum: JOB_SET_STATES }).notNull().default("pending"),  // §0.4 JobSetState
  source:          text("source", { enum: JOB_SOURCES }).notNull().default("composer"),
  canvasId:        text("canvas_id").references(() => canvases.id, { onDelete: "set null" }),
  canvasNodeId:    text("canvas_node_id"),
  canvasRunId:     text("canvas_run_id").references(() => canvasRuns.id, { onDelete: "set null" }),
  costEstimateUsd: real("cost_estimate_usd"),
  costActualUsd:   real("cost_actual_usd"),
  errorCode:       text("error_code", { enum: ERROR_CODES }),         // one of §0.5 ErrorCode
  errorMessage:    text("error_message"),
  createdAt:       text("created_at").notNull(),
  startedAt:       text("started_at"),
  finishedAt:      text("finished_at"),
}, (t) => [
  check("job_sets_op_check", oneOf("op", OPS)),
  // UI cap is 4 (observed parity); raising it requires a migration and a manifest change.
  check("job_sets_batch_size_check", sql`batch_size BETWEEN 1 AND 4`),
  check("job_sets_status_check", oneOf("status", JOB_SET_STATES)),
  check("job_sets_source_check", oneOf("source", JOB_SOURCES)),
  index("idx_job_sets_created").on(sql`created_at DESC`),
  // Scheduler selection order (§0.12): priority DESC, then created_at, then jobs.idx.
  index("idx_job_sets_sched").on(sql`priority DESC`, t.createdAt).where(oneOf("status", ACTIVE_JOB_STATES)),
  index("idx_job_sets_canvas").on(t.canvasId, t.canvasNodeId),
  index("idx_job_sets_run").on(t.canvasRunId),
]);

export const jobs = sqliteTable("jobs", {
  id:             text("id").primaryKey(),                            // ULID
  jobSetId:       text("job_set_id").notNull().references(() => jobSets.id, { onDelete: "cascade" }),
  idx:            integer("idx").notNull(),                           // 0..batch_size-1, drives placeholder ordering
  providerJobId:  text("provider_job_id"),                            // provider-side request/prediction id
  idempotencyKey: text("idempotency_key"),                            // `${jobSet.idempotency_key}:${idx}`, reused on
                                                                      // every attempt (§0.2, §0.4)
  status:         text("status", { enum: JOB_STATES }).notNull().default("pending"),  // mirrors §0.4 JobState verbatim
  progress:       real("progress"),                                   // 0..1 when the provider reports it, else NULL
  seed:           integer("seed"),                                    // NULL unless capabilities.seed.supported (§0.11)
  attempt:        integer("attempt").notNull().default(0),
  nextAttemptAt:  text("next_attempt_at"),
  errorCode:      text("error_code", { enum: ERROR_CODES }),          // one of §0.5 ErrorCode
  errorMessage:   text("error_message"),                              // detail for the error log, never shown
  latencyMs:      integer("latency_ms"),
  createdAt:      text("created_at").notNull(),
  updatedAt:      text("updated_at").notNull(),
  startedAt:      text("started_at"),
  finishedAt:     text("finished_at"),
  errorReason:    text("error_reason"),                               // our tile copy when it says more than §0.5's row
                                                                      // (migration 0002, so the column sits last)
}, (t) => [
  unique("jobs_job_set_id_idx_unique").on(t.jobSetId, t.idx),
  check("jobs_status_check", oneOf("status", JOB_STATES)),
  // Queue scan and crash recovery: tiny partial index, always hot.
  index("idx_jobs_active").on(t.status, t.nextAttemptAt).where(oneOf("status", ACTIVE_JOB_STATES)),
  index("idx_jobs_job_set").on(t.jobSetId, t.idx),
]);
```

```ts
// packages/db/src/schema/assets.ts
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { ASSET_KINDS, EDGE_RELATIONS, FILE_STATES, OPS } from "@openfield/core/constants";
import { flag, json, oneOf } from "./_helpers";
import { jobs, jobSets } from "./jobs";

export const assets = sqliteTable("assets", {
  id:                text("id").primaryKey(),                         // ULID
  kind:              text("kind", { enum: ASSET_KINDS }).notNull(),
  modality:          text("modality").notNull().default("image"),
  jobId:             text("job_id").references(() => jobs.id, { onDelete: "set null" }),
  jobSetId:          text("job_set_id").references(() => jobSets.id, { onDelete: "set null" }),
  path:              text("path").notNull(),                          // relative to OPENFIELD_HOME
  mime:              text("mime").notNull(),                          // image/png | image/webp | image/jpeg
  width:             integer("width").notNull(),
  height:            integer("height").notNull(),
  bytes:             integer("bytes").notNull(),
  sha256:            text("sha256").notNull(),
  seed:              integer("seed"),
  providerId:        text("provider_id"),                             // 'local' for crop / grade / overlay (§0.4); no FK
  modelId:           text("model_id"),                                // denormalised: the feed filters on it constantly
  prompt:            text("prompt").notNull().default(""),            // denormalised for FTS + the Info tab
  params:            json<Record<string, unknown>>("params"),         // snapshot of the exact params that made it
  tags:              text("tags").notNull().default(""),              // space-separated user tags, indexed by FTS
  costUsd:           real("cost_usd"),
  // Lineage columns (§0.7). The version strip and the History tab read these, never a CTE.
  parentAssetId:     text("parent_asset_id"),                         // NO foreign key: a hard-deleted parent must leave
                                                                      // the child's chain intact; it is a tombstone
                                                                      // pointer (§4.9 requirement 7, §8.6)
  rootAssetId:       text("root_asset_id").notNull(),                 // denormalised lineage root
  op:                text("op", { enum: OPS }),                       // §0.4 Op that produced this asset
  opParams:          json<Record<string, unknown>>("op_params"),      // re-opens the tool with its own settings
  maskAssetId:       text("mask_asset_id").references((): AnySQLiteColumn => assets.id, { onDelete: "set null" }),
  generative:        flag("generative", 1),                           // 0 for local ops (crop, grade, overlay)
  approximate:       flag("approximate", 0),                          // 1 when produced by the §0.9 regional fallback
  approximateReason: text("approximate_reason"),
  fileState:         text("file_state", { enum: FILE_STATES }).notNull().default("ok"),
  createdAt:         text("created_at").notNull(),
  updatedAt:         text("updated_at").notNull(),
  deletedAt:         text("deleted_at"),                              // soft delete: Trash
}, (t) => [
  check("assets_kind_check", oneOf("kind", ASSET_KINDS)),
  check("assets_file_state_check", oneOf("file_state", FILE_STATES)),
  // Feed: keyset pagination over the live library, newest first.
  index("idx_assets_feed").on(sql`created_at DESC`, sql`id DESC`).where(sql`deleted_at IS NULL`),
  index("idx_assets_modality").on(t.modality, sql`created_at DESC`).where(sql`deleted_at IS NULL`),
  index("idx_assets_model").on(t.modelId, sql`created_at DESC`).where(sql`deleted_at IS NULL`),
  index("idx_assets_job_set").on(t.jobSetId),
  index("idx_assets_sha256").on(t.sha256),
  index("idx_assets_trash").on(t.deletedAt).where(sql`deleted_at IS NOT NULL`),
  // Version strip and History: one index scan per lineage root, no recursion (§0.7).
  index("idx_assets_root").on(t.rootAssetId, t.createdAt).where(sql`deleted_at IS NULL`),
]);

// The multi-parent REFERENCE graph only. The operation lives on assets.op, never on the edge (§0.4).
// A child may have several parents (an edit that consumed three reference images).
export const assetEdges = sqliteTable("asset_edges", {
  parentAssetId: text("parent_asset_id").notNull(),                   // no FK: survives a hard-deleted parent
  childAssetId:  text("child_asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  relation:      text("relation", { enum: EDGE_RELATIONS }).notNull(),
  ordinal:       integer("ordinal").notNull().default(0),             // reference order, mirrors the Info tab thumb row
  createdAt:     text("created_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.parentAssetId, t.childAssetId, t.relation, t.ordinal] }),
  check("asset_edges_relation_check", oneOf("relation", EDGE_RELATIONS)),
  index("idx_edges_parent").on(t.parentAssetId),
  index("idx_edges_child").on(t.childAssetId),
]);
```

```ts
// packages/db/src/schema/organisation.ts
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { assets } from "./assets";

export const folders = sqliteTable("folders", {
  id:        text("id").primaryKey(),
  parentId:  text("parent_id").references((): AnySQLiteColumn => folders.id, { onDelete: "cascade" }),
  name:      text("name").notNull(),
  color:     text("color"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const assetFolders = sqliteTable("asset_folders", {
  assetId:  text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  folderId: text("folder_id").notNull().references(() => folders.id, { onDelete: "cascade" }),
  addedAt:  text("added_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.assetId, t.folderId] }),
  index("idx_asset_folders_fld").on(t.folderId, sql`added_at DESC`),
]);

export const favourites = sqliteTable("favourites", {
  assetId:   text("asset_id").primaryKey().references(() => assets.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
}, () => [
  index("idx_favourites_created").on(sql`created_at DESC`),
]);
```

```ts
// packages/db/src/schema/library.ts
import { check, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CHARACTER_INJECTIONS, PALETTE_MODES, PRESET_ASSET_ROLES, REFERENCE_SET_ROLES } from "@openfield/core/constants";
import type { PresetObject } from "@openfield/core/schemas";
import { flag, json, oneOf } from "./_helpers";
import { assets } from "./assets";

// Four entities, four tables (§0.8). The object shape is §5.3's; it is stored whole in
// payload_json rather than shredded into typed columns, so an exported preset and a stored
// preset are the same object. There is no `kind` column: this table holds STYLE presets only.
export const presets = sqliteTable("presets", {
  id:           text("id").primaryKey(),
  name:         text("name").notNull(),
  description:  text("description"),
  payloadJson:  json<PresetObject>("payload_json").notNull(),         // the §5.3 object, the single source
  thumbAssetId: text("thumb_asset_id").references(() => assets.id, { onDelete: "set null" }),
  builtin:      flag("builtin", 0),                                   // shipped starter presets, copy-on-edit
  origin:       text("origin"),                                       // 'user' | 'import:<filename>'
  sortOrder:    integer("sort_order").notNull().default(0),
  createdAt:    text("created_at").notNull(),
  updatedAt:    text("updated_at").notNull(),
});

export const presetAssets = sqliteTable("preset_assets", {
  presetId: text("preset_id").notNull().references(() => presets.id, { onDelete: "cascade" }),
  assetId:  text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  role:     text("role", { enum: PRESET_ASSET_ROLES }).notNull(),
  weight:   real("weight").notNull().default(1.0),
  ordinal:  integer("ordinal").notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.presetId, t.assetId, t.role] }),
  check("preset_assets_role_check", oneOf("role", PRESET_ASSET_ROLES)),
]);

export const referenceSets = sqliteTable("reference_sets", {
  id:        text("id").primaryKey(),
  name:      text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const referenceSetItems = sqliteTable("reference_set_items", {
  setId:    text("set_id").notNull().references(() => referenceSets.id, { onDelete: "cascade" }),
  assetId:  text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),  // asset id, never sha256
  position: integer("position").notNull(),
  weight:   real("weight").notNull().default(1.0),
  role:     text("role", { enum: REFERENCE_SET_ROLES }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.setId, t.assetId] }),
  check("reference_set_items_role_check", oneOf("role", REFERENCE_SET_ROLES)),
  index("idx_ref_set_items").on(t.setId, t.position),
]);

// Our open substitute for a trained identity: reference set + descriptor + optional pinned seed.
export const characters = sqliteTable("characters", {
  id:                   text("id").primaryKey(),
  name:                 text("name").notNull(),
  descriptor:           text("descriptor"),                           // prose injected into the prompt
  referenceSetId:       text("reference_set_id").references(() => referenceSets.id),
  seed:                 integer("seed"),
  lockSeed:             flag("lock_seed", 0),
  injection:            text("injection", { enum: CHARACTER_INJECTIONS }),
  token:                text("token"),                                // the @-mention token (§0.8)
  providerIdentityJson: json<Record<string, unknown>>("provider_identity_json"),  // native identity handles, per provider
  thumbAssetId:         text("thumb_asset_id").references(() => assets.id, { onDelete: "set null" }),
  createdAt:            text("created_at").notNull(),
  updatedAt:            text("updated_at").notNull(),
}, () => [
  check("characters_injection_check", oneOf("injection", CHARACTER_INJECTIONS)),
]);

export const characterAssets = sqliteTable("character_assets", {
  characterId: text("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  assetId:     text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  ordinal:     integer("ordinal").notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.characterId, t.assetId] }),
]);

export const palettes = sqliteTable("palettes", {
  id:              text("id").primaryKey(),
  name:            text("name").notNull(),
  hexJson:         json<string[]>("hex_json").notNull(),
  populationsJson: json<number[]>("populations_json").notNull(),
  sourceAssetId:   text("source_asset_id").references(() => assets.id, { onDelete: "set null" }),
  k:               integer("k").notNull(),
  mode:            text("mode", { enum: PALETTE_MODES }).notNull(),
  builtin:         flag("builtin", 0),
  createdAt:       text("created_at").notNull(),
  updatedAt:       text("updated_at").notNull(),
}, () => [
  check("palettes_mode_check", oneOf("mode", PALETTE_MODES)),
]);

export const savedPrompts = sqliteTable("saved_prompts", {
  id:        text("id").primaryKey(),
  name:      text("name").notNull(),
  text:      text("text").notNull(),                                  // {{name}} variables resolve before templates
  tagsJson:  json<string[]>("tags_json"),
  presetId:  text("preset_id").references(() => presets.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
```

```ts
// packages/db/src/schema/canvas.ts
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { CANVAS_RUN_SCOPES, JOB_SET_STATES } from "@openfield/core/constants";
import type { CanvasGraph } from "@openfield/core/canvas";
import { json, oneOf } from "./_helpers";

export const canvases = sqliteTable("canvases", {
  id:            text("id").primaryKey(),
  name:          text("name").notNull().default("Untitled"),
  graph:         json<CanvasGraph>("graph").notNull(),              // {nodes:[], edges:[], viewport:{}}, per canvasDocumentSchema
  graphVersion:  integer("graph_version").notNull().default(1),     // optimistic concurrency token
  schemaVersion: integer("schema_version").notNull().default(1),    // graph JSON shape version, for document migrations
  previewPath:   text("preview_path"),                              // canvases/previews/<id>.png
  createdAt:     text("created_at").notNull(),
  updatedAt:     text("updated_at").notNull(),
  openedAt:      text("opened_at"),
  deletedAt:     text("deleted_at"),
});

export const canvasVersions = sqliteTable("canvas_versions", {
  id:        text("id").primaryKey(),
  canvasId:  text("canvas_id").notNull().references(() => canvases.id, { onDelete: "cascade" }),
  graph:     json<CanvasGraph>("graph").notNull(),
  label:     text("label"),                                         // 'autosave' | user-typed name
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idx_canvas_versions").on(t.canvasId, sql`created_at DESC`),
]);

// One row per POST /api/canvases/:id/run, so a multi-node run survives a reload (§0.12, §7.7).
export const canvasRuns = sqliteTable("canvas_runs", {
  id:         text("id").primaryKey(),                              // ULID
  canvasId:   text("canvas_id").notNull().references(() => canvases.id, { onDelete: "cascade" }),
  scope:      text("scope", { enum: CANVAS_RUN_SCOPES }).notNull(),
  status:     text("status", { enum: JOB_SET_STATES }).notNull().default("running"),  // §0.4 JobSetState
  createdAt:  text("created_at").notNull(),
  finishedAt: text("finished_at"),
}, () => [
  check("canvas_runs_scope_check", oneOf("scope", CANVAS_RUN_SCOPES)),
  check("canvas_runs_status_check", oneOf("status", JOB_SET_STATES)),
]);
```

```ts
// packages/db/src/schema/usage.ts
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { COST_SOURCES, OPS, USAGE_OUTCOMES } from "@openfield/core/constants";
import type { UsageUnits } from "@openfield/core/schemas";
import { flag, json, oneOf } from "./_helpers";

// One row per terminal outcome: success, failure and cancel alike (§0.13).
export const usageLog = sqliteTable("usage_log", {
  id:          integer("id").primaryKey({ autoIncrement: true }),
  ts:          text("ts").notNull(),
  providerId:  text("provider_id").notNull(),
  modelId:     text("model_id").notNull(),
  jobSetId:    text("job_set_id"),
  jobId:       text("job_id"),
  batchIndex:  integer("batch_index"),
  operation:   text("operation", { enum: OPS }).notNull(),            // §0.4 Op, byte-identical to job_sets.op
  outcome:     text("outcome", { enum: USAGE_OUTCOMES }).notNull(),
  size:        text("size"),                                          // '1536x2048'
  quality:     text("quality"),
  units:       json<UsageUnits>("units"),                             // {images, tokens_in, tokens_out, cached_in}
  estimateMin: real("estimate_min"),
  estimateMax: real("estimate_max"),
  costUsd:     real("cost_usd"),
  costSource:  text("cost_source", { enum: COST_SOURCES }),
  priceAsOf:   text("price_as_of"),
  discarded:   flag("discarded", 0),                                  // canceled after submit: billed but no asset
  latencyMs:   integer("latency_ms"),
  httpStatus:  integer("http_status"),
}, (t) => [
  check("usage_log_outcome_check", oneOf("outcome", USAGE_OUTCOMES)),
  check("usage_log_cost_source_check", oneOf("cost_source", COST_SOURCES)),
  index("idx_usage_ts").on(sql`ts DESC`),
  index("idx_usage_model").on(t.providerId, t.modelId, sql`ts DESC`),
]);

export const settings = sqliteTable("settings", {
  key:       text("key").primaryKey(),
  value:     json<unknown>("value").notNull(),                        // JSON, validated per key by settingsSchema (§6.17)
  updatedAt: text("updated_at").notNull(),
});
```

```ts
// packages/db/src/schema/index.ts
export * from "./providers";
export * from "./jobs";
export * from "./assets";
export * from "./organisation";
export * from "./library";
export * from "./canvas";
export * from "./usage";

// packages/db/drizzle.config.ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./src/schema/index.ts", out: "./migrations" });

// packages/db/src/rows.ts: drizzle-zod row schemas, one select/insert pair per table
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { capabilitiesSchema, priceModelSchema } from "@openfield/core/schemas";
import * as t from "./schema";
export const modelRow    = createSelectSchema(t.models, { capabilities: capabilitiesSchema, pricing: priceModelSchema.nullable() });
export const newModelRow = createInsertSchema(t.models, { capabilities: capabilitiesSchema });
export const assetRow    = createSelectSchema(t.assets);
export const newAssetRow = createInsertSchema(t.assets);
// … and so on for every table
export type AssetRow    = typeof t.assets.$inferSelect;
export type NewAssetRow = typeof t.assets.$inferInsert;
```

Insert schemas guard writes whose data came from outside the process (preset bundles, imported canvases, `models.json`). Query helpers take and return the inferred row types.

**Notes on the enums.** `job_sets.op` values are exactly §0.4's `Op` (the `OPS` constant). `assets.op` and `usage_log.operation` use the same union byte for byte; they are typed with it and carry no CHECK. The local ops (`crop`, `grade`, `overlay`) never reach an adapter: they write `provider_id = 'local'`, `cost_actual_usd = 0` and `assets.generative = 0`. `expand` is renamed `outpaint`, and `removeBackground` settles as `remove_bg` throughout. The lineage `relation` union is deliberately smaller than `Op` (§0.4), because the operation is a property of the asset, not of the edge.

#### 8.2.1 Indices

Every index is declared in its table's Drizzle definition above. The block below is the SQL those definitions must generate, with the reason for each index. `packages/db/test/schema.test.ts` applies every migration to an in-memory database and checks three things: each index's `sqlite_master.sql` (whitespace- and quote-normalised) against the statement here, each CHECK list against its core constant, and `PRAGMA foreign_key_list` for every table against §8.2's references. drizzle-kit might not emit an index exactly (it drops a `WHERE` or a `DESC`). In that case the index is removed from the Drizzle table and written verbatim into a custom migration (8.2.3), under the same name, and the test still passes.

```sql
-- Feed: keyset pagination over the live library, newest first.
CREATE INDEX idx_assets_feed        ON assets(created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_assets_modality    ON assets(modality, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_assets_model       ON assets(model_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_assets_job_set     ON assets(job_set_id);
CREATE INDEX idx_assets_sha256      ON assets(sha256);
CREATE INDEX idx_assets_trash       ON assets(deleted_at) WHERE deleted_at IS NOT NULL;
-- Version strip and History: one index scan per lineage root, no recursion (§0.7).
CREATE INDEX idx_assets_root        ON assets(root_asset_id, created_at) WHERE deleted_at IS NULL;

CREATE INDEX idx_asset_folders_fld  ON asset_folders(folder_id, added_at DESC);
CREATE INDEX idx_favourites_created ON favourites(created_at DESC);

CREATE INDEX idx_edges_parent       ON asset_edges(parent_asset_id);
CREATE INDEX idx_edges_child        ON asset_edges(child_asset_id);

-- Queue scan and crash recovery: tiny partial index, always hot.
CREATE INDEX idx_jobs_active        ON jobs(status, next_attempt_at)
  WHERE status IN ('pending','submitting','queued','running');
CREATE INDEX idx_jobs_job_set       ON jobs(job_set_id, idx);
CREATE INDEX idx_job_sets_created   ON job_sets(created_at DESC);
-- Scheduler selection order (§0.12): priority DESC, then created_at, then jobs.idx.
CREATE INDEX idx_job_sets_sched     ON job_sets(priority DESC, created_at)
  WHERE status IN ('pending','submitting','queued','running');
CREATE INDEX idx_job_sets_canvas    ON job_sets(canvas_id, canvas_node_id);
CREATE INDEX idx_job_sets_run       ON job_sets(canvas_run_id);

CREATE INDEX idx_ref_set_items      ON reference_set_items(set_id, position);

CREATE INDEX idx_usage_ts           ON usage_log(ts DESC);
CREATE INDEX idx_usage_model        ON usage_log(provider_id, model_id, ts DESC);
CREATE INDEX idx_canvas_versions    ON canvas_versions(canvas_id, created_at DESC);
```

#### 8.2.2 The queries that matter

Each query below is a typed helper in `packages/db/src/queries/`, and routes never write SQL themselves (§0.16). Simple reads and writes use Drizzle's query builder. The row-value cursor, the FTS `MATCH` with `snippet()` and `bm25()`, the recursive CTE and the usage rollup use Drizzle's `sql` template, stay parameterised, and return typed rows. The SQL shown is what they execute. The recovery query's status list is `ACTIVE_JOB_STATES`.

**Feed page (keyset cursor, never `OFFSET`).** The feed is a justified-rows layout at a target row height, so every page must return `width`/`height` with the row — the client computes row breaks before a single byte of image data arrives, which is what makes placeholders reserve the correct aspect ratio. SQLite row-value comparison (3.15+) gives a clean two-column cursor:

```sql
SELECT a.id, a.path, a.mime, a.width, a.height, a.sha256, a.model_id, a.created_at,
       (f.asset_id IS NOT NULL) AS is_favourite
FROM assets a
LEFT JOIN favourites f ON f.asset_id = a.id
WHERE a.deleted_at IS NULL
  AND a.modality = 'image'
  AND (:cursor_ts IS NULL OR (a.created_at, a.id) < (:cursor_ts, :cursor_id))
ORDER BY a.created_at DESC, a.id DESC
LIMIT :limit;                                   -- default 50
```

The cursor returned to the client is `base64url("<created_at>|<id>")`. `limit` 50 — the measured feed page size — at four columns fills roughly two and a half screens.

**Folder filter** — same shape, one join, hits `idx_asset_folders_fld`:

```sql
SELECT a.* FROM asset_folders af
JOIN assets a ON a.id = af.asset_id
WHERE af.folder_id = :folder_id AND a.deleted_at IS NULL
  AND (:cursor_ts IS NULL OR (a.created_at, a.id) < (:cursor_ts, :cursor_id))
ORDER BY a.created_at DESC, a.id DESC
LIMIT :limit;
```

**Prompt search (FTS5)** — same cursor, so search results paginate identically to the feed:

```sql
SELECT a.id, a.path, a.width, a.height, a.created_at,
       snippet(assets_fts, 0, '<mark>', '</mark>', '…', 12) AS excerpt
FROM assets_fts s
JOIN assets a ON a.rowid = s.rowid
WHERE s MATCH :query                              -- user text sanitised into an FTS5 query string
  AND a.deleted_at IS NULL
  AND (:cursor_ts IS NULL OR (a.created_at, a.id) < (:cursor_ts, :cursor_id))
ORDER BY a.created_at DESC, a.id DESC
LIMIT :limit;
```

Search is chronological, not relevance-ranked, because the feed's mental model is chronological; a `sort=relevance` flag switches the ORDER BY to `bm25(assets_fts)` and falls back to offset pagination for that mode only.

**Version strip and History tab** — one index scan, no recursion (§0.7):

```sql
SELECT id, path, width, height, op, generative, approximate, approximate_reason, created_at
FROM assets
WHERE root_asset_id = :root AND deleted_at IS NULL
ORDER BY created_at;                            -- hits idx_assets_root
```

**The multi-parent reference graph** behind `GET /api/assets/:id/lineage` — and only that — uses the recursive walk (ancestors up to depth 16, then one level of children). The version strip never touches it:

```sql
WITH RECURSIVE ancestors(id, depth) AS (
  SELECT :asset_id, 0
  UNION
  SELECT e.parent_asset_id, a.depth + 1
  FROM asset_edges e JOIN ancestors a ON e.child_asset_id = a.id
  WHERE a.depth < 16
)
SELECT DISTINCT a.*, an.depth FROM ancestors an JOIN assets a ON a.id = an.id ORDER BY an.depth;
```

**Crash recovery on boot** (§8.4.5):

```sql
SELECT j.*, js.provider_id, js.model_id
FROM jobs j JOIN job_sets js ON js.id = j.job_set_id
WHERE j.status IN ('pending','submitting','queued','running')
ORDER BY js.priority DESC, js.created_at, j.idx;
```

**Usage rollup for the cost panel**:

```sql
SELECT substr(ts,1,10) AS day, provider_id, model_id,
       COUNT(*) AS runs,
       SUM(CASE WHEN outcome = 'succeeded' THEN COALESCE(cost_usd,0) ELSE 0 END) AS usd,
       SUM(CASE WHEN discarded = 1        THEN COALESCE(cost_usd,0) ELSE 0 END) AS usd_discarded
FROM usage_log
WHERE ts >= :from AND outcome IN ('succeeded','canceled')
GROUP BY day, provider_id, model_id
ORDER BY day DESC, usd DESC;
```

Failures are excluded from both sums by construction: they are written with `cost_usd = 0` and `cost_source = 'unknown'` (§0.13). `usd_discarded` is the "Canceled but charged" line — work a provider may have charged for after a cancel, with no asset to show for it. It is reported beside the spend total, never folded into it silently.

**Library stats** (Settings → Storage): `SELECT COUNT(*), SUM(bytes) FROM assets WHERE deleted_at IS NULL;` plus a `thumbs/` directory walk cached for 60 s.

#### 8.2.3 Custom migrations

The FTS5 index can't be expressed in Drizzle, so it lives in `packages/db/migrations/0001_assets_fts.sql`. The file is created with `bun run db:generate --custom --name=assets_fts` and runs after the generated `0000_initial.sql`. Drizzle's migrator splits statements on `--> statement-breakpoint`, so each trigger is a single statement even with the semicolons inside it. drizzle-kit never diffs these objects, and that is why this project never uses `drizzle-kit push`. Push compares against the live database, would try to drop tables it doesn't know (the FTS5 shadow tables), and skips review.

```sql
CREATE VIRTUAL TABLE assets_fts USING fts5(
  prompt,
  model_id UNINDEXED,
  tags,
  content = 'assets',
  content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);
--> statement-breakpoint
CREATE TRIGGER assets_ai AFTER INSERT ON assets BEGIN
  INSERT INTO assets_fts(rowid, prompt, model_id, tags)
  VALUES (new.rowid, new.prompt, new.model_id, new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER assets_ad AFTER DELETE ON assets BEGIN
  INSERT INTO assets_fts(assets_fts, rowid, prompt, model_id, tags)
  VALUES ('delete', old.rowid, old.prompt, old.model_id, old.tags);
END;
--> statement-breakpoint
CREATE TRIGGER assets_au AFTER UPDATE OF prompt, model_id, tags ON assets BEGIN
  INSERT INTO assets_fts(assets_fts, rowid, prompt, model_id, tags)
  VALUES ('delete', old.rowid, old.prompt, old.model_id, old.tags);
  INSERT INTO assets_fts(rowid, prompt, model_id, tags)
  VALUES (new.rowid, new.prompt, new.model_id, new.tags);
END;
```

Soft delete fires no trigger and none is added (§0.7). The rebuild after a restore (§0.7, §8.6) runs at boot, not in a migration. Any later object Drizzle can't model (an index drizzle-kit can't emit exactly, per 8.2.1) goes in a new custom migration. A committed file is never edited.

#### 8.2.4 Migrations on boot

```ts
// packages/db/src/client.ts
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";
import { MigrationIntegrityError } from "./errors";

export function openDb(file: string) {
  const sqlite = new Database(file, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA synchronous = NORMAL");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });

  // Foreign keys stay OFF while migrations run: a drizzle-kit table rebuild drops and
  // re-creates a table, and with enforcement on, that DROP would cascade into child rows.
  sqlite.exec("PRAGMA foreign_keys = OFF");
  migrate(db, { migrationsFolder: join(import.meta.dir, "../migrations") });
  const violations = sqlite.query("PRAGMA foreign_key_check").all();
  if (violations.length > 0) throw new MigrationIntegrityError(violations);
  sqlite.exec("PRAGMA foreign_keys = ON");
  return db;
}
```

The server calls `openDb()` before anything else:
1. It sets the PRAGMAs, then applies every pending migration listed in `migrations/meta/_journal.json`, in order, inside one transaction. Drizzle records each applied file's hash in its `__drizzle_migrations` table.
2. If a migration fails, the whole batch rolls back and the server exits with the migration's name and the SQLite error. It never serves a half-migrated database.
3. `PRAGMA foreign_key_check` must return no rows before enforcement is switched back on.

Still before the HTTP listener accepts traffic, the server then runs the FTS rebuild if the db file was replaced (§0.7, §8.6), seeds built-in providers, presets and palettes where rows are missing, and runs crash recovery (§8.4.5). `GET /api/health` reports the tag of the newest applied migration as `schema`.

Rules:
- Every schema change is an edit under `packages/db/src/schema/` followed by `bun run db:generate`, committed together.
- A committed migration is never edited.
- There are no down migrations.

---
### 8.3 Local HTTP API

**§8.3 owns the HTTP surface.** Every other section references a path from this table and never restates one; where a draft named a different path (`/api/thumb/:assetId?w=`, `DELETE /api/jobs/:id`, `/api/export/zip`, `POST /api/jobs`, `/api/jobs/stream`, `/api/canvas/{id}` + `baseVersion`), this table is the correction (§0.6).

Bun + Hono, bound to `127.0.0.1` only (never `0.0.0.0`), default port `4317`, JSON in/out under `/api`, binary under `/files`. Single user, no auth — but a loopback server is reachable from any page the browser has open, so **four guards are mandatory, on every method including `GET`**:

- **Host check:** reject any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence).
- **No CORS.** The server never emits `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials` or `Timing-Allow-Origin` on any route, in any build, **including dev**.
- **Cross-site guard on every method.** Reject any request carrying `Sec-Fetch-Site: cross-site`, or `Sec-Fetch-Dest: image|script|style` on an `/api` path, and any request whose `Origin` header is not the app's own origin — **`GET`s included**. A `GET` is not safe here: `GET /files/thumb/:id` generates and writes a file on miss, and `GET /api/assets` is the entire prompt history.
- **Session token.** The server mints a random token at boot, injects it into `index.html`, and requires it as `X-Openfield-Session` on every `/api` and `/files` request. A page that cannot read our HTML cannot forge it. `SameSite` is irrelevant: we hold no cookies.

**Acceptance criterion.** A cross-origin page cannot list assets, read key status, or cause a thumbnail to be generated.

All provider traffic originates in this process, and outbound connections are restricted to the enabled adapters' `meta.networkHosts ∪ meta.assetHosts` (§0.6). **No provider key is ever serialised into a response body**; key endpoints return presence and a 4-character hint only.

| Method | Path | Purpose | Request → Response |
|---|---|---|---|
| `GET` | `/api/health` | Liveness, version and the newest applied migration | → `{ok, version, schema, home}`, where `schema` is the migration tag, e.g. `0001_assets_fts` (§8.2.4) |
| `GET` | `/api/providers` | Provider list with credential status | → `[{id, displayName, enabled, credentialSource, credentialHint, lastOkAt, lastError, concurrencyCap}]` |
| `PATCH` | `/api/providers/:id` | Enable/disable, per-provider cap (no custom address in v1, §6.18) | `{enabled?, concurrencyCap?}` → provider |
| `GET` | `/api/models` | Model registry + capability manifests (drives every chip in the composer, §3/§6) | `?provider=&modality=&refresh=0\|1` → `{models:[{providerId, modelId, displayName, family, badges, capabilities, pricing, source, updatedAt}], staleAt}` |
| `POST` | `/api/models/refresh` | Force runtime discovery per provider; falls back to shipped manifest | `{providerId?}` → `{added, updated, removed, errors:[]}` |
| `GET` | `/api/models/:providerId/:modelId` | One manifest (capability gating for a deep-linked model) | → model |
| `POST` | `/api/models/:providerId/:modelId/estimate` | Cost estimate for server-side callers and the canvas run-all preview | `{op, prompt, params, batch}` → `{min, max, confidence:'exact'\|'estimated'\|'unknown', basis:string, pricedAt}` — `CostEstimate` exactly (§0.13) |
| `POST` | `/api/generate` | Create a job set. `op: 'generate'` only. Returns **immediately** with N placeholder jobs | see 8.3.1 |
| `POST` | `/api/edit` | Create a job set for every other `Op` (§0.4), **same body type** as `/api/generate` | §6.5's `GenerateRequest` verbatim, with `op` ≠ `'generate'`, `base` as the source asset, `mask: {assetId, invert?, featherPx?}`, `batch` and flat params (§0.6, §0.9) → same shape as `/api/generate` (8.3.1) |
| `POST` | `/api/masks` | Upload a painted mask as an internal asset (`multipart/form-data`, PNG, must match the base asset's pixel dimensions) | → `{asset}` with `kind='mask'`, `mime='image/png'` |
| `GET` | `/api/job-sets` | Active or historical job sets | `?status=active\|all&cursor=&limit=` → `{items, nextCursor}` |
| `GET` | `/api/job-sets/:id` | One job set with its jobs and any produced assets | → `{jobSet, jobs:[], assets:[]}` |
| `POST` | `/api/job-sets/:id/cancel` | Cancel every non-terminal job in the set | → `{canceled:[jobId], notCancelable:[jobId]}` |
| `POST` | `/api/job-sets/:id/recreate` | **Recreate** (§0.1): replay the frozen `NormalizedRequest` in `request_json` as a new job set | → 202, same shape as `/api/generate` |
| `POST` | `/api/job-sets/:id/retry` | Re-submit after failure, reusing the same frozen request | `{onlyFailed?:bool}` → new job set |
| `POST` | `/api/jobs/:id/cancel` | Cancel one output | → `{ok}` |
| `GET` | `/api/events` | **SSE** stream of job/asset/registry events (§8.4.6) | `?since=<eventId>` → `text/event-stream` |
| `GET` | `/api/assets` | Feed / library listing | `?cursor=&limit=50&folder=&favourite=1&q=&model=&provider=&kind=&from=&to=&modality=image` → `{items:[{id,width,height,mime,sha256,modelId,createdAt,isFavourite,thumbUrl,fileUrl}], nextCursor}` |
| `GET` | `/api/assets/:id` | Detail payload for the dialog's Info tab | → `{asset, jobSet, params, references:[asset], lineage:{ancestors,children}, folders:[], isFavourite}` |
| `PATCH` | `/api/assets/:id` | Rename/tag/annotate | `{tags?, note?}` → asset |
| `DELETE` | `/api/assets/:id` | Soft delete to Trash | `?hard=1` for immediate purge → `{ok}` |
| `POST` | `/api/assets/:id/restore` | Undo a soft delete | → asset |
| `PUT`/`DELETE` | `/api/assets/:id/favourite` | Set/clear favourite | → `{isFavourite}` |
| `PUT`/`DELETE` | `/api/assets/:id/folders/:folderId` | Add to / remove from folder | → `{folders:[]}` |
| `POST` | `/api/assets/bulk` | Multi-select actions from the feed checkboxes | `{ids:[], action:'delete'\|'favourite'\|'unfavourite'\|'addFolder'\|'removeFolder'\|'download', folderId?}` → `{affected}` |
| `GET` | `/api/assets/:id/lineage` | Full graph for the lineage view | → `{nodes:[], edges:[]}` |
| `POST` | `/api/uploads` | Upload a reference image (`multipart/form-data`, accepts `.jpg .jpeg .png .webp .heic`; HEIC is transcoded to PNG on ingest) | → `{asset}` with `kind='uploaded'` |
| `GET` | `/api/assets/:id/export` | Download with embedded metadata (§8.5.4) | `?format=png\|webp\|jpeg&metadata=1&sidecar=0` → binary, `Content-Disposition: attachment` |
| `GET` | `/files/asset/:id` | Stream the original (range-capable, immutable cache) | → image bytes |
| `GET` | `/files/thumb/:id` | WebP thumb, generated on miss; server resolves to the nearest-or-larger rung (§0.10) | `?h=<200\|280\|360\|456\|640>&dpr=1\|2`, or `?p=1440` → image/webp |
| `GET`/`POST` | `/api/folders` | List / create | `{name, parentId?, color?}` → folder |
| `PATCH`/`DELETE` | `/api/folders/:id` | Rename, re-parent, delete (assets are not deleted) | → folder / `{ok}` |
| `GET`/`POST` | `/api/presets` | Style-preset library list / create. **No `?kind=`** — the four entities have four endpoints (§0.8) | `{name, description?, payload}` → preset |
| `PATCH`/`DELETE` | `/api/presets/:id` | Edit / delete (builtin presets are copy-on-edit) | → preset |
| `POST` | `/api/presets/import` | Import one object or a bundle (JSON body or multipart file); **routes by envelope `kind`** (`style`\|`reference-set`\|`character`\|`palette`); reference images arrive inlined base64 and are re-materialised as assets | `{items:[…]}` → `{imported, skipped, conflicts}` |
| `GET` | `/api/presets/:id/export` | Single preset as JSON | → `application/json`, attachment |
| `GET` | `/api/presets/export` | Whole library as one JSON bundle | → attachment |
| `GET`/`POST` | `/api/reference-sets` | Reference-set list / create | `{name, items:[{assetId, position, weight, role}]}` → set |
| `PATCH`/`DELETE` | `/api/reference-sets/:id` | Edit / delete | → set / `{ok}` |
| `GET`/`POST` | `/api/palettes` | Palette list / create (extract from an asset, or hex list) | `{name, hex[], sourceAssetId?, k?, mode}` → palette |
| `PATCH`/`DELETE` | `/api/palettes/:id` | Edit / delete | → palette / `{ok}` |
| `GET`/`POST` | `/api/prompts` | Saved prompts (§5.9) list / create | `{name, text, tags?, presetId?}` → prompt |
| `PATCH`/`DELETE` | `/api/prompts/:id` | Edit / delete | → prompt / `{ok}` |
| `GET`/`POST` | `/api/characters` | Character list / create | `{name, descriptor, referenceSetId?, seed?, lockSeed?, injection?, token?}` → character |
| `PATCH`/`DELETE` | `/api/characters/:id` | Edit / delete | → character |
| `GET`/`POST` | `/api/canvases` | Canvas index / create | → `[{id, name, previewUrl, updatedAt}]` |
| `GET` | `/api/canvases/:id` | Full graph | → `{id, name, graph, graphVersion, updatedAt}` |
| `PATCH` | `/api/canvases/:id` | Autosave. Optimistic concurrency on `graphVersion`; `409` returns the server graph | `{graph?, name?, graphVersion}` → `{graphVersion, updatedAt}` |
| `POST` | `/api/canvases/:id/duplicate` | Duplicate | → canvas |
| `DELETE` | `/api/canvases/:id` | Soft delete | → `{ok}` |
| `GET` | `/api/canvases/:id/versions` | Version history list | → `[{id, label, createdAt}]` |
| `POST` | `/api/canvases/:id/versions` | Snapshot now (also auto-snapshotted every 5 min of activity, keep last 50) | `{label?}` → version |
| `POST` | `/api/canvases/:id/versions/:vid/restore` | Restore, snapshotting current first | → canvas |
| `POST` | `/api/canvases/:id/run` | Run a compiled plan: one node, its downstream, the whole graph or a selection. Job sets carry `source='canvas'` and `canvas_run_id` | `{scope:'node'\|'downstream'\|'all'\|'selection', nodeIds, plan:[{nodeId, typeVersion, fingerprint, model, params, inputs}], dryRun?}` → `{runId, jobSets:[{nodeId, jobSetId}], skipped:[{nodeId, reason:'cached'}], estimate}` |
| `POST` | `/api/canvases/:id/runs/:runId/cancel` | Cancel a whole canvas run | → `{canceled:[jobSetId], notCancelable:[jobSetId]}` |
| `GET` | `/api/settings` | All UI/app settings | → `{defaultModel, defaultAspect, feedZoom, globalConcurrency, thumbQuality, trashRetentionDays, …}` |
| `PATCH` | `/api/settings` | Partial update | `{…}` → settings |
| `GET` | `/api/settings/keys` | Key **status** only | → `[{providerId, present, source:'env'\|'file', hint:'…a1b2'}]` |
| `PUT` | `/api/settings/keys/:providerId` | Save a key to `config.json` (0600) | `{apiKey}` or `{keyId, keySecret}` → `{present, source, hint}` |
| `DELETE` | `/api/settings/keys/:providerId` | Remove the stored key | → `{present:false}` |
| `POST` | `/api/settings/keys/:providerId/test` | Cheapest possible authenticated call | → `{ok, latencyMs, error?}` |
| `GET` | `/api/usage` | Usage/cost rollup | `?from=&to=&groupBy=day\|model\|provider` → `{rows:[], totalUsd, currency:'USD'}` |
| `GET` | `/api/usage/export.csv` | CSV of `usage_log` | → `text/csv` |
| `GET` | `/api/stats` | Counts + disk usage for Settings → Storage | → `{assets, bytes, thumbsBytes, dbBytes, trash:{count,bytes}}` |
| `POST` | `/api/maintenance/gc` | Orphan sweep (§8.6) | `{dryRun?:bool}` → `{orphanFiles, missingRows, staleThumbs, reclaimedBytes}` |
| `POST` | `/api/maintenance/backup` | `VACUUM INTO` snapshot (+ optional asset tar) | `{includeAssets?:bool}` → `{path, bytes}` |
| `POST` | `/api/maintenance/reindex` | Rebuild FTS (`INSERT INTO assets_fts(assets_fts) VALUES('rebuild')`) and/or regenerate thumbs | `{fts?:bool, thumbs?:bool}` → `{jobId}` |

The compiled run plan comes from the browser, which owns the DAG compiler, fingerprinting and dirty propagation; **ordering, concurrency, retry and crash recovery are the server's** (§0.12, §7.7). `canvas_runs` is what makes a run survive a reload.

Errors are uniform: HTTP status + `{error:{code, message, providerCode?, retryable:bool, docsUrl?}}`. A request that fails `zValidator` returns `400` with `code: 'bad_request'` (§8.3.3). The transport codes are a small, separate set — `bad_request`, `not_found`, `conflict`, `internal` — **plus any `ErrorCode` from §0.5** when the failure originated in a provider call. Provider-shaped names do not get a second spelling here: `missing_credential`, `provider_auth`, `provider_rate_limit`, `content_policy`, `capability_unsupported`, `disk_full`, `timeout` and `canceled` are §0.5 `ErrorCode`s, not HTTP codes. US `canceled` throughout, in enums and in UI copy.

#### 8.3.1 `POST /api/generate` — the shape that matters

The composer must be able to submit again while a run is in flight (the Generate button is never disabled, and prompt/settings are never cleared — §3), so this endpoint returns before any provider call is made.

**The request body is §6.5's `GenerateRequest`** — flat and typed, with `model: ModelKey` (one colon-separated address, never a `providerId`/`modelId` split), `size: SizeSpec` and `references: ReferenceInput[]`. `POST /api/generate` accepts `op: 'generate'` only; `POST /api/edit` accepts every other `Op` (§0.4) with the **same body type**. The fields this endpoint adds to the §6.5 type are `idempotencyKey`, `characterId`, `presetStrength`, `referenceSetId`, `paletteId`, `source` and `canvas` — all declared with the type in §6.5, all optional except `idempotencyKey` and `source`. A duplicate `idempotencyKey` returns the existing job set rather than creating a second one.

Three fields are deliberately absent from the wire and filled by `normalize()` on the server: the resolved pixel `width`/`height` (from `size` × the manifest), the per-output `seed` (only when `capabilities.seed.supported`, §0.11), and `paramsHash`. Nothing about a run is inferred from the client's state.

```jsonc
// 202 Accepted — placeholders can be rendered on this alone
{
  "jobSet": {
    "id": "01K6BQ8…", "status": "pending", "batchSize": 2,
    "model": "google:gemini-3-pro-image",
    "costEstimateUsd": 0.268, "createdAt": "2026-09-23T12:44:01.882Z"
  },
  "jobs": [
    {"id":"01K6BQ8…A","idx":0,"status":"pending","width":1536,"height":2048},
    {"id":"01K6BQ8…B","idx":1,"status":"pending","width":1536,"height":2048}
  ]
}
```

Width/height in the response is what lets the feed prepend N correctly-proportioned placeholder tiles instantly, with no layout shift when the real image lands. `POST /api/job-sets/:id/recreate` returns this same shape.

#### 8.3.2 SSE event stream

```
GET /api/events            Accept: text/event-stream
```

```
: openfield stream
event: snapshot
id: 1042
data: {"activeJobSets":[{"id":"01K6BQ8…","status":"running","jobs":[…]}],"serverTime":"…"}

event: job.started
id: 1043
data: {"jobSetId":"01K6BQ8…","jobId":"01K6BQ8…A","idx":0,"startedAt":"…"}

event: job.progress
id: 1044
data: {"jobId":"01K6BQ8…A","progress":0.4}

event: job.partial
id: 1045
data: {"jobId":"01K6BQ8…A","index":0,"partialIndex":1,"thumbUrl":"/files/thumb/tmp-01K6…?h=456","width":1536,"height":2048}

event: job.output
id: 1046
data: {"jobId":"01K6BQ8…A","asset":{"id":"01K6BR…","width":1536,"height":2048,"thumbUrl":"/files/thumb/01K6BR…?h=456","mime":"image/png"}}

event: job_set.completed
id: 1047
data: {"jobSetId":"01K6BQ8…","status":"succeeded","costActualUsd":0.268,"durationMs":17420}
```

Event types (§0.6): `snapshot`, `job_set.created`, `job.queued`, `job.started`, `job.progress`, **`job.partial`**, `job.output`, `job.failed`, `job.canceled`, `job_set.completed`, `asset.updated`, `asset.deleted`, `folder.updated`, `models.updated`, `usage.updated`, **`canvas_run.updated`**, `maintenance.progress`.

**Partial frames are written to `tmp/` and served from a volatile thumb path; they are never inserted into `assets`, and each is superseded by the final `job.output`.** This event is what terminates `ImageModel.stream?()` and `capabilities.streaming.partialImages`; without it §6.14's streaming declaration and §7.5's streamed node previews have no wire representation. `canvas_run.updated` carries `{runId, canvasId, status, nodes:[{nodeId, state}]}` and is what lets a reloaded canvas re-attach to a run in flight.

Every event carries a monotonically increasing `id`; on reconnect the browser's `EventSource` sends `Last-Event-ID` and the server replies with a fresh `snapshot` rather than a replay log — active state is small and always derivable from the db, so there is nothing to keep an event table for.

#### 8.3.3 Typed client and validation

Every JSON route in the table above is typed end to end with Hono RPC (§0.16). The wire stays the same, so every route can still be called with curl.

- **Validation.** Each route validates its `json`, `query`, `param` and `form` inputs with `@hono/zod-validator`, against a schema from `packages/core/src/schemas/`. A failed validation returns `400` with the §8.3 error envelope, `code: 'bad_request'`, and the first failing field path in `message`. Handlers read only `c.req.valid(...)`, never the raw body.
- **Composition.** Each resource is a Hono sub-app in `apps/server/src/routes/<resource>.ts`, built by method chaining so its types flow. `apps/server/src/app.ts` mounts the four guards first, then `/api` and `/files`, and exports `type AppType = typeof app`. `apps/server/src/app-type.ts` re-exports only that type.
- **Responses.** Handlers return `c.json(value satisfies <CoreType>, status)`. The status is part of the inferred type, so the client narrows on `res.status`. Route tests parse every response with its core schema.
- **Client.** `apps/web/src/api/client.ts` creates `hc<AppType>("/", { headers: { "X-Openfield-Session": token } })`. It reads the token from the `<meta name="openfield-session">` tag the server injects into `index.html`. TanStack Query hooks in `apps/web/src/api/hooks/` wrap it, and no component calls `fetch` for a JSON route.
- **Plain HTTP, by design.** These routes stay plain HTTP:
  - binary uploads: `POST /api/uploads`, `POST /api/masks`, and the multipart form of `POST /api/presets/import`;
  - file serving: `/files/asset/:id`, `/files/thumb/:id`;
  - downloads: `GET /api/assets/:id/export`, the preset exports, `GET /api/usage/export.csv`, and `POST /api/assets/bulk` with `action: 'download'`, which returns a zip;
  - the SSE stream: `GET /api/events`.
  They are ordinary Hono routes, validated the same way. The browser reaches them through `<img src>`, download links, `FormData` posts and the event-stream client in `apps/web/src/api/raw.ts`. JSON replies from these routes (the `{asset}` of an upload) are parsed with their core schema. Every SSE frame is parsed with `sseEventSchema`, a discriminated union on the event name.
- **Type-check cost.** If `AppType` makes editor type-checking slow, the server exports one type per resource group and the web app creates one `hc` client per group. Routes and paths don't change.

```ts
// apps/server/src/routes/generate.ts
export const generateRoutes = new Hono<Env>()
  .post("/generate", zValidator("json", generateRequestSchema, onInvalid), async (c) => {
    const accepted = await c.var.runner.createJobSet(c.req.valid("json"));
    return c.json(accepted satisfies JobSetAccepted, 202);
  });

// apps/web/src/api/hooks/use-generate.ts
const res = await api.api.generate.$post({ json: request });
if (res.status === 202) return res.json();          // typed as JobSetAccepted
```

---

### 8.4 Job queue and concurrency

The queue is an in-process scheduler in the Bun server with SQLite as its durable state. No Redis, no worker process, no broker — a single-user local app does not earn that complexity, and the cost of a crash is bounded (§8.4.5).

#### 8.4.1 Model

One `POST /api/generate` writes one `job_sets` row (with its frozen `request_json`) and `batchSize` `jobs` rows in a single transaction, all `pending`, then returns. A scheduler tick (on submit, on any job transition, and on a 1 s heartbeat) picks the next runnable jobs.

Fan-out is adapter-decided: if the model's manifest declares **`batch.native === true`** (OpenAI `n`, Higgsfield `batch_size`), the adapter makes **one** provider call and maps its outputs onto the N `jobs` rows in `idx` order; otherwise the scheduler issues N independent calls, one per job row, each with its own seed where seeds are supported. Either way the UI sees N jobs and N placeholder tiles — the wire behaviour is an adapter detail.

#### 8.4.2 Concurrency and fairness

**§8.4.2 owns these numbers; §3.6, §6.7 and §7.7 cross-reference them and state none of their own (§0.12).**

**Precedence, stated once:** effective per-provider cap = `min(providers.concurrency_cap, capabilities.limits.maxConcurrent)`; global cap = `settings.globalConcurrency`, default **4**.

| Setting | Default | Notes |
|---|---|---|
| `globalConcurrency` | 4 | Total in-flight provider calls across all providers |
| `providers.openai.concurrency_cap` | 2 | Complex prompts can run ~2 min; queueing beats hammering |
| `providers.google.concurrency_cap` | 4 | Fast (3–4 s/image per research) and comfortable in parallel |
| `providers.higgsfield.concurrency_cap` | 2 | Rate limits undocumented — conservative default |
| `providers.fal.concurrency_cap` (v1.1) | 4 | Provider queue absorbs bursts |
| `providers.replicate.concurrency_cap` (v1.1) | 4 | 600 creates/min documented; far above our ceiling |
| `attemptTimeoutMs` | from `capabilities.limits.requestTimeoutMs` (default 120 000 generate, 300 000 upscale) | **Per attempt** |
| `jobDeadlineMs` | 900 000 | Whole-job wall clock across all attempts |
| `maxAttempts` | 3 | Attempt 1 + 2 retries |

A single per-job wall clock of 180 s does not compose with a 150 s per-attempt timeout — it makes `maxAttempts: 3` unreachable — so the two are separated: the attempt timeout comes from the manifest, the whole-job deadline is 15 minutes.

**Selection order is `job_sets.priority DESC`, then `job_sets.created_at`, then `jobs.idx`**, with **round-robin across providers** at each tick so a capped provider cannot block a free one: if the head of the queue is an OpenAI job and OpenAI is at cap, the scheduler skips to the first runnable job of another provider rather than blocking. Composer runs and single-node canvas runs enqueue at priority **10**; canvas run-downstream and run-all enqueue at **5**, so a 30-node batch cannot starve a user who just pressed Generate. Canvas runs otherwise share the same caps and queue as the composer — a single global budget, one place to reason about spend.

#### 8.4.3 Retries and failures

Retry only on the four `retryable` codes of §0.5 — `network`, `timeout`, `rate_limited`, `provider_unavailable` (HTTP 408/425/429/500/502/503/504, network timeouts, aborted sockets, provider queue errors). Everything else fails immediately and is shown to the user with §0.5's copy for its code; the provider's own message goes to the Error log.

Backoff is exponential with full jitter: 1 s, 4 s, 15 s (±20 %). A `Retry-After` header always wins over the computed delay. `jobs.attempt` and `jobs.next_attempt_at` persist the schedule so a restart mid-backoff resumes correctly; `jobs.idempotency_key` is reused on every attempt, so a retry can never bill twice. When some jobs in a set succeed and others exhaust retries, the set lands in `partial`, the feed shows the successful tiles plus an inline error tile per failure with a one-click **Try again** that calls `POST /api/job-sets/:id/retry {onlyFailed:true}`.

Every terminal outcome — success, failure, cancel — writes a `usage_log` row. **A failed job writes a row with `cost_usd = 0` and `cost_source = 'unknown'`; no cost is ever added to a spend total for a failure** (§0.13). A job canceled after submit writes a row at full estimate with `discarded = 1`, which is what the Usage screen's "Canceled but charged" line sums.

#### 8.4.4 Cancellation

`POST /api/job-sets/:id/cancel`, `POST /api/jobs/:id/cancel` (what the "Cancel" pill on a placeholder tile calls) and `POST /api/canvases/:id/runs/:runId/cancel` all take the same four steps:

1. Mark still-`pending`/`queued` jobs `canceled` synchronously — nothing was spent.
2. For in-flight jobs, fire the `AbortController` for the outbound fetch.
3. If the adapter implements `cancel()`, call it and mark `canceled` on acknowledgement.
4. If it does not, mark `canceled`, stop polling, discard any late result, and write a `usage_log` row at **full estimate with `discarded = 1`**.

**Neither launch adapter implements provider-side `cancel()`**, so step 4 is the path every v1 cancellation takes: the provider may complete and bill the work, and no asset is produced. The copy is the same on the tile, the canvas node band and the toast, verbatim: *"Canceled. You may still be charged for work that already started."* We do not imply a refund we cannot deliver.

#### 8.4.5 Crash recovery

On boot, after `openDb()` has applied migrations (§8.2.4), the recovery pass runs before the HTTP listener accepts traffic:

| State found | Action |
|---|---|
| `jobs.status IN ('pending','queued')` | Re-enqueue as-is |
| `status IN ('submitting','running')` **with** `provider_job_id` **and** adapter supports status polling | Resume a watcher from the provider's status endpoint; the run is not re-billed |
| `status IN ('submitting','running')` **without** a `provider_job_id`, or adapter is fire-and-forget | Mark `interrupted`; the job set shows "Interrupted." with a one-click **Try again**. Never auto-resubmit: that risks double-billing |
| `canvas_runs` with a non-terminal status | Recompute from its job sets; emit `canvas_run.updated` so a reopened canvas re-attaches |
| `job_sets` with all jobs terminal but a non-terminal set status | Recompute set status from its jobs |
| Asset rows whose file is absent | `file_state='missing'`; tile renders a broken-file state reading "File missing." with **Locate** and **Delete** |

A `startup.recovery` line is written to `logs/jobs.ndjson` with the counts, and a `snapshot` event reflects the result to the first client that connects.

#### 8.4.6 SSE, not polling — and why

Higgsfield polls (`POST /fnf/jobs/status-batch` plus `GET /fnf/jobs/{id}`), which is the correct choice for a multi-tenant service behind CDNs and load balancers. We are a single process on loopback talking to one browser tab, so none of the reasons to poll apply and all of the costs do: at a 1 s interval a 20 s generation costs 20 round trips, 20 db reads and a visible latency floor on every state change.

We use **one Server-Sent Events stream**, `GET /api/events`, for these reasons:

- Traffic is strictly server→client (every user action already has a REST endpoint), so the bidirectionality of WebSockets buys nothing.
- `EventSource` reconnects automatically with backoff and `Last-Event-ID`; a WebSocket client means hand-rolling that.
- No protocol upgrade, no ping/pong keepalive design, no framing — a Hono handler returning a `ReadableStream` is the whole implementation.
- On loopback there is no proxy buffering, the classic SSE failure mode.

**Fallback.** If `EventSource` fails to connect twice in a row, or the stream errors, the client degrades to polling `GET /api/job-sets?status=active` every 2 s and shows a subtle "Reconnecting…" indicator. A backgrounded tab keeps the stream open (SSE is cheap when idle) but throttles thumbnail decoding, not the stream.

**Acceptance criteria.** (a) With the stream connected, a completed image appears in the feed within 250 ms of the server writing its asset row. (b) Killing and restarting the server mid-generation leaves the UI reconnected and correct within 5 s, with no duplicate tiles. (c) Ten queued job sets produce no more than `globalConcurrency` simultaneous outbound provider requests, verified in the request log.

---

### 8.5 Thumbnails and the image pipeline

The reference product serves every feed image through a resizing proxy. Our local equivalent is a thumbnail service backed by a content-addressed cache.

#### 8.5.1 Ingest

**One path for every byte that enters Openfield** — provider output and user upload alike:

1. Stream the bytes (URL or base64) to `tmp/<ulid>.part`.
2. Hash while streaming (`sha256`), probe dimensions and real MIME from the magic bytes — never trust the declared type. `.heic` uploads are transcoded to PNG here, and only here.
3. If the hash already exists on a live asset, keep the existing file and record the new asset against it, noting the duplicate; otherwise `rename()` into `assets/YYYY/MM/DD/<ulid>.<ext>` or `uploads/YYYY/MM/DD/<ulid>.<ext>` (same filesystem, so atomic).
4. Insert the `assets` row — with `parent_asset_id`, `root_asset_id`, `op` and `op_params` — inside the same transaction that flips the job to `succeeded`.
5. Enqueue thumbnail generation at the feed's current rung; emit `job.output`.

**Originals are stored exactly as returned — no re-encode, no strip, no EXIF removal.** Metadata is added only on export (§8.5.4), so the library is always provenance-faithful and Google's SynthID watermark survives untouched, which is what makes `capabilities.safety.notices` an honest claim rather than a hopeful one. The editor's 2048 px-long-edge WebP working copy lives in the thumb cache, never in place.

#### 8.5.2 Thumbnail ladder

**§8.5.2 owns the ladder (§0.10).** The feed is justified rows whose target row height is set by the 5-step zoom slider (steps 0–4, default 3); step 3 ≈ 456 px is the one measured value. Thumb rungs are the same five numbers as the target heights — one ladder, not two:

| Zoom step | Target row height (CSS px) | Thumb rung | Approx. cols @1424 px content |
|---|---|---|---|
| 0 Contact sheet | 200 | `@h200` | 8–9 |
| 1 Small | 280 | `@h280` | 6–7 |
| 2 Medium | 360 | `@h360` | 5 |
| 3 **Large (default)** | **456** | `@h456` | **4** |
| 4 Showcase | 640 | `@h640` | 3 |
| — (detail dialog) | long edge 1440 | `@p1440` | — |

Height-keyed, never width-keyed: a justified-rows layout solves for row height, so a width ladder would miss every rung. `srcset` spans `@h200,@h280,@h360,@h456,@h640` plus a `dpr=2` variant per rung, capped at the original's dimensions. Canvas node thumbnails request the smallest rung ≥ 2× their rendered box. The client requests `/files/thumb/:id?h=456&dpr=2`; the server resolves to the **nearest-or-larger rung**, so arbitrary query values can never explode the cache.

**Encoder:** `sharp` (libvips) only, loaded once at boot. WebP `quality 82`, `effort 4`, metadata stripped, `fit: inside`. Generation is CPU-bounded to `max(1, cores − 2)` workers so a large backfill never makes the UI stutter.

**Fallback when `sharp` can't load.** A local-first app must not fail `bun install` or the boot because of a native addon, so a failed load turns thumbnails off instead. `GET /files/thumb/:id` then streams the original with `Cache-Control: no-cache` (never `immutable`, so real thumbnails take over once `sharp` loads), and Settings → Storage says "Thumbnails are off. Images show at full size, so scrolling may be slower." The feed stays correct, only heavier. There is no WASM chain.

#### 8.5.3 Serving

- `GET /files/thumb/:id?h=456&dpr=2` → looks up `thumbs/<sha[0:2]>/<sha>@h456@2x.webp`; on miss, generates it under a single-flight lock keyed by `sha@h@dpr` (no stampede when 40 tiles scroll into view at once), writes it, then streams it.
- `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<sha>@h456"`. Because the key is a content hash, a re-edited image is a different asset with a different hash — cache invalidation never arises.
- `GET /files/asset/:id` streams the original with range support (needed for the detail dialog's fullscreen view and for future video).
- Both endpoints 404 on soft-deleted assets unless `?trash=1`.

**Acceptance criteria.** Cold library of 5 000 images: first paint of the feed's first row under 400 ms; scrolling 2 000 tiles keeps renderer memory under 700 MB with the virtualiser's window at ±2 screens (§2.3); a thumb cache wipe followed by a full scroll regenerates without a single failed tile.

#### 8.5.4 Export and embedded metadata

`GET /api/assets/:id/export?format=png&metadata=1` writes the generation record into the file itself, so an exported image carries its own recipe:

| Format | Mechanism | Keys |
|---|---|---|
| PNG | `tEXt`/`iTXt` chunks | `openfield:prompt`, `openfield:negative_prompt`, `openfield:model`, `openfield:provider`, `openfield:seed`, `openfield:params` (JSON), `openfield:created_at`, `Software` = `Openfield <version>`, plus a legacy `parameters` chunk in the widely-read `prompt / Negative prompt: / Steps:, Seed:, Model:` shape for interop with existing tooling |
| WebP | XMP packet + EXIF `UserComment` | Same fields under an `openfield` XMP namespace |
| JPEG | EXIF `UserComment` + XMP | Same |

**How the chunks are actually written.** `sharp` cannot write arbitrary PNG `tEXt`/`iTXt` chunks, so PNG text is written by a small in-repo chunk writer (`png-chunks-extract` / `png-chunk-text` class, MIT) applied to the **encoded buffer after** the encoder. EXIF/XMP for JPEG and WebP use `exiftool-vendored` or the same post-encode approach; **the library is chosen in `M2-13a`, and that spike is blocking** — the legacy `parameters` chunk is the single most load-bearing interop claim in this section and it does not ship on a promise.

**Re-encode warning.** Any export whose `format` differs from `assets.mime` shows: *"Changing the format may remove the hidden AI watermark."* The stored original is never touched (§8.5.1).

`?sidecar=1` additionally writes `<name>.json` with the full asset record including lineage — the lossless option, and the one bulk downloads use (a ZIP of images + one `manifest.json`). On upload, Openfield reads these same fields back and offers "Use this image's settings" in the composer (M3).

C2PA signing is explicitly out of scope for v1 — noted as a v1.1 candidate, not a promise.

---

### 8.6 Filesystem hygiene

**Deletes.** `DELETE /api/assets/:id` is a soft delete: `deleted_at` is set, the asset leaves every feed, files stay. **The FTS row is retained** — no trigger fires on `deleted_at` and none is added; every query filters `deleted_at IS NULL`, and hard delete removes the FTS row via the `assets_ad` trigger. A Trash view lists soft-deleted assets. The trash never empties itself by default: purge happens on the user's command (Empty trash, or delete from the Trash view). Only when the person sets `trashRetentionDays` (default `null` = never) does a purge pass run, at boot and once a day, hard-deleting assets whose `deleted_at` is older than that many days. Hard delete removes the original file, every `thumbs/<sha>@*` entry **whose hash no longer has a live asset**, and the row (cascading `asset_folders`, `favourites`, and `asset_edges` on `child_asset_id` only). Deleting a parent never deletes its children: `assets.parent_asset_id` and `asset_edges.parent_asset_id` carry **no foreign key**, so the pointer survives as a tombstone and the lineage view renders "deleted image" instead of losing the chain.

**Orphan GC** (`POST /api/maintenance/gc`, dry-run by default, also offered on startup if >7 days since the last sweep):

1. **Files without rows** — anything under `assets/` or `uploads/` with no matching `assets.path`. Moved to `tmp/orphans/` with a manifest, deleted after 7 days. Never deleted in place, because a failed migration must be recoverable.
2. **Rows without files** — `file_state='missing'`, surfaced in the UI rather than silently dropped.
3. **Stale thumbs** — `thumbs/` entries whose `sha256` has no live asset; deleted immediately (fully regenerable).
4. **Dangling references** — canvas nodes and presets pointing at deleted assets keep their id and render a placeholder; GC reports the count.
5. **Version pruning** — `canvas_versions` beyond the newest 50 per canvas.

**Backup and the FTS rebuild.** `POST /api/maintenance/backup` runs `VACUUM INTO 'backups/openfield-<ISO>.db'`, which is consistent under concurrent writes and needs no downtime, optionally followed by a tar of `assets/` + `uploads/` + `presets/`. Because thumbs are derived, backups never include them.

`assets` has a TEXT primary key and therefore an **implicit rowid that `VACUUM` may renumber**, so `VACUUM INTO` can produce a backup whose `assets_fts` docids no longer match its `assets` rows — a silently corrupt search index behind a documented restore. Restore is therefore defined as: *stop the server, replace `~/.openfield`, start* — and on boot, **before the HTTP listener accepts traffic**, the server runs `INSERT INTO assets_fts(assets_fts) VALUES('rebuild')` whenever the db file's inode/mtime indicates it was replaced. `POST /api/maintenance/reindex {fts:true}` runs the same rebuild on demand.

**Portability.** All stored paths are relative, filenames are ULIDs (no colons, no case collisions, no user text, safe on APFS/NTFS/ext4), and `config.json` is the only file with machine-specific content. Copying `~/.openfield` between machines or OSes is a supported, tested operation, covered by a test that opens a fixture home from a different path and asserts every asset resolves.

**Disk awareness.** `GET /api/stats` powers a Settings → Storage panel (asset count, bytes, thumb cache size, db size, trash size) with "Clear thumbnail cache" and "Empty trash" actions. A `disk_full` write error fails the job cleanly with a specific error code rather than corrupting the db — WAL mode plus `busy_timeout` handles the rest.

---

### 8.7 Delivery plan

Five milestones. Each is independently demoable and ends with a working app; nothing is "integrated later". Tasks are ordered and sized to become GitHub issues verbatim.

#### M0 — Skeleton, settings, one adapter end-to-end

**Definition of done:** `git clone && bun install && bun dev` opens the app on `127.0.0.1:4317`; the user pastes a Google API key into Settings, types a prompt, clicks Generate, and one image lands on disk under `~/.openfield/assets/…` with a row in SQLite and a thumbnail in the feed. No mocks anywhere in that path: the fixture-backed fetch behind `OPENFIELD_FAKE_PROVIDERS=1` is for e2e (`M0-15`), not for this demo.

1. `M0-01` Monorepo scaffold per §0.16: Bun workspaces `apps/web`, `apps/server`, `packages/core`, `packages/providers`, `packages/db`, `packages/ui`; root scripts (`bun dev`, `bun run build`, `bun start`, `bun run db:generate`, `bun test`, `bun run lint`, `bun run e2e`); `tsconfig.base.json` strict; Biome with the §0.16 import rules as per-folder `noRestrictedImports`; the CI bundle check that fails if `apps/web` ships `packages/db`, `@openfield/providers/server`, an adapter or a `bun:` module; MIT `LICENSE` (copyright "Openfield contributors"), `README`.
2. `M0-02` Hono server with all four §8.3 guards (Host allowlist, no-CORS assertion, cross-site guard on every method, boot-minted `X-Openfield-Session` token), `/api/health`, graceful shutdown. Also: `@hono/zod-validator` wired with the shared `bad_request` hook, `apps/server/src/app.ts` exporting `type AppType`, and the dev proxy to Vite with session-token injection, so dev and production share one origin (§0.16, §8.3.3). A CI test asserts a cross-origin page cannot list assets, read key status or cause a thumbnail to be generated.
3. `M0-03` `OPENFIELD_HOME` resolution, directory bootstrap, `config.json` read/write at 0600 (verify mode on every write), env-var override layer.
4. `M0-04` Database per §8.2: the Drizzle schema for every table in `packages/db/src/schema/`, the core enum constants behind every CHECK, `drizzle.config.ts`, the generated `0000_initial.sql` and custom `0001_assets_fts.sql` committed, `openDb()` with PRAGMAs and migrate-on-boot (foreign keys off during migration, `foreign_key_check` after), drizzle-zod row schemas in `src/rows.ts`, and `packages/db/test/schema.test.ts` comparing the migrated database with §8.2.1. Any index drizzle-kit can't emit exactly moves to a custom migration here.
5. `M0-05` Provider/credential service: status-only key API, `PUT/DELETE /api/settings/keys/:id`, `POST …/test`, redaction filter applied to every log sink.
6. `M0-06` Shared contracts per §0.16 and §6: zod schemas in `packages/core/src/schemas/` for the manifest, `GenerateRequest`/`NormalizedRequest`, errors, cost, SSE events and settings; the behaviour interfaces in `packages/providers/src/types/`; the `@openfield/providers/manifest` entry with the pure `estimate()` and `resolveControl()`; the `@openfield/providers/server` entry with the registry.
7. `M0-07` Google Gemini image adapter: submit, poll/await, map outputs, map errors to our codes, model discovery with shipped-manifest fallback.
8. `M0-08` Model registry service + `GET /api/models`, `POST /api/models/refresh`, staleness TTL 24 h.
9. `M0-09` Job queue v1: job set/job creation, global + per-provider caps, retry with backoff, timeouts.
10. `M0-10` Ingest pipeline: stream, hash, probe, place, insert, emit.
11. `M0-11` SSE `/api/events` + client `EventSource` hook with polling fallback.
12. `M0-11a` Typed client (§8.3.3): `apps/web/src/api/client.ts` (`hc<AppType>` with the session header), the TanStack Query provider and the first hooks (`models`, `assets`, `generate`, `settings`), the raw-HTTP helpers, and SSE frame parsing with `sseEventSchema`. A type test proves that renaming a field in a core response schema breaks `bun run build` in `apps/web`.
13. `M0-12` Vite + React SPA in `apps/web`, with Tailwind and shadcn/ui primitives in `packages/ui`, the `--of-*` tokens (§2.2) as the Tailwind theme, Openfield branding (§2/§3), dark and light themes (§2.2), `>=1280px` layout.
14. `M0-13` Minimal composer (prompt + model select + Generate) and a plain grid feed.
15. `M0-14` Thumbnail service on `sharp`, loaded once at boot: `@h456` + `dpr=2`, `/files/thumb/:id?h=&dpr=`, single-flight on `sha@h@dpr`. If `sharp` fails to load, thumbnails are off, the route serves the original (§8.5.2), and Settings → Storage says so.
16. `M0-15` E2E smoke test (Playwright) driving key entry → generate → asset visible, run with `OPENFIELD_FAKE_PROVIDERS=1` so every adapter call goes through a fixture-backed `ctx.fetch` (§6.12) and no key or network is needed.
17. `M0-16` **First run (§2.10)**: launch → no-key empty state → Keys → paste key → Check key → default model auto-selected → composer focused. This exact path is the G5/S1 gate.
18. `M0-17` **Settings shell (§6.17)**: left-rail IA — API keys · Models · Defaults · Appearance · Storage · Spending · Privacy · Help · Experimental — with the settings-key table wired to `GET/PATCH /api/settings`. Screens fill in across M1–M3; the IA lands here because eleven sections write requirements into it. Per §0.15 a pane joins the rail once something on it works: Experimental's switches (`showExperimental`, `canvasFileWriteThrough`) change nothing until M3-16 and M4, so the pane appears with them.

#### M1 — Feed and composer parity

**Definition of done:** the Image tab matches the observed layout's geometry in our own branding: justified-row virtualised feed on the §0.10 ladder with 2 px gaps, the floating composer at 1116×142 with capability-driven chips, model picker with search and **Recent / by company / Needs a key** sections, batch stepper 1–4, placeholders with correct aspect ratio and a working Cancel, tile hover overlay with multi-select, and the local prompt enhancer (disabled with a reason when no text-capable key is configured). Two providers are live (Google + OpenAI).

1. `M1-01` OpenAI GPT Image adapter (generate + `n` fan-in, quality/size/background/format params, token-cost estimation).
2. `M1-02` Capability-driven chip renderer: the composer builds its chip row from the manifest, hiding or disabling what a model cannot do (§3.5, §0.3).
3. `M1-03` Chip popovers: aspect ratio (proportional glyph rows, per-model lists), quality, resolution, background, prompt-enhance toggle — anchored above the chip, check on selected.
4. `M1-04` Model picker popover: 402×642, search, **Recent / by company / Needs a key** sections (§3.4.1 — not the reference product's editorial Featured/All), 56 px rows, provider icon, capability-derived badges, selected state; deep link `?model=<providerId>:<modelId>`.
5. `M1-05` Batch stepper (1–4, decrement disabled at 1) and Generate button whose USD sub-label is computed **locally from the manifest** by the pure `estimate()` of §0.13 — no HTTP round-trip per stepper click — upgrading in place if `estimateRemote()` resolves.
6. `M1-06` Prompt editor: multi-line, max-height 112 px then scroll, `⌘/Ctrl+Enter` to submit, attach button accepting `.jpg .jpeg .png .webp .heic`.
7. `M1-07` `POST /api/uploads` + reference-image thumbnail strip in the composer.
8. `M1-08` Feed virtualiser: justified-row layout solver (target height per zoom step, 2 px gaps, aspect from db), windowed rendering, no scroll jump on tile swap.
9. `M1-09` Zoom slider (5 steps, default 3) persisted to `settings`.
10. `M1-10` Placeholder tiles: prepend N on submit with reserved aspect, "Generating" pill, Cancel pill, in-place swap on completion.
11. `M1-11` Tile hover overlay: favourite, download, **Recreate**, more-actions menu (Open · Reuse · Use as reference · Add to folder · Download · Delete); always-present 16 px checkbox with shift-range multi-select and a bulk action bar. The three iteration actions are exactly §0.1's, with no fourth name.
12. `M1-12` `/api/assets` cursor pagination (`limit=50`) + infinite scroll; `GET /api/job-sets?status=active` fallback path.
13. `M1-13` Composer state persistence (prompt and settings survive submit and reload — never cleared).
14. `M1-14` Error surfaces: the §0.5 `ErrorCode` → tile-copy table, inline on the failed tile plus a toast, each card linking to the Error log.
15. `M1-15` Layout regression test: measured `getBoundingClientRect` assertions for composer 1116×142, chip heights 40, tile gaps 2, at 1280/1440/1920.
16. `M1-16` **Prompt-enhance service (§3.4.3)**: text-model registry entry, server-side rewrite endpoint, diff sheet, preview/automatic modes, `job_sets.prompt_original` persistence, separate usage-log line. Off by default; the chip is disabled with "Add an OpenAI or Google key to use this" when no text-capable key exists.
17. `M1-17` **`@`-mention typeahead** over Openfield presets, characters, reference sets and saved references, with `/` snippets, and server-side token resolution in `normalize()` (§3.2, §5.7). The reference product's server-side Elements entity is not reproduced.
18. `M1-18` **i18n readiness (§2.12)**: every user-facing string in one catalogue, `packages/core/src/i18n/en.json`, read through `t()`, with no concatenation; dates and numbers through `Intl.DateTimeFormat`/`Intl.NumberFormat`; `currency` typed `string` with USD the only v1 value. English only ships.
19. `M1-19` **Accessibility gate (§2.11)**, running from here to release: CI contrast check over the §2.2 token pairs against WCAG 2.2 AA, a keyboard path to every action on every surface, `aria-live="polite"` job announcements, reduced-motion coverage. The editor and canvas panes are explicitly and reasonedly out of scope for screen-reader parity.

#### M2 — Detail view and editor

**Definition of done** (§0.14, written to be falsifiable): Edit performs whole-image instruction edit on both launch providers; masked inpaint and mask-synthesised outpaint on OpenAI GPT Image **once `M2-15` confirms polarity**; the §0.9 regional fallback on Gemini with the Approximate badge; Upscale ships as **local Lanczos ×2/×4 only**, labelled *"Resizes, adds no detail"*; Remove background renders disabled with its reason. No launch adapter declares `ops.upscale` or `ops.removeBackground`, so **a disabled row with correct copy is the pass condition for M2-08 and M2-09** — not a capability we cannot buy. Clicking a tile opens the detail dialog with blurred backdrop, arrow-key navigation and Info · Edit · History tabs, with a working version strip and lineage.

1. `M2-01` Detail dialog shell: 352 px right panel, blurred/scaled backdrop, ←/→ navigation through the current feed query, Esc to close, "last viewed" marker on return.
2. `M2-02` Info tab: PROMPT block with copy, reference thumbnail row (72 px, primary highlighted), clamped prompt with See all/Hide, collapsible DETAILS rows (model, quality, size, created).
3. `M2-03` Footer actions: primary pair **`Recreate | Use as reference`** (2 × 155×40); Download, Favourite, Share→Copy file path/Copy image; More→**Reuse** / Add to folder / Copy / Delete. Exactly the three §0.1 actions, exactly those labels.
4. `M2-04` `POST /api/edit` + `POST /api/masks` + job-set plumbing for every non-`generate` `Op`.
5. `M2-05` Mask canvas: brush/eraser with adjustable size, lasso, rectangular region; committed mask uploaded once via `POST /api/masks` as a `kind='mask'` asset. Depends on `M2-15`.
6. `M2-06` Edit area flow: selection box with inline prompt field → job set → new asset row with `parent_asset_id`, `op`, `op_params`, `mask_asset_id`. Depends on `M2-15`.
7. `M2-07` Expand & Crop: crop is local and lossless; expand pads locally and, with "Fill with AI" on, submits an `outpaint` where `ops.outpaint` allows it, else the regional fallback with the Approximate badge.
8. `M2-08` Upscale: **local Lanczos ×2/×4**, labelled "Resizes, adds no detail", plus a visible disabled plugin slot for ×8/×16 and detail-adding upscale.
9. `M2-09` Remove background: **visible disabled slot** with its reason and a "How to add this" link; no launch adapter declares `ops.removeBackground`.
10. `M2-10` Version strip: ordered thumbnails from `WHERE root_asset_id = :root ORDER BY created_at`, "Original" first, current highlighted, Approximate badge where `approximate = 1`.
11. `M2-11` Zoom/pan control for the editor viewport (−/fit %/+, space-to-pan).
12. `M2-12` Lineage view + `GET /api/assets/:id/lineage` (the recursive reference graph).
13. `M2-13` Export with embedded metadata (PNG/WebP/JPEG) + sidecar option + bulk ZIP + the re-encode watermark warning.
14. `M2-13a` **Metadata writer spike — blocking `M2-13`.** Confirm PNG `tEXt`/`iTXt` plus the legacy `parameters` chunk round-trip, and WebP XMP/EXIF round-trip, under Bun; pick the library and record a fixture.
15. `M2-14` Trash, restore, Empty trash, the optional daily purge when `trashRetentionDays` is set (default `null`: never purge automatically), and the `file_state='missing'` tile state.
16. `M2-15` **Live probe of OpenAI `/v1/images/edits`: mask polarity, dimension and format requirements.** Fixture recorded, §6.14's manifest note updated. **Blocking prerequisite for `M2-05` and `M2-06`** — we do not ship a mask tool against an unverified polarity.
17. `M2-16` Colour grading: local WebGL stack (exposure, contrast, temp/tint, saturation/vibrance, lift/gamma/gain, grain, bloom, halation, vignette), `.cube` import/export, Match reference by local 3D histogram matching. **Preset names are Openfield's own.** Writes `generative = 0`, `provider_id = 'local'`, cost $0.00.
18. `M2-17` LAYERS panel: base + mask + local overlays (text, shapes, grade) with visibility, reorder, rename, merge. Generative layer decomposition is a visible disabled plugin slot.
19. `M2-18` Text-detect edit: `ops.detectText` on a configured multimodal model returns `{id,text,bbox}[]` under a strict JSON schema; editing a line issues an `edit`/`inpaint`. Disabled with a reason when no multimodal model is configured.
20. `M2-19` Relight / Angles / Enhancer widgets compiled to structured instruction edits, every one labelled best-effort, with original preset names. The Angles panel states plainly that this is a re-render, not a 3D reprojection.

#### M3 — Presets, library and costs

**Definition of done:** the user can save a prompt+style+params combination as a preset, apply it from a picker, export the library to JSON and import it on another machine; the Assets library with folders, favourites and date grouping works; a usage panel shows per-run and cumulative USD.

1. `M3-01` Preset data layer + CRUD API (`payload_json` round-trips the §5.3 object whole); copy-on-edit for builtin presets.
2. `M3-02` Preset picker sheet above the composer (hero band, tabs, search, 6-column card grid) with our own copy and artwork.
3. `M3-03` "Save as preset" from the composer and from any asset's Info tab.
4. `M3-04` Import/export routed by envelope `kind` (`style` | `reference-set` | `character` | `palette`): single object and full-library bundle, reference images inlined as base64 and re-materialised as assets on import; version field and forward-compatible parser.
5. `M3-05` Starter pack: 12 bundled presets and 8 bundled palettes, authored by us, original names and thumbnails, re-seeded from `apps/server/seed/presets/` and `apps/server/seed/palettes/` when the rows are deleted.
6. `M3-06` Palettes: `/api/palettes` CRUD, extraction from an asset, `mode` = prompt / reference / both — our open substitute for the reference product's colour-transfer sheet.
7. `M3-07` Reference sets and characters: `/api/reference-sets` and `/api/characters` CRUD, composer picker tiles, injection per `injection`/`token`, with a clear "*Model* doesn't take reference images" state where `references.supported` is false (§5.6).
8. `M3-08` Assets library route: 256 px sidebar (search, All assets, Favourites with count, folder tree with counts), fixed 6-column grid with date group headers and group-select checkboxes.
9. `M3-09` Folders API + drag-to-folder, add-to-folder from tile and detail menus.
10. `M3-10` FTS search over prompts with the shared cursor, plus model/provider/date filters.
11. `M3-11` Cost engine: per-model price snapshots with `pricedAt` and `sourceUrl`, the pure `estimate()` before submit, reconciliation after, `usage_log` writes including `discarded` rows, `~/.openfield/prices.json` overlay, "Prices as of `<date>`. They may have changed since." disclosure in the UI (§6.9). `refreshPricing()` proposes a diff the user accepts or rejects — prices never change silently.
12. `M3-12` Usage panel: today / 7 days / 30 days totals, per-model breakdown, a **"Canceled but charged"** line summing `discarded = 1`, `~` markers on `cost_source = 'estimated'` rows, CSV export, optional monthly soft budget warning.
13. `M3-13` Maintenance UI: storage stats, GC, backup, clear thumb cache, FTS reindex, and the thumbnail status (on, or off when `sharp` can't load) shown in Settings → Storage.
14. `M3-14` Restore-settings-from-image (read embedded metadata on upload).
15. `M3-15` Settings screens filled in behind the `M0-17` IA: Defaults, Appearance, Spending, Privacy (including `networkHosts ∪ assetHosts`), Help (the Error log), Experimental.
16. `M3-16` **Higgsfield adapter (§6.15)**, built against the real public API with the owner's key: Soul v2 standard endpoint, two-field key schema, `assetHosts` download path, `price.kind: 'unknown'`. Every §6.15 fact is verified live with that key and the fixtures are recorded from those runs. Ships only if a user key reaches the documented public API; otherwise `meta.stable: false` behind Settings → Experimental.

#### M4 — Canvas

**Definition of done:** the Canvas index and editor ship per §7 — infinite dotted grid, node graph on React Flow, Prompt / Image Generator / Edit image / Variations / Preset / Upload / Assets / Note / Frame nodes with typed ports and compatibility-filtered connection menus, run-node / run-downstream / run-all against the same server queue, fingerprint caching, autosave, version history, minimap, zoom cluster and toolbar. **Table and the Upscale node are out of this DoD** — Table is v1.1, and Upscale is latent until an adapter advertises `ops.upscale` (§0.14).

1. `M4-01` Canvas data layer + CRUD API + optimistic-concurrency autosave (debounced 800 ms, `409` reconciliation).
2. `M4-02` Canvas index page: create card, grid of canvases with generated 16:9 previews, name, relative "last edited", search.
3. `M4-03` React Flow editor shell: dotted grid, pan/zoom, zoom cluster (−, % menu at 25/50/75/100/150/200, +), fit-to-content, minimap, out-of-view helper pill.
4. `M4-04` Node base: resize handles, selection outline, label, typed input/output ports with tooltips.
5. `M4-05` Prompt node (`text` output), Note and Frame nodes, and the toolbar's Shape and Text annotation tools.
6. `M4-06` Image Generator node: preview area, quality/aspect chips, inline prompt, model chip reusing the M1 picker, run button showing the USD estimate.
7. `M4-07` Upload node and Assets node (pick from library) feeding `input_images`.
8. `M4-08` Edge model: typed compatibility, bezier rendering, drop-on-empty-canvas opens a filtered add-node menu at the drop point.
9. `M4-09` Add-node menu with search and Quick/References/Image/Utilities groups.
10. `M4-10` Graph execution: the browser compiles the DAG and POSTs a run plan to `POST /api/canvases/:id/run`; the **server** owns ordering, concurrency, retry and crash recovery, persists `canvas_runs`, and drives node state over `canvas_run.updated`. `POST …/runs/:runId/cancel` stops queued nodes.
11. `M4-11` Version history UI (list, preview, restore) on `canvas_versions`.
12. `M4-12` Multi-select, group move, duplicate (`⌘D`), delete, copy/paste of subgraphs, undo/redo stack. Undo never cancels an in-flight run; a node with a run in flight refuses reparenting and deletion.
13. `M4-13` Frames/pages: titled rectangles that group a subgraph and move with it.
14. `M4-14` **Four** starter templates authored by us, named per §7.3: **From a reference**, **Image edit**, **Storyboard (4 panels)**, **Compare styles**. Bundled as `apps/server/seed/templates/*.ofcanvas.json` and validated by `canvasDocumentSchema` in a unit test. *Upscale pass* is dropped until an adapter advertises `ops.upscale`.
15. `M4-15` Canvas preview generation (render graph to PNG on save, debounced) for the index cards, with the **150-node threshold** above which preview rendering degrades to a static placeholder rather than blocking the save.
16. `M4-16` Fingerprint + dirty propagation + result cache: `sha256(typeId, typeVersion, normalizedParams, modelKey, manifestVersion, [upstream fingerprints in port order])`, `cached` and `stale` node states, `⌥`-click cache bypass. §7.12 gates on "running a graph twice with no changes issues zero provider calls".
17. `M4-17` Fan-out map semantics (k-item output into a single-arity input), `×k` badge, labelled result grid, 32-job confirmation rail.
18. `M4-18` Run-all cost-preview popover: per-node rows, ranges where pricing is a range, explicit unknown rows, per-node rows summing to the displayed total.
19. `M4-19` Edit/Inpaint node + mask editor modal, reusing the `M2-05` mask canvas and `POST /api/masks`.
20. `M4-20` Preset node with merge precedence and lock glyphs (§0.8's resolution order).
21. `M4-21` Variations node: seed-jitter / prompt-list / model-list strategies, all compiling to `op = 'variation'`. Seed-jitter is offered only where `capabilities.seed.supported`.

---

### 8.8 Parity checklist

**§0.14 is the scope contract. This checklist records status; it does not set policy.** It maps observed reference-product behaviour to our v1 status so nothing is silently forgotten — but a row here can no longer cancel a feature §3 or §4 specifies in full. Where a row and a feature section once disagreed, the feature section won and the row below says so. "Open substitute" names what replaces a proprietary dependency.

| # | Higgsfield behaviour (from the walkthrough) | v1 status | Notes / open substitute |
|---|---|---|---|
| 1 | Edge-to-edge virtualised history grid, justified rows, 2 px gaps, no captions | ✅ M1 | Row heights from the one ladder (§0.10 / §8.5.2) |
| 2 | 5-step grid zoom slider (0–4, default 3 → 4 cols @1440) | ✅ M1 | 200/280/360/456/640; persisted in `settings` |
| 3 | Unified feed across all models, newest first | ✅ M1 | `idx_assets_feed` keyset pagination |
| 4 | Always-present tile checkbox → multi-select + bulk actions | ✅ M1 | `POST /api/assets/bulk` |
| 5 | Tile hover overlay: favourite, download, recreate, more-actions | ✅ M1 | Our own icon set |
| 6 | More-actions menu: Open, Regenerate, Reuse, Add to folder, Download, Delete | ✅ M1/M2 | Three actions, three names (§0.1): **Recreate** = replay the frozen request · **Reuse** = load into composer · **Use as reference** = attach only. `Regenerate` and `Re-run` are deleted as names for these actions (§0.1) |
| 7 | More-actions: Create/Assign element, Publish, Share to X/WhatsApp/Pinterest/LinkedIn | ❌ dropped | Social/multi-user features have no meaning in a local single-user app |
| 8 | Floating composer 1116×142, radius 24, blurred, fixed bottom-16 | ✅ M1 | Our colours and logo |
| 9 | Horizontally scrollable chip row with scroll arrows on overflow | ✅ M1 | |
| 10 | Chips change per model (capability-driven UI) | ✅ M1 | Driven by the capability manifest, §6 |
| 11 | Aspect-ratio popover with per-model option lists | ✅ M1 | Lists come from the manifest, not hardcoded in the view |
| 12 | Quality / Resolution / Background popovers | ✅ M1 | Rendered only when the manifest declares them |
| 13 | Prompt-enhance On/Off chip | ✅ M1 | Local rewrite via a user-configured text model, **off by default**, disabled with a reason when no text key exists (§3.4.3). Native where a provider offers it |
| 14 | Batch stepper 1/4 on every model | ✅ M1 | Capped by `capabilities.batch.max` (4 in v1, and the DB CHECK agrees); fan-out when `batch.native` is false |
| 15 | Generate button shows per-run credit cost / free-gens remaining | ⚠️ changed | Replaced by a USD estimate; no credit system exists in BYOK |
| 16 | Generate does not clear prompt/settings and stays enabled for queued runs | ✅ M1 | Queue accepts unlimited submits |
| 17 | N placeholder tiles with correct aspect, spinner pill and Cancel pill | ✅ M1 | Width/height returned by `/api/generate` |
| 18 | Promo/tips card inside the first placeholder | ⚠️ substituted | Local, static, dismissible tips card with a Settings switch; no CMS, no network call (§2.4). Queue position renders in the same slot when a run is waiting |
| 19 | Model picker popover: search, grouped sections, badges, provider icons | ✅ M1 | Our grouping is **Recent / by company / Needs a key** (§3.4.1); badges are capability-derived, never marketing |
| 20 | Deep-linkable `?model=` | ✅ M1 | `?model=<providerId>:<modelId>` |
| 21 | Character tile (Soul ID) | ⚠️ M3 substitute | **Open substitute:** named reference-image bundles + descriptor text, applied on models that accept reference images. No identity training in v1 |
| 22 | Style tile / moodboard sheet with curated presets | ⚠️ M3 substitute | **Open substitute:** our preset library (prompt template + reference images + params patch), with our own starter pack |
| 23 | Colour Transfer / HEX sheet with palette presets | ⚠️ M3 substitute | **Open substitute:** the `palettes` entity (§0.8) — extracted colours plus an injection `mode` of prompt / reference / both |
| 24 | Soul Cinema camera/lens wheel pickers | ⚠️ M3 substitute | **Open substitute:** a `params`/prompt preset family with camera and lens vocabulary; no bespoke wheel UI in v1 |
| 25 | Hero-sheet picker pattern (1120×540 panel above the composer) | ✅ M3 | Reused for presets and characters, our own copy |
| 26 | Detail dialog with blurred backdrop, Info/Edit/Comments tabs | ⚠️ M2 | Info · Edit · **History**; Comments dropped (single user), History replaces it |
| 27 | ←/→ navigation through the feed, Esc to close, "last viewed" badge | ✅ M2 | |
| 28 | Info tab: prompt + copy, reference thumbs, details rows, footer actions | ✅ M2 | |
| 29 | "Turn to video" primary action | ❌ v1 | Image-only in v1; the job/asset model is already modality-agnostic |
| 30 | Edit tab: version strip, zoom control, tool bar (select/hand/regional/lasso/pen/eraser/shapes) | ✅ M2 | |
| 31 | Regional edit with inline prompt on the selection | ✅ M2 | |
| 32 | Expand & Crop with "Fill with AI" | ✅ M2 | Outpaint only where the manifest allows |
| 33 | Upscale (third-party model, scale ×1–×16, sharpness/denoise/face enhance) | ⚠️ M2 partial | **Local Lanczos ×2/×4**, labelled "Resizes, adds no detail", plus a visible disabled plugin slot for ×8/×16 and detail-adding upscale. No launch adapter declares `ops.upscale` (§0.14) |
| 34 | Remove background | ⚠️ M2 slot | **Visible disabled slot** with its reason and a "How to add this" link; a local ONNX plugin is documented as the reference implementation. A correct disabled row is the pass condition for M2-09 |
| 35 | Layer Decomposition | ⚠️ M2 slot | **Visible disabled plugin slot** inside the LAYERS panel. No launch adapter declares `ops.decomposeLayers` |
| 36 | Edit text (detect + rewrite in-frame text) | ✅ M2 | Vision text-detect + instruction/masked edit (§4.8 row 2); disabled with a reason when no multimodal model is configured |
| 37 | Colour Grading preset grid | ✅ M2 | Local WebGL grade stack with **our own preset names**, `.cube` import/export, Match reference (§4.8 row 6). Non-generative, $0.00, offline, every model |
| 38 | Enhancer / Relight / Angles tools | ✅ M2 | Widget-compiled instruction edits, labelled best-effort, original preset names (§4.8 rows 7–9) |
| 39 | Layers panel with add/visibility/reorder | ✅ M2 | LAYERS panel: base + mask + local overlays, with visibility, reorder, rename, merge (§4.8). Generative layer decomposition is the disabled slot in row 35 |
| 40 | Assets library: sidebar, favourites count, folders with counts, date groups, group-select | ✅ M3 | Workspaces/teams dropped |
| 41 | Fixed 6-column grid in the library (distinct from the feed's justified rows) | ✅ M3 | |
| 42 | Elements + `@`-mention typeahead in the prompt | ✅ M1 | `@` resolves Openfield presets, characters, reference sets and saved references (§3.2/§5.7); the reference product's server-side Elements entity is not reproduced |
| 43 | Canvas index with templates tab and auto-generated previews | ✅ M4 | Four starter templates authored by us (§7.3) |
| 44 | Canvas editor: React Flow graph, dotted grid, zoom cluster, minimap, toolbar, autosave | ✅ M4 | |
| 45 | Image Generation node with typed ports, chips, inline prompt, model chip, run button | ✅ M4 | Cost pill shows USD |
| 46 | Compatibility-filtered node menu on edge drop | ✅ M4 | |
| 47 | Canvas version history / rename / duplicate / delete | ✅ M4 | `canvas_versions` |
| 48 | Ask Agent (natural-language graph building) | ❌ v1 | Would require a mandatory LLM key; v1.1 behind an optional key |
| 49 | Canvas chat, share dialog, multiplayer cursors, comments | ❌ dropped | Single user, no server |
| 50 | Video / Voice / LLM / Page / Table nodes | ❌ / ⚠️ | ❌ Video / Voice / Page. **Table and AI text are v1.1** (§7.5): a runnable LLM node would make a text-model key a canvas dependency, which image-only v1 forbids. The fan-out mechanism itself stays in v1 — Variations needs it |
| 51 | Image-resizing CDN proxy (webp, w, q) | ✅ M0 | **Open substitute:** local thumbnail service with a content-addressed cache (§8.5) |
| 52 | Clerk authentication | ❌ dropped | Loopback, single user, no auth |
| 53 | Status-batch polling for in-flight jobs | ⚠️ changed | Replaced by SSE with a polling fallback (§8.4.6) |
| 54 | Per-action credit costs everywhere | ⚠️ changed | Per-action USD estimates plus a running usage log |
| — | *(beyond parity)* Preset import/export as JSON | ✅ M3 | Not present in the observed product |
| — | *(beyond parity)* Usage log + CSV export | ✅ M3 | |
| — | *(beyond parity)* Portable `~/.openfield`, backup/restore | ✅ M3 | |

---

### 8.9 Risks and mitigations

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **Provider API churn** — endpoints, parameter names or auth shapes change under us | High / High | All provider knowledge lives behind the adapter interface (§6). Adapters carry a `schemaVersion`; contract tests run against recorded fixtures in CI and against live APIs in an optional nightly job. A broken adapter disables just its provider (`providers.last_error` surfaces in Settings) instead of breaking the app |
| R2 | **Model capability drift** — a model gains/loses aspect ratios, quality tiers or reference-image support | High / Medium | Capability manifests are data, not code paths; runtime discovery refreshes them where the provider allows (`models.source='discovered'`), shipped manifests are the fallback, and unknown parameters are passed through a `providerOptions` escape hatch. The UI renders from the manifest, so a new quality tier appears without a release |
| R3 | **Model IDs and prices in our docs go stale** | Certain / Low | Every price carries `pricedAt` and `sourceUrl`; the UI labels estimates "Prices as of `<date>`" and never presents one as authoritative. No model id is hardcoded in the view layer — the registry is the only source. Our research snapshot (2026-09-23) is explicitly a snapshot |
| R4 | **Cost surprises** — token-priced models (OpenAI) make per-image cost unpredictable | Medium / High | Estimates show a `min`–`max` range with `confidence` and a human-readable `basis` string disclosed (§0.13); actuals are recorded from response usage where returned and marked `~` where not; optional monthly soft budget warns at 80 % and requires confirmation past 100 %; the usage panel and CSV make spend auditable, including the "Canceled but charged" line |
| R5 | **Double-billing on retry or restart** | Low / High | Client-supplied `idempotencyKey` deduplicates resubmits; recovery **never** auto-resubmits a job that may already be running (§8.4.5); cancellation is honest about work already started |
| R6 | **Large local libraries** (100k+ assets) | Medium / Medium | Keyset pagination with partial indices (no `OFFSET` anywhere); FTS5 external-content index; thumbs content-addressed and regenerable; `VACUUM INTO` backups; measured target: feed first page <50 ms at 100k rows, enforced by a seeded benchmark in CI |
| R7 | **Browser memory with thousands of images** | High / High | Windowed virtualiser rendering ±2 viewports; `loading="lazy"`, `decoding="async"`, a bounded concurrent-decode pool; thumbs sized to the zoom step so the browser never holds oversized bitmaps; object URLs revoked on unmount; a soak test scrolls 5 000 tiles and asserts a renderer-memory ceiling |
| R8 | **Thumbnail CPU spikes** starving the UI | Medium / Low | Worker pool capped at `cores − 2`, generation deprioritised behind live job ingest, single-flight locking, on-demand generation for non-default rungs |
| R9 | **Native dependency (`sharp`) fails to install or to load under Bun** | Medium / Medium | `sharp` is loaded once at boot, and a failure never fails `bun install` or the boot. Thumbnails turn off: `/files/thumb/:id` serves the original with `no-cache`, and Settings → Storage says "Thumbnails are off. Images show at full size, so scrolling may be slower." (§8.5.2). The feed stays correct, only heavier. No WASM chain |
| R10 | **API key leakage** | Low / Critical | Keys never enter the db, never enter a response body, never reach browser JS; `config.json` written 0600 with mode verified after write; a redaction filter wraps every log sink; a CI test asserts no endpoint response and no log line can contain a key-shaped string |
| R11 | **Loopback server reachable from a malicious page** | Medium / High | All four §8.3 guards, on **every method including `GET`**: bind `127.0.0.1` only; Host-header allowlist (anti-DNS-rebinding); **never emit any CORS or `Timing-Allow-Origin` header, in any build**; reject `Sec-Fetch-Site: cross-site`, `Sec-Fetch-Dest: image\|script\|style` on `/api`, and any foreign `Origin`; require the boot-minted `X-Openfield-Session` token on every `/api` and `/files` request. No cookies, so no ambient authority to steal. A `GET` is not exempt: `/api/assets` is the whole prompt history and `/files/thumb/:id` writes a file. **Acceptance: a cross-origin page cannot list assets, read key status, or cause a thumbnail to be generated** |
| R12 | **Licence and trademark hygiene** | Medium / High | MIT, copyright "Openfield contributors". No Higgsfield name, logo, colours, icons or marketing copy anywhere in the product, repo or README; all UI copy written by us; all preset names and thumbnails original. Third-party model names (e.g. provider model identifiers) appear only as registry data describing the user's own API account — nominative, factual use. The README states plainly that Openfield is an independent project, unaffiliated with and not endorsed by any model provider, and that users bring their own keys and are bound by each provider's terms |
| R13 | **Higgsfield adapter may be impossible to ship** — style listing, character training and canvas endpoints are undocumented | Medium / Medium | The adapter is conditional by design: it is built and verified with the owner's real key in `M3-16`, and ships only if a user key can reach the documented Soul endpoint. Its absence changes nothing structurally, because every Higgsfield-specific feature already has an open substitute (rows 21–24, 33 above) |
| R14 | **Canvas graph schema evolves and breaks saved canvases** | Medium / Medium | `canvases.schema_version` plus a forward document migration per bump in `packages/core/src/canvas/migrations/` (separate from the SQL migrations in `packages/db/migrations/`), applied lazily on open with a version snapshot taken first; unknown node types render as a labelled placeholder rather than dropping data |
| R15 | **SQLite write contention or corruption** | Low / High | WAL, single writer inside the server process, `busy_timeout`, every multi-row mutation in a transaction, `PRAGMA integrity_check` on the backup path, atomic `rename()` for every file write |
| R16 | **Scope creep across five milestones** | High / Medium | **§0.14 is the scope contract**: anything it lists as deferred or dropped needs an explicit decision to move, and each milestone's definition of done is the release gate. §8.8 records status against the observation notes and has no authority to add or cancel scope — that ambiguity is what let a checklist row quietly veto seven features §3 and §4 specify in full |

---

### 8.10 Open questions

Only genuinely open items remain. Each names the task that closes it; anything §0 decided is gone, not restated.

- **Polling cadence of the reference product's in-progress status calls** was never measured. Our 2 s SSE-failure fallback interval is chosen, not copied. *(No task: it is a fallback we control, recorded for honesty.)*
- **OpenAI `n` limits per quality × size** are undocumented, so batch fan-in vs fan-out for GPT Image is a guess until measured. *(M2-15's probe session measures it alongside the mask probe.)*
- **Measured output-token counts per quality × size for OpenAI GPT Image** are undocumented, so pre-submit estimates for those models are a range, not a number — and it is an open product question whether to suppress the estimate entirely when the range is wider than ±50 %. *(M3-11.)*
- **Canvas node internals never captured:** Video, Voice, LLM Assistant, Page, Table, Upload and Assets node UIs; canvas comment threads; version-history UI; multi-select/group operations; delete and duplicate shortcuts. §7 specifies our own designs for the nodes we ship; the rest stay unbuilt rather than invented. *(M4-05 … M4-12.)*

---
## Appendix A. Consolidated open questions

Rolled up from the per-section lists after reconciliation. Each item is a decision still to make or a fact to verify before the milestone that depends on it; questions that §0 settled have been removed at the source.

**§1**

- **Higgsfield adapter viability.** The public API is documented for Soul v2 (`POST /higgsfield-ai/soul/v2/standard`) with `Authorization: Key <id>:<secret>`, but research found no documented endpoint for **listing style IDs** (70+ styles referenced without a schema), no documented **identity-training** endpoint, and no Canvas API. Until style-listing and character endpoints are confirmed with a real key (the owner's, in `M3-16`), the adapter's scope — and whether it ships in v1 at all — is undecided; §0.13 already pins its pricing to `kind: "unknown"` until a live probe confirms an estimate endpoint.
- **Provider terms.** Whether each provider's ToS permits a BYOK client of this shape, and whether any require attribution or restrict presenting cost estimates, has not been verified per-provider.
- **Model catalogue refresh cadence.** Google publishes no `models.list` for image models and OpenAI's `/v1/models` does not flag image capability — both stand. §0.3 settles the consequence: `listModels()` need only return the adapter's static, version-stamped catalogue, network discovery is optional and **allow-listed by the adapter's own `recognise(id)`** (unrecognised ids are reported, never added), and the snapshot date is surfaced in Settings → Models. What remains open is the refresh cadence and who runs the maintainer script.
- **Migration.** Whether existing Higgsfield users want to import their cloud library, and whether any supported export path exists, is unknown; no export API was observed.
- **Parity ownership.** Who signs off the S2 parity checklist (§8.8), and what counts as a *must* row versus a *should* row, needs fixing before the checklist is written. §0.14 remains the scope contract either way.
- **Canvas gaps.** Several behaviours of the v1 node set were not captured (inner UI of the Upload and Assets nodes, multi-select and group operations, delete/duplicate shortcuts). §7 decides these from first principles rather than from observation; node types §0.14 defers to v1.1 or drops outright are not open questions.

**§2**

- The feed was never seen in a failure state, so the failed tile's layout and its retry affordances are Openfield originals with no reference behaviour to compare against. (The error vocabulary itself is settled — §0.5.)
- Whether the reference product's justified solver clamps extreme aspect ratios (21:9, 1:8) was not observed; our `[0.75·H, 1.35·H]` clamp is a derivation that should be tuned against real mixed-ratio histories. Closes with M1-08.
- The relationship between that product's feed and its assets library was not fully traced: it is unclear whether a generation appears in "all assets" automatically or only once filed. Openfield assumes automatic membership in "All assets".
- Selection behaviour across pagination boundaries was not observed — whether a selection survives loading more, and whether "select all" means all-loaded or all-matching. Openfield specifies all-loaded with an explicit count.

**§3**

- The `Off` chip with a wand icon on Soul 2.0 was read as prompt-enhance from context and its tooltip, but the toggle's on-state payload was not captured — our local enhancer design does not depend on it.
- The exact width and placement of the reference-image strip *inside* the reference product's prompt bar was not observed (only the 72 px reference thumbnails in its detail panel); the 56×56 strip in §3.2 is our design.
- Whether the reference product allows per-reference weights at all; the captured payload carries a single `custom_reference_strength`, which is why `global` is the default `strengthMode`.
- OpenAI's maximum reference-image count for edits (docs say "2+"); we cap at 4 pending the live probe in task **M2-15**.
- Whether the Higgsfield public API exposes style presets, character IDs and a cost-estimate endpoint to a user key; if not, the Soul 2.0 row in §3.7 ships without the native mappings and everything falls back to our preset/character system (§0.13).
- The keyboard shortcut the reference product uses to submit was not captured; `⌘/Ctrl+Enter` is our choice.

**§4**

- The detail-view **zoom/pan affordances inside the Info tab** were not measured — only the Edit-tab zoom cluster was. Our `+ / − / 0` and wheel-zoom on the Info tab is our own addition.
- **Version-strip thumbnail spacing, scroll behaviour and branch representation** were not observed; the 8px gap, the pinning and the fork glyph are our design.
- **Mask encoding expected by the OpenAI edits endpoint** (which alpha polarity, whether the mask must match the input's exact dimensions and format) is undocumented in the research. Task **M2-15** is a live probe with a recorded fixture, and it is a blocking prerequisite for M2-05/M2-06.
- **Seed support on the Gemini image models** is not documented; until confirmed, Recreate on those models carries the `~` badge and its tooltip (§0.1, §0.11).
- Whether the **Higgsfield public API exposes inpaint / upscale / relight job types** at all (only the Soul v2 standard endpoint is confirmed) — this decides whether a Higgsfield adapter can light up rows 2–9 or only whole-image instruction editing.
- Exact behaviour of the reference product's **Expand & Crop with layers present** ("crop keeps pixels on layers") was read from the panel copy, not exercised; our local crop preserves layers, but the AI-fill interaction with layers is unspecified.
- The **"Add comment" button's** anchoring was not exercised; we did not observe whether comments pin to a point on the image. Our notes are asset-level only in v1.

**§5**

- Whether Higgsfield's public API exposes a style catalogue listing endpoint, Soul ID character creation, or Soul HEX at all with a user key — research found the Soul endpoint only, and no schema for the "70+ styles" or the Soul ID training flow. If it does not, the Higgsfield adapter ships without native styles/characters and falls back entirely to §5.3–§5.7.
- Their exact semantics for `style_strength` vs `custom_reference_strength` (both observed as `1` in the captured payload) — we know the field names, not their curves or interaction.
- Whether the observed Character sheet tabs (`All | Soul | Soul 2.0 | Soul Cinema`) filter by *trained-for* model or by *compatible* model; our provider-derived tabs assume the latter.
- The observed Moodboard build flow itself was not captured beyond its CTA ("Build your moodboard") — how many images it takes, whether it produces a derived artefact or just a group, and whether moodboards are model-scoped.
- Gemini seed support is not confirmed in the API documentation; until a live adapter probe confirms it, `capabilities.seed.supported` is `false` for the Gemini family and §5.7's Lock seed row stays disabled.
- OpenAI's real maximum reference-image count for edits (docs say "2+"), which sets `capabilities.references.max` for that family.
- Whether their Color Transfer palette presets are pure colour data or carry additional model conditioning — the observed grid shows a thumbnail plus swatch strip, which is consistent with either.
- Per-reference weighting on fal.ai / Replicate models (v1.1): whether enough models accept per-image weights to make `capabilities.references.weights` worth surfacing as a first-class control rather than an ordering hint.

**§6**

- **OpenAI mask polarity** for `/v1/images/edits` — unconfirmed in the research; the adapter converts from Openfield's canonical alpha-0-is-edit mask either way. Closed by **`M2-15`** (live probe of polarity, dimensions and format, fixture recorded, §6.14 note updated). Blocking prerequisite for `M2-05`/`M2-06`.
- **Whether `POST /v1/images/generations` returns a `usage` block.** Until confirmed, every OpenAI cost row ships `confidence: "estimated"` and the Usage screen marks it `~`. Closed by the same probe, **`M2-15`**.
- **Exact maximum reference-image count for OpenAI image edits**, and whether it differs between Sunburst, Flare and GPT Image 2. We declare 4. Closed by **`M2-15`** (same live session).
- **Whether Gemini exposes any multi-image-per-call parameter.** If it does, the fan-out in §6.5 step 5 becomes a cost optimisation rather than a necessity. Closed by **`M0-07`** (Google Gemini image adapter).
- **Output-token counts per (quality × size) for OpenAI.** Must be measured before launch; until then the Generate button shows a range. Closed by **`M3-11`** (cost engine: price snapshots, estimate, reconciliation, usage log).
- **Higgsfield public API reach** — real endpoint paths beyond Soul v2 standard, the style-id catalogue, rate limits, and whether any documented cost endpoint exists. None of it was observable in the UI walkthrough (the observed traffic was the product's private endpoints, which we do not build against, §1.11). Closed by **`M3-16`**, which builds the adapter and verifies these facts with the owner's real key; if it does not resolve, the adapter ships `meta.stable: false` behind Settings → Experimental and nothing else changes.
- ~~Whether to allow a user-supplied provider `baseUrl` override in v1.~~ Closed at **`M0-05`**: deferred to the v1.1 OpenAI-compatible provider (§6.18).
- **Price-refresh feasibility** — whether any launch provider exposes a machine-readable price document worth wiring `refreshPricing()` to, or whether the `~/.openfield/prices.json` overlay is the whole story for v1. Closed by **`M3-11`**.

**§7**

- Inner UI of the reference product's Video, Voice, LLM Assistant, Page, Table, Upload and Assets nodes was not captured — our specs for Upload and Assets (and, at v1.1, Table and AI text) are our own design, not parity.
- The reference version-history UI was not opened; our drawer design is not parity-checked.
- Multi-select, group, align and copy/paste behaviour on the reference canvas was never exercised; no delete/duplicate shortcut was observed. Our shortcut table is ours.
- Whether the reference canvas re-runs nodes automatically when an upstream node changes, or whether it caches unchanged nodes at all, was not observed — our dirty/cached model is a design decision.
- Whether the reference "Frames/Pages" are React Flow parent nodes or decorative rectangles is unknown; we implement them as parents.
- Whether edges can be reconnected, or a node inserted onto an existing edge, in the reference product was not tested.
- What the reference "Page" node is (document? sub-canvas?) is unknown; we ship no equivalent.
- No per-canvas node count limit or performance ceiling was observable; our targets are self-imposed.
- Whether Higgsfield exposes any canvas/graph functionality through its public API is undocumented (the API research notes it as "appears to be UI-only") — so a Higgsfield adapter, if shipped, contributes models to canvas nodes, never a canvas backend.

**§8**

- **Polling cadence of the reference product's in-progress status calls** was never measured. Our 2 s SSE-failure fallback interval is chosen, not copied. *(No task: it is a fallback we control, recorded for honesty.)*
- **OpenAI `n` limits per quality × size** are undocumented, so batch fan-in vs fan-out for GPT Image is a guess until measured. *(M2-15's probe session measures it alongside the mask probe.)*
- **Measured output-token counts per quality × size for OpenAI GPT Image** are undocumented, so pre-submit estimates for those models are a range, not a number — and it is an open product question whether to suppress the estimate entirely when the range is wider than ±50 %. *(M3-11.)*
- **Canvas node internals never captured:** Video, Voice, LLM Assistant, Page, Table, Upload and Assets node UIs; canvas comment threads; version-history UI; multi-select/group operations; delete and duplicate shortcuts. §7 specifies our own designs for the nodes we ship; the rest stay unbuilt rather than invented. *(M4-05 … M4-12.)*
