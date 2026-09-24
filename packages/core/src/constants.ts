// Every enum lives here once. Zod enums, Drizzle column types and SQL CHECK lists are built
// from these arrays, so a value can't exist in one place and be missing from another (§0.16).

// Jobs (§0.4)
export const MODALITIES = ["image", "video", "audio"] as const;
export type Modality = (typeof MODALITIES)[number];

export const JOB_STATES = [
  "pending",
  "submitting",
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JOB_SET_STATES = [...JOB_STATES, "partial"] as const;
export type JobSetState = (typeof JOB_SET_STATES)[number];

export const ACTIVE_JOB_STATES = ["pending", "submitting", "queued", "running"] as const;
export type ActiveJobState = (typeof ACTIVE_JOB_STATES)[number];

export const TERMINAL_JOB_STATES = ["succeeded", "failed", "canceled", "interrupted"] as const;
export const TERMINAL_JOB_SET_STATES = [...TERMINAL_JOB_STATES, "partial"] as const;

export const isTerminalState = (state: JobSetState): boolean =>
  (TERMINAL_JOB_SET_STATES as readonly string[]).includes(state);

export const OPS = [
  "generate",
  "edit",
  "inpaint",
  "outpaint",
  "variation",
  "upscale",
  "remove_bg",
  "text_edit",
  "relight",
  "angles",
  "enhance",
  "decompose",
  "crop",
  "grade",
  "overlay",
] as const;
export type Op = (typeof OPS)[number];

/** Every op except "generate": what POST /api/edit accepts. */
export const EDIT_OPS = [
  "edit",
  "inpaint",
  "outpaint",
  "variation",
  "upscale",
  "remove_bg",
  "text_edit",
  "relight",
  "angles",
  "enhance",
  "decompose",
  "crop",
  "grade",
  "overlay",
] as const satisfies readonly Exclude<Op, "generate">[];
export type EditOp = (typeof EDIT_OPS)[number];

/** The subset an adapter is ever asked to perform. */
export const ADAPTER_OPS = ["generate", "edit", "inpaint", "outpaint", "upscale", "remove_bg"] as const;
export type AdapterOp = (typeof ADAPTER_OPS)[number];

/** Ops that never reach a provider: provider_id 'local', cost 0, generative 0. */
export const LOCAL_OPS = ["crop", "grade", "overlay"] as const;
export type LocalOp = (typeof LOCAL_OPS)[number];
export const LOCAL_PROVIDER_ID = "local";

export const JOB_SOURCES = ["composer", "detail_editor", "canvas", "api", "recreate"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

/** UI cap, observed parity. Raising it needs a migration and a manifest change (§0.10). */
export const BATCH_MAX = 4;

// Speeds (§0.3). "speed" everywhere in code, because "tier" already means resolution tiers.
export const SPEED_IDS = ["standard", "flex", "priority", "batch"] as const;
export type SpeedId = (typeof SPEED_IDS)[number];
export const DEFAULT_SPEED: SpeedId = "standard";

/** sync: the same call answers. async: results arrive later from a provider batch (§0.4). */
export const SPEED_DELIVERIES = ["sync", "async"] as const;
export type SpeedDelivery = (typeof SPEED_DELIVERIES)[number];

// Provider batches (§0.4, §6.7): one per job set that runs at the Batch speed.
export const BATCH_STATES = [
  "submitting",
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "expired",
] as const;
export type BatchState = (typeof BATCH_STATES)[number];
export const ACTIVE_BATCH_STATES = ["submitting", "queued", "running"] as const;
export const TERMINAL_BATCH_STATES = ["succeeded", "failed", "canceled", "expired"] as const;
export const isTerminalBatchState = (state: BatchState): boolean =>
  (TERMINAL_BATCH_STATES as readonly string[]).includes(state);

// Runner numbers for speeds (§0.12). The server schedules; the numbers live here so copy agrees.
/** Whole-job wall clock at Flex, busy waits included. */
export const FLEX_JOB_DEADLINE_MS = 3_600_000;
/** Waits after each Flex busy answer; the last one repeats. Retry-After wins. */
export const FLEX_BUSY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const;
/** Time since submit, then how often to poll a waiting provider batch. */
export const BATCH_POLL_SCHEDULE = [
  { untilMs: 600_000, everyMs: 30_000 },
  { untilMs: 3_600_000, everyMs: 120_000 },
  { untilMs: Number.POSITIVE_INFINITY, everyMs: 300_000 },
] as const;
/** Every poll step in fake mode, so a fake batch lands in seconds. */
export const FAKE_BATCH_POLL_MS = 1_000;
/** A provider batch still unfinished this long after its provider expiry fails with timeout. */
export const BATCH_DEADLINE_GRACE_MS = 6 * 3_600_000;
/** A provider batch's expiry when neither its manifest nor its dates say: Google's 48 hours. */
export const DEFAULT_BATCH_EXPIRY_MS = 48 * 3_600_000;

/** How long to wait before the next poll of a batch sent `elapsedMs` ago (§0.12). */
export function batchPollIntervalMs(elapsedMs: number, opts: { fake?: boolean } = {}): number {
  if (opts.fake) return FAKE_BATCH_POLL_MS;
  return (BATCH_POLL_SCHEDULE.find((step) => elapsedMs < step.untilMs) ?? BATCH_POLL_SCHEDULE[2]).everyMs;
}

/** The wait before retrying the `busyCount`th Flex busy answer (1 for the first), without jitter. */
export function flexBusyDelayMs(busyCount: number): number {
  const i = Math.min(Math.max(1, busyCount), FLEX_BUSY_BACKOFF_MS.length) - 1;
  return FLEX_BUSY_BACKOFF_MS[i]!;
}

// Provider settings (§0.3)
export const SETTING_FIELD_KINDS = ["select", "toggle", "number", "text"] as const;
export type SettingFieldKind = (typeof SETTING_FIELD_KINDS)[number];
export const SETTING_NUMBER_CONTROLS = ["stepper", "input"] as const;
/** Why a stored value didn't apply to a model and its default or first offer did. */
export const SETTING_NOTE_REASONS = ["field_not_for_model", "option_not_for_model"] as const;
export type SettingNoteReason = (typeof SETTING_NOTE_REASONS)[number];
/** Openfield's own panel, appended after the adapter's. Adapters may not use these ids. */
export const LIMITS_PANEL_ID = "limits";
export const CONCURRENCY_CAP_FIELD = "concurrencyCap";

// Errors (§0.5)
export const ERROR_CODES = [
  "auth_missing",
  "auth_invalid",
  "auth_forbidden",
  "billing_required",
  "quota_exceeded",
  "rate_limited",
  "content_refused",
  "content_flagged_input",
  "unsupported_param",
  "capability_unsupported",
  "invalid_request",
  "payload_too_large",
  "provider_unavailable",
  "provider_error",
  "network",
  "timeout",
  "disk_full",
  "canceled",
  "unknown",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const RETRYABLE_ERROR_CODES = ["network", "timeout", "rate_limited", "provider_unavailable"] as const;
export const isRetryable = (code: ErrorCode): boolean =>
  (RETRYABLE_ERROR_CODES as readonly string[]).includes(code);

/** HTTP-only codes. A provider failure reaches the client as its ErrorCode instead. */
export const TRANSPORT_ERROR_CODES = ["bad_request", "not_found", "conflict", "internal"] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

/** The primary action a failed tile offers for each code (§0.5). */
export const ERROR_ACTIONS = [
  "open-settings",
  "change-key",
  "open-billing",
  "try-again",
  "reuse",
  "details",
  "free-up-space",
  "recreate",
] as const;
export type ErrorAction = (typeof ERROR_ACTIONS)[number];

export const ERROR_PRIMARY_ACTION: Record<ErrorCode, ErrorAction> = {
  auth_missing: "open-settings",
  auth_invalid: "change-key",
  auth_forbidden: "change-key",
  billing_required: "open-billing",
  quota_exceeded: "open-billing",
  rate_limited: "try-again",
  content_refused: "reuse",
  content_flagged_input: "reuse",
  unsupported_param: "reuse",
  capability_unsupported: "reuse",
  invalid_request: "details",
  payload_too_large: "details",
  provider_unavailable: "details",
  provider_error: "details",
  network: "try-again",
  timeout: "try-again",
  disk_full: "free-up-space",
  canceled: "recreate",
  unknown: "details",
};

/** Hints an adapter may attach to a ProviderError (§6.8). */
export const ERROR_HINT_ACTIONS = ["open-settings", "open-model-picker", "edit-prompt", "retry"] as const;
export type ErrorHintAction = (typeof ERROR_HINT_ACTIONS)[number];

// Providers and models (§6.2, §8.2)
export const AUTH_KINDS = ["api_key", "key_secret_pair", "none"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

export const CREDENTIAL_SOURCES = ["env", "file", "unset"] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

export const MODEL_SOURCES = ["static", "discovered", "user"] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

export const MODEL_BADGES = ["new", "preview", "legacy", "experimental"] as const;
export type ModelBadge = (typeof MODEL_BADGES)[number];

// Manifest vocabulary (§0.3, §6.3)
export const CONTROL_IDS = [
  "model",
  "aspect",
  "size",
  "resolution",
  "quality",
  "batch",
  "seed",
  "negativePrompt",
  "promptEnhance",
  "background",
  "references",
  "referenceStrength",
  "outputFormat",
  "moderation",
  "advanced",
  "palette",
] as const;
export type ControlId = (typeof CONTROL_IDS)[number];

/** Rendered disabled with a reason when unsupported, so the bar never jumps between models. */
export const CORE_CONTROL_IDS = ["model", "aspect", "resolution", "quality", "batch", "seed"] as const;

export const CONTROL_STATES = ["supported", "partial", "emulated", "unsupported", "absent"] as const;
export type ControlState = (typeof CONTROL_STATES)[number];

export const ASPECT_RATIOS = [
  "auto",
  "1:1",
  "2:1",
  "1:2",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "5:4",
  "4:5",
  "6:10",
  "14:10",
  "10:14",
  "16:9",
  "9:16",
  "21:9",
  "27:16",
  "16:27",
  "9:8",
  "8:9",
  "1:4",
  "4:1",
  "1:8",
  "8:1",
] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const RESOLUTION_TIERS = ["512", "1K", "1.5K", "2K", "4K"] as const;
export type ResolutionTier = (typeof RESOLUTION_TIERS)[number];

/** Long-edge target in pixels per tier. */
export const RESOLUTION_TIER_PX: Record<ResolutionTier, number> = {
  "512": 512,
  "1K": 1024,
  "1.5K": 1536,
  "2K": 2048,
  "4K": 4096,
};

export const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const REFERENCE_ROLES = ["subject", "style", "palette", "composition", "base", "mask"] as const;
export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

export const REFERENCE_STRENGTH_MODES = ["per-image", "global", "none"] as const;
export const PROMPT_ENHANCE_MODES = ["native", "openfield", "none"] as const;
export const BACKGROUND_VALUES = ["auto", "opaque", "transparent"] as const;
export type Background = (typeof BACKGROUND_VALUES)[number];
export const UNSUPPORTED_PARAM_POLICIES = ["reject", "drop-with-warning"] as const;
export const SIZE_MODES = ["aspect", "enum", "free"] as const;
export const SIZE_SPEC_KINDS = ["auto", "aspect", "pixels"] as const;
export const DIAGNOSTIC_LEVELS = ["error", "warning"] as const;

// Cost (§0.13)
export const PRICE_KINDS = ["per_image", "per_token", "per_second", "provider_estimate", "unknown"] as const;
export const ESTIMATE_CONFIDENCES = ["exact", "estimated", "unknown"] as const;
export type EstimateConfidence = (typeof ESTIMATE_CONFIDENCES)[number];
export const COST_SOURCES = ["reconciled", "estimated", "unknown"] as const;
export type CostSource = (typeof COST_SOURCES)[number];
export const USAGE_OUTCOMES = ["succeeded", "failed", "canceled"] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];
export const USAGE_GROUP_BY = ["day", "model", "provider"] as const;
export const DEFAULT_CURRENCY = "USD";

// Assets and files (§0.7, §8.2)
export const ASSET_KINDS = ["generated", "uploaded", "imported", "edited", "mask"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const FILE_STATES = ["ok", "missing", "quarantined"] as const;
export type FileState = (typeof FILE_STATES)[number];

export const EDGE_RELATIONS = ["derived", "reference", "import"] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const UPLOAD_MIME_TYPES = [...IMAGE_MIME_TYPES, "image/heic"] as const;
export const UPLOAD_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".heic"] as const;

export const BULK_ACTIONS = [
  "delete",
  "favourite",
  "unfavourite",
  "addFolder",
  "removeFolder",
  "download",
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export const ASSET_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

// Thumbnails (§0.10): one height-keyed ladder, feed zoom step i uses rung i.
export const THUMB_RUNGS = [200, 280, 360, 456, 640] as const;
export type ThumbRung = (typeof THUMB_RUNGS)[number];
export const DETAIL_PREVIEW_EDGE = 1440;
export const THUMB_DPRS = [1, 2] as const;
export const FEED_ZOOM_STEPS = [0, 1, 2, 3, 4] as const;
export type FeedZoomStep = (typeof FEED_ZOOM_STEPS)[number];
export const DEFAULT_FEED_ZOOM: FeedZoomStep = 3;
export const MAX_FEED_ZOOM: FeedZoomStep = 4;

/** The most runs at once, overall and per company (§0.12). */
export const MAX_CONCURRENCY = 16;

/** How thumbnails are served: resized by sharp, or the originals when sharp won't load. */
export const THUMB_ENGINES = ["sharp", "originals"] as const;
export type ThumbEngine = (typeof THUMB_ENGINES)[number];

// Presets, references, characters, palettes (§0.8, §5)
export const PRESET_KINDS = ["style", "reference-set", "character", "palette"] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];
export const PRESET_ASSET_ROLES = ["reference", "palette", "thumb"] as const;
export const REFERENCE_SET_ROLES = ["style", "subject", "composition", "palette"] as const;
export type ReferenceSetRole = (typeof REFERENCE_SET_ROLES)[number];
export const CHARACTER_INJECTIONS = ["prefix", "suffix", "replace-token"] as const;
export const PALETTE_MODES = ["prompt", "reference", "both"] as const;
export const PRESET_SCHEMA_VERSION = 1;
/** The preset template slot. Single brace, exactly once (§0.8). */
export const PROMPT_SLOT = "{prompt}";

// Canvas (§7)
export const CANVAS_RUN_SCOPES = ["node", "downstream", "all", "selection"] as const;
export type CanvasRunScope = (typeof CANVAS_RUN_SCOPES)[number];
export const CANVAS_NODE_TYPES = [
  "prompt",
  "image.upload",
  "image.asset",
  "image.generate",
  "image.edit",
  "image.upscale",
  "image.variations",
  "preset",
  "note",
  "frame",
  "shape",
  "text",
  "text.llm",
  "table",
] as const;
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];
export const CANVAS_PORT_TYPES = ["text", "image", "mask", "preset", "video", "audio"] as const;
export const CANVAS_EDGE_KINDS = ["data", "annotation"] as const;
export const CANVAS_NODE_STATES = [
  "idle",
  "queued",
  "running",
  "done",
  "cached",
  "stale",
  "failed",
  "canceled",
  "blocked",
] as const;
export type CanvasNodeState = (typeof CANVAS_NODE_STATES)[number];
export const CANVAS_SEED_MODES = ["random", "fixed", "from-input"] as const;
/**
 * Variations strategies (M4-21). same-prompt repeats one request: the server picks a new seed per
 * image where the model takes seeds (§0.11), which is M4-21's seed jitter, and plain repeats where
 * it doesn't. Documents from before the rename say "seed-jitter"; the node reads that as same-prompt.
 */
export const VARIATION_STRATEGIES = ["same-prompt", "prompt-list", "model-list"] as const;
export const CANVAS_BLOCK_REASONS = [
  "no_key",
  "model_unavailable",
  "company_off",
  "missing_input",
  /** An image it reads isn't in this library (an imported canvas, or deleted since). */
  "missing_asset",
  "upstream_failed",
] as const;
export type CanvasBlockReason = (typeof CANVAS_BLOCK_REASONS)[number];
export const CANVAS_INPUT_TARGETS = ["references", "base", "mask"] as const;
export const CANVAS_PORT_ARITIES = ["single", "multi"] as const;
export const CANVAS_VERSION_KINDS = [
  "auto",
  "named",
  "before_delete",
  "before_import",
  "before_template",
  "before_restore",
] as const;
export type CanvasVersionKind = (typeof CANVAS_VERSION_KINDS)[number];
export const CANVAS_TEMPLATE_SOURCES = ["bundled", "user"] as const;
/** A run above this many jobs needs `confirmed: true` (§7.7). */
export const CANVAS_CONFIRM_JOBS = 32;
/** No run makes more than this many jobs, confirmed or not, so no node's images outgrow a plan. */
export const CANVAS_RUN_MAX_JOBS = 1000;
/** Nodes one canvas document holds. A run plan can name every one of them (most are reused). */
export const CANVAS_MAX_NODES = 5000;
/** Index cards come in both themes, so a canvas captured in one still sits right in the other. */
export const CANVAS_PREVIEW_THEMES = ["light", "dark"] as const;
export type CanvasPreviewTheme = (typeof CANVAS_PREVIEW_THEMES)[number];
/** Index cards use a rendered preview only up to this many nodes; bigger canvases show a cover image (M4-15). */
export const CANVAS_PREVIEW_MAX_NODES = 150;
/** Snapshots the app takes by itself (automatic and safety ones) kept per canvas. Named ones all stay (§7.8). */
export const CANVAS_AUTO_VERSIONS_KEPT = 50;
/** Minimum gap between automatic snapshots (§7.8). */
export const CANVAS_AUTO_VERSION_MS = 5 * 60_000;
/**
 * Largest reference image POST /api/uploads takes: the smallest limit a launch model sets on a
 * reference (Google's 20 MB, §3.2), so every upload can go to every model.
 */
export const UPLOAD_MAX_BYTES = 20_000_000;

// Event stream (§0.6, §8.3.2)
export const SSE_EVENT_TYPES = [
  "snapshot",
  "job_set.created",
  "job.queued",
  "job.started",
  "job.progress",
  "job.partial",
  "job.output",
  "job.failed",
  "job.canceled",
  "job_set.completed",
  "batch.updated",
  "asset.updated",
  "asset.deleted",
  "folder.updated",
  "models.updated",
  "usage.updated",
  "canvas_run.updated",
  "maintenance.progress",
] as const;
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

export const MAINTENANCE_TASKS = ["gc", "backup", "reindex"] as const;

// Settings (§6.17)
export const THEMES = ["system", "dark", "light"] as const;
export type Theme = (typeof THEMES)[number];
export const ENHANCE_MODES = ["off", "preview", "auto"] as const;
export type EnhanceMode = (typeof ENHANCE_MODES)[number];
export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// Server
export const DEFAULT_PORT = 4317;
export const SESSION_HEADER = "X-Openfield-Session";
