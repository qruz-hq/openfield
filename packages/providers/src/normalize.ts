import {
  type AdapterOp,
  type AspectRatio,
  adapterOpFor,
  type Capabilities,
  type ControlId,
  type Diagnostic,
  type ErrorCode,
  type GenerateRequest,
  hashCanonical,
  type MessageKey,
  type ModelManifest,
  type NormalizedRequest,
  newId,
  type PixelSize,
  type ProviderSettingsSchema,
  type ReferenceInput,
  type ResolutionTier,
  type ResolvedProviderSettings,
  t,
} from "@openfield/core";
import { resolveProviderSettings } from "./manifest/provider-settings";
import { nearestRatio, placeholderSize, resolveSize } from "./manifest/size";
import { ProviderError } from "./types";

// §6.5: GenerateRequest → NormalizedRequest, once, before any adapter code runs. Checks the
// request against the model's manifest, resolves size, fills seeds, plans the fan-out and freezes
// the result so Recreate replays exactly this (§0.11).

/** What presets, characters, reference sets, palettes and @-mentions resolve to (§0.8). */
export interface ResolvedPrompt {
  /** The prompt after presets and mentions, before any "Avoid:" sentence. */
  prompt: string;
  negativePrompt?: string;
  /** Preset and character references first, then the person's own, in weight order. */
  references?: ReferenceInput[];
}

/**
 * The server's hook for §0.8 resolution, which needs the database. Without one, the prompt and
 * references pass through as typed and preset, character, reference set and palette ids are ignored.
 */
export type PromptResolver = (req: GenerateRequest, manifest: ModelManifest) => Promise<ResolvedPrompt>;

export interface NormalizeOptions {
  jobSetId: string;
  /** Mints one id per output. Defaults to a ULID. */
  newId?: () => string;
  resolvePrompt?: PromptResolver;
  /** A random 32-bit seed. Injectable so tests are deterministic. */
  randomSeed?: () => number;
  /**
   * The company's settings: the adapter's schema and the values the person changed. They're
   * resolved for this model and frozen onto the request (§0.3). Without them the run is Standard.
   */
  settings?: { schema?: ProviderSettingsSchema; stored?: Readonly<Record<string, unknown>> | null };
}

export interface NormalizeResult {
  /** The frozen job-set request: write it to job_sets.request_json. Recreate replays it. */
  request: NormalizedRequest;
  /** One per provider call: a single call with batch n, or n single-image calls on fan-out. */
  calls: NormalizedRequest[];
  /** One id per output, in order. calls[i].jobId comes from here. */
  jobIds: string[];
  /** Roughly what each image will measure, so placeholders reserve the right shape. */
  dimensions: PixelSize;
  diagnostics: Diagnostic[];
  /** Controls Openfield faked for this run, recorded on the job set. */
  emulated: ControlId[];
  /** The company's settings for this model, including why a choice fell back. Frozen on `request`. */
  settings: ResolvedProviderSettings;
  /** Set when the run can't be sent as asked. Don't submit. */
  error?: ProviderError;
}

const EDIT_SOURCE_OPS: readonly AdapterOp[] = ["edit", "inpaint", "outpaint", "upscale", "remove_bg"];

