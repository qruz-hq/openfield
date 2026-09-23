import type {
  CredentialSchema,
  CredentialValues,
  Diagnostic,
  ModelKey,
  ModelManifest,
  PriceTable,
  ProviderMeta,
} from "@openfield/core";
import type { ImageModel } from "./model";

// §6.2. Data shapes (ProviderMeta, CredentialSchema, …) are core schemas; these carry behaviour.

/** A plain fetch signature, so the server's wrapped fetch and test stubs both fit. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Provider {
  readonly meta: ProviderMeta;
  readonly credentials: CredentialSchema;

  /** Shape-only check. Pure, no network. Drives inline Settings validation. */
  validateCredentials(values: CredentialValues): Diagnostic[];

  /** One free round-trip that proves the key works. Settings > "Check key". */
  verifyCredentials(ctx: CallContext): Promise<{ ok: true; note?: string; modelCount?: number }>;

  /** The static catalog. Pure, so the app boots and shows models with no key and no network. */
  catalog(): ModelManifest[];

  /**
   * The catalog plus any discovered ids recognise() accepts (§6.4). Throws a ProviderError when
   * discovery fails, so the registry can report it and keep serving the catalog.
   */
  listModels(ctx: CallContext): Promise<ModelManifest[]>;

  /** Optional raw discovery: every id the provider lists, recognised or not (§0.3). */
  discoverIds?(ctx: CallContext): Promise<string[]>;

  /** Does this adapter claim this provider-native id? Pure. Gates discovery. */
  recognise(modelId: string): boolean;

  /**
   * Optional: the cataloged id a preview or dated snapshot belongs to. When the key lists that id
   * too, discovery skips the variant, so the picker doesn't show one model twice. Pure.
   */
  variantOf?(modelId: string): string | undefined;

  /**
   * Binds a model to callable behaviour. Pass a manifest to bind an entry from discovery or the
   * person's own model list. Throws UnknownModelError for keys this adapter can't serve.
   */
  model(key: ModelKey, manifest?: ModelManifest): ImageModel;

  /** Optional: fetch the provider's current prices. Never applied silently (§6.9). */
  refreshPricing?(ctx: CallContext): Promise<PriceTable | null>;
}

export interface CallContext {
  /** Injected by the server; never logged. */
  credentials: CredentialValues;
  /** The only way out. The server's version adds timeouts, redacted logging and the host allow-list. */
  fetch: FetchLike;
  signal: AbortSignal;
  log: RedactingLogger;
  now: () => number;
  /** Where image bytes go in and out. Adapters never return base64 or data URLs. */
  assets: AssetSink;
}

export interface WrittenAsset {
  assetId: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface StoredAsset {
  assetId: string;
  /** Sniffed from the bytes at ingest, not the declared type. */
  mimeType: string;
  width: number;
  height: number;
  bytes: Uint8Array;
}

export interface AssetSink {
  /** Streams bytes into the ingest path (§8.5.1) and returns the written asset. */
  write(
    stream: ReadableStream<Uint8Array>,
    meta: { mimeType: string; sourceUrl?: string },
  ): Promise<WrittenAsset>;
  /**
   * Reads a stored asset for upload: a reference, an edit base or a mask. Requests carry asset ids
   * only (§0.9), so this is how an adapter gets their bytes. Not in the PRD's §6.2 sketch.
   */
  read(assetId: string): Promise<StoredAsset>;
}

export interface RedactingLogger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** Applies the §6.11 redaction chain to any value before it is stored or displayed. */
  scrub<T>(value: T): T;
}

export class UnknownModelError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Unknown model ${key}`);
    this.name = "UnknownModelError";
    this.key = key;
  }
}