export async function normalize(
  manifest: ModelManifest,
  req: GenerateRequest,
  opts: NormalizeOptions,
): Promise<NormalizeResult> {
  const caps = manifest.capabilities;
  const model = manifest.displayName;
  const diagnostics: Diagnostic[] = [];
  const emulated: ControlId[] = [];

  const block = (field: string, code: ErrorCode, message: string) =>
    diagnostics.push({ level: "error", field, code, message });
  // The manifest's policy decides whether a setting it can't honour stops the run or is dropped.
  const unsupported = (field: string, message: string) =>
    diagnostics.push({
      level: caps.unsupportedParamPolicy === "reject" ? "error" : "warning",
      field,
      code: "unsupported_param",
      message,
    });
  const unsupportedSetting = (field: string, label: MessageKey) =>
    unsupported(field, t("composer.unsupported", { model, setting: t(label) }));

  if (req.model !== manifest.key) block("model", "invalid_request", t("errors.invalid_request.reason"));

  // Op (§0.4)
  const op = adapterOpFor(req.op, { hasMask: Boolean(req.mask), canInpaint: caps.ops.inpaint });
  if (!op || !canDo(caps, op))
    block("op", "capability_unsupported", t("errors.capability_unsupported.reason"));
  if (op && EDIT_SOURCE_OPS.includes(op) && !req.base) {
    block("base", "invalid_request", t("errors.invalid_request.reason"));
  }

  // Prompt, presets and mentions (§0.8)
  const resolved = await (opts.resolvePrompt ?? passThrough)(req, manifest);
  let promptAfterPreset = resolved.prompt;
  let negativePrompt = resolved.negativePrompt?.trim() || undefined;
  if (negativePrompt && !caps.negativePrompt) {
    // Never a diagnostic: the model gets it as a trailing sentence and the chip shows "~".
    promptAfterPreset = appendAvoid(promptAfterPreset, negativePrompt);
    negativePrompt = undefined;
    emulated.push("negativePrompt");
  }

  let references = resolved.references ?? [];
  if (op === "generate" && !promptAfterPreset.trim() && references.length === 0) {
    block("prompt", "invalid_request", t("composer.generate.emptyPrompt"));
  }
  const maxChars = caps.limits.maxPromptChars;
  if (maxChars && promptAfterPreset.length > maxChars) {
    block("prompt", "invalid_request", t("errors.invalid_request.reason"));
  }

  // References
  if (references.length && !caps.references.supported) {
    unsupported("references", t("composer.referencesNone", { model }));
    references = [];
  } else if (references.length > caps.references.max) {
    unsupported("references", t("composer.referenceLimit", { model, max: caps.references.max }));
    references = references.slice(0, caps.references.max);
  }
  if (!caps.references.weights) references = references.map(({ weight: _, ...rest }) => rest);

  // Size, resolution, quality (§6.5 step 3)
  let resolution: ResolutionTier | undefined;
  if (caps.resolution) {
    resolution = caps.resolution.default;
    if (req.resolution && caps.resolution.tiers.includes(req.resolution)) resolution = req.resolution;
    else if (req.resolution) unsupportedSetting("resolution", "composer.chips.resolution.label");
  } else if (req.resolution) {
    unsupportedSetting("resolution", "composer.chips.resolution.label");
  }
  const size = resolveRequestSize(caps, req, resolution, () =>
    unsupportedSetting("size", "composer.chips.aspect.label"),
  );

  let quality: string | undefined;
  if (caps.quality) {
    quality = caps.quality.default;
    if (req.quality && caps.quality.levels.some((l) => l.id === req.quality)) quality = req.quality;
    else if (req.quality) unsupportedSetting("quality", "composer.chips.quality.label");
  } else if (req.quality) {
    unsupportedSetting("quality", "composer.chips.quality.label");
  }

  let batch = req.batch;
  if (batch > caps.batch.max) {
    unsupportedSetting("batch", "composer.chips.batch.label");
    batch = caps.batch.max;
  }

  // Everything else a manifest may or may not declare
  let background = req.background;
  if (background && !caps.background?.values.includes(background)) {
    // "auto" on a model without the control means the same as leaving it out.
    if (background !== "auto") unsupportedSetting("background", "composer.chips.background.label");
    background = caps.background?.default;
  }

  let output = req.output;
  if (output && !caps.output.formats.includes(output.format)) {
    unsupported("output", t("errors.unsupported_param.reason"));
    output = undefined;
  }
  if (output?.compression !== undefined && (!caps.output.compression || output.format === "png")) {
    output = { format: output.format };
  }

  let moderation = req.moderation;
  if (moderation && !caps.safety?.moderation?.values.includes(moderation)) {
    unsupported("moderation", t("errors.unsupported_param.reason"));
    moderation = undefined;
  }

  // Openfield's own enhancer runs before this, so only a native flag goes to the provider.
  let enhancePrompt = req.enhancePrompt;
  if (enhancePrompt && caps.promptEnhance === "none")
    unsupportedSetting("enhancePrompt", "composer.chips.enhance.label");
  if (caps.promptEnhance !== "native") enhancePrompt = undefined;

  const providerOptions = checkProviderOptions(caps, req.providerOptions, (field, setting) =>
    unsupported(field, t("composer.unsupported", { model, setting })),
  );

  // Seeds (§0.11): only for models that honour them, one per output, derived from one base.
  let seed: number | undefined;
  if (caps.seed.supported) {
    seed = req.seed ?? (opts.randomSeed ?? randomSeed)();
  } else if (req.seed !== undefined && req.seed !== null) {
    unsupportedSetting("seed", "composer.chips.seed.label");
  }

  // Company settings and speed (§0.3): a speed this model lacks for this op runs at Standard.
  const settings = resolveProviderSettings(
    opts.settings?.schema,
    opts.settings?.stored,
    manifest,
    op ?? "generate",
  );

  // Freeze
  const mint = opts.newId ?? newId;
  const jobIds = Array.from({ length: batch }, () => mint());
  const frozen: Omit<NormalizedRequest, "paramsHash"> = compact({
    idempotencyKey: req.idempotencyKey,
    model: req.model,
    op: op ?? req.op,
    prompt: req.prompt,
    negativePrompt,
    enhancePrompt,
    size,
    resolution,
    quality,
    background,
    output,
    batch,
    seed,
    references: references.length ? references : undefined,
    base: op && EDIT_SOURCE_OPS.includes(op) ? req.base : undefined,
    mask: op === "inpaint" || op === "outpaint" ? req.mask : undefined,
    expand: op === "outpaint" ? req.expand : undefined,
    moderation,
    source: req.source,
    canvas: req.canvas,
    providerOptions,
    jobId: jobIds[0]!,
    jobSetId: opts.jobSetId,
    batchIndex: 0,
    promptAfterPreset,
    manifestVersion: manifest.manifestVersion,
    speed: settings.speed,
    speedRequested: settings.speedRequested,
    providerSettings: settings.values,
  });
  const request: NormalizedRequest = { ...frozen, paramsHash: await paramsHashOf(frozen, manifest) };

  if (batch > 1 && !caps.batch.native && caps.emulated?.includes("batch")) emulated.push("batch");
  const firstError = diagnostics.find((d) => d.level === "error");

  return {
    request,
    calls: planCalls(manifest, request, jobIds),
    jobIds,
    dimensions: placeholderSize(caps, size, resolution),
    diagnostics,
    emulated,
    settings,
    ...(firstError && {
      error: new ProviderError(firstError.code as ErrorCode, {
        userMessage: firstError.message,
        message: `The request doesn't fit ${manifest.key} (${firstError.field})`,
        ...(firstError.field && { field: firstError.field }),
      }),
    }),
  };
}

/**
 * Splits a frozen request into provider calls (§6.5 step 5). Recreate calls this on the stored
 * request with fresh job ids; seeds come out the same because they derive from the stored base.
 * A Batch run always splits into single-image requests, so each tile fails on its own.
 */
export function planCalls(
  manifest: ModelManifest,
  request: NormalizedRequest,
  jobIds: string[],
): NormalizedRequest[] {
  const caps = manifest.capabilities;
  if (jobIds.length !== request.batch)
    throw new RangeError(`Expected ${request.batch} job ids, got ${jobIds.length}`);
  const single = request.batch === 1 || (caps.batch.native && request.speed !== "batch");
  if (single) return [{ ...request, jobId: jobIds[0]!, batchIndex: 0 }];
  const [low, high] = caps.seed.range ?? [0, 4_294_967_295];
  return jobIds.map((jobId, i) => ({
    ...request,
    jobId,
    batchIndex: i,
    batch: 1,
    ...(request.seed !== undefined && { seed: low + ((request.seed - low + i) % (high - low + 1)) }),
  }));
}

/** "a cat on a mat. Avoid: dogs, text." One trailing sentence, as §0.8 asks. */
export function appendAvoid(prompt: string, avoid: string): string {
  const base = prompt.trimEnd();
  const clause = `Avoid: ${avoid.replace(/[.\s]+$/, "")}.`;
  if (!base) return clause;
  return /[.!?]$/.test(base) ? `${base} ${clause}` : `${base}. ${clause}`;
}

function canDo(caps: Capabilities, op: AdapterOp): boolean {
  switch (op) {
    case "generate":
      return caps.ops.textToImage;
    case "edit":
      return caps.ops.imageEdit;
    case "inpaint":
      return caps.ops.inpaint;
    case "outpaint":
      return caps.ops.outpaint;
    case "upscale":
      return caps.ops.upscale;
    case "remove_bg":
      return caps.ops.removeBackground;
  }
}

async function passThrough(req: GenerateRequest): Promise<ResolvedPrompt> {
  return {
    prompt: req.prompt,
    ...(req.negativePrompt !== undefined && { negativePrompt: req.negativePrompt }),
    ...(req.references && { references: req.references }),
  };
}

function resolveRequestSize(
  caps: Capabilities,
  req: GenerateRequest,
  tier: ResolutionTier | undefined,
  onUnsupported: () => void,
): PixelSize | { aspect: AspectRatio } {
  const spec = req.size;
  const size = caps.size;

  if (size.mode === "aspect") {
    if (spec.kind === "auto") return { aspect: size.ratios.includes("auto") ? "auto" : size.default };
    if (spec.kind === "aspect") {
      const blocked = caps.partial?.aspect?.unavailable.includes(spec.ratio);
      if (size.ratios.includes(spec.ratio) && !blocked) return { aspect: spec.ratio };
      onUnsupported();
      return { aspect: size.default };
    }
    // Pixels on an aspect-only model: keep the shape, let the model pick the pixels.
    const nearest = nearestRatio(spec.width, spec.height, size.ratios);
    onUnsupported();
    return { aspect: nearest ?? size.default };
  }

  if (size.mode === "enum") {
    if (spec.kind === "auto") return size.allowAuto ? { aspect: "auto" } : size.default;
    if (spec.kind === "pixels") {
      const hit = size.sizes.find((s) => s.width === spec.width && s.height === spec.height);
      if (hit) return hit;
      onUnsupported();
      return size.default;
    }
    const want = resolveSize(spec.ratio, tier ?? "1K");
    const hit = size.sizes.find((s) => Math.abs(s.width / s.height - want.width / want.height) < 0.01);
    if (hit) return hit;
    onUnsupported();
    return size.default;
  }

  // Free size: snap to the grid and clamp to the edges the model accepts.
  const grid = { multipleOf: size.multipleOf, minEdge: size.minEdge, maxEdge: size.maxEdge };
  if (spec.kind === "auto") return size.default;
  if (spec.kind === "aspect") return resolveSize(spec.ratio, tier ?? "1K", grid);
  const snap = (edge: number) =>
    Math.min(size.maxEdge, Math.max(size.minEdge, Math.round(edge / size.multipleOf) * size.multipleOf));
  const snapped = { width: snap(spec.width), height: snap(spec.height) };
  if (snapped.width !== spec.width || snapped.height !== spec.height) onUnsupported();
  return snapped;
}

/** Keeps only Advanced fields the manifest declares, with values its schema allows. */
function checkProviderOptions(
  caps: Capabilities,
  options: Record<string, unknown> | undefined,
  unsupported: (field: string, setting: string) => void,
): Record<string, unknown> | undefined {
  if (!options) return undefined;
  const fields = caps.extraSchema?.properties ?? {};
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    const field = fields[key];
    const valid =
      field !== undefined &&
      (field.type === "string"
        ? typeof value === "string" && (!field.enum || field.enum.includes(value))
        : field.type === "boolean"
          ? typeof value === "boolean"
          : field.type === "array"
            ? Array.isArray(value) && value.every((v) => typeof v === "string")
            : typeof value === "number" &&
              (field.type !== "integer" || Number.isInteger(value)) &&
              (field.minimum === undefined || value >= field.minimum) &&
              (field.maximum === undefined || value <= field.maximum));
    if (valid) kept[key] = value;
    else unsupported(`providerOptions.${key}`, field?.title ?? t("composer.chips.advanced.label"));
  }
  return Object.keys(kept).length ? kept : undefined;
}

// Ids and the source change on every submit; hashing them would make every hash unique.
async function paramsHashOf(
  frozen: Omit<NormalizedRequest, "paramsHash">,
  manifest: ModelManifest,
): Promise<string> {
  const {
    jobId: _job,
    jobSetId: _set,
    batchIndex: _idx,
    idempotencyKey: _key,
    source: _src,
    canvas: _canvas,
    ...stable
  } = frozen;
  return hashCanonical({ ...stable, modelKey: manifest.key });
}

function randomSeed(): number {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!;
}

/** Drops undefined fields so the frozen JSON stays tidy. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
