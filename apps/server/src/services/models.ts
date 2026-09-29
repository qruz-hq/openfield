import { existsSync, readFileSync } from "node:fs";
import {
  type ModelKey,
  type ModelManifest,
  type ModelsListResponse,
  type ModelsRefreshResponse,
  modalityOf,
  modelManifestSchema,
  type RefreshReport,
  safeParseModelKey,
} from "@openfield/core";
import {
  type Db,
  getProvider,
  listModels,
  listProviders,
  type NewModelRow,
  removeModels,
  upsertModels,
} from "@openfield/db";
import {
  createModelRegistry,
  type ImageModel,
  type ModelRegistry,
  manifestOnly,
  type Provider,
  UnknownModelError,
} from "@openfield/providers/server";
import type { EventHub } from "../events/hub";
import type { Ingest } from "../files/ingest";
import { ApiFailure } from "../http/errors";
import type { Logger } from "../log/logger";
import { toModelListItem } from "../mappers/provider";
import { type CallContexts, noWrites } from "../runner/provider-fetch";
import type { CredentialService } from "./credentials";
import type { SettingsService } from "./settings";

// The model registry service (§6.4). Manifests always come from code: the static catalogs,
// recognised discoveries (re-derived from their ids after a restart) and the person's own
// models.json. The models table remembers what was discovered and what the person turned off.

const DISCOVERY_TIMEOUT_MS = 30_000;
const HOUR = 3_600_000;

export interface ModelServiceOptions {
  providers: readonly Provider[];
  db: Db;
  credentials: CredentialService;
  settings: SettingsService;
  events: EventHub;
  logger: Logger;
  contexts: CallContexts;
  ingest: Ingest;
  modelsJson: string;
}

export interface BoundModel {
  provider: Provider;
  manifest: ModelManifest;
  model: ImageModel;
}

export class ModelService {
  readonly #manifests = new Map<string, ModelManifest>();
  readonly #unrecognised = new Map<string, RefreshReport["unrecognised"]>();
  readonly #registry: ModelRegistry;
  #refreshing: Promise<ModelsRefreshResponse> | null = null;

  constructor(private readonly opts: ModelServiceOptions) {
    this.#registry = createModelRegistry({
      providers: opts.providers,
      hasCredentials: (id) => opts.credentials.resolve(id).present,
      // No context means no call: the check skips it like a company with no key.
      context: (id) =>
        this.#asks(id)
          ? opts.contexts.for(
              this.#provider(id),
              AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
              noWrites((assetId) => opts.ingest.read(assetId)),
            )
          : null,
    });
  }

  /** Builds the list from code and the models table. Runs at boot, before any request. */
  init(): void {
    const overlay = loadModelsJson(this.opts.modelsJson, this.opts.logger).map((m) => this.#fromAdapter(m));
    this.#registry.setOverlay(overlay);

    for (const provider of this.opts.providers) {
      for (const manifest of provider.catalog()) this.#manifests.set(manifest.key, manifest);
    }
    for (const row of listModels(this.opts.db)) {
      if (row.source !== "discovered") continue;
      const provider = this.opts.providers.find((p) => p.meta.id === row.providerId);
      const key = `${row.providerId}:${row.modelId}` as ModelKey;
      if (!provider?.recognise(row.modelId) || this.#manifests.has(key)) continue;
      try {
        this.#manifests.set(key, manifestOnly(provider.model(key)));
      } catch {
        // No longer recognised by this build: it drops out of the list.
      }
    }
    for (const manifest of overlay) {
      if (this.opts.providers.some((p) => p.meta.id === manifest.providerId)) {
        this.#manifests.set(manifest.key, { ...manifest, source: "user" });
      }
    }
    this.#persist(this.opts.providers.map((p) => p.meta.id));
  }

  get(key: string): ModelManifest | undefined {
    return this.#manifests.get(key);
  }

  /** A model ready to call. Throws UnknownModelError for keys no adapter serves or a company turned off. */
  bind(key: string): BoundModel {
    const manifest = this.#manifests.get(key);
    const provider = this.opts.providers.find((p) => p.meta.id === safeParseModelKey(key)?.providerId);
    if (!manifest || !provider || getProvider(this.opts.db, provider.meta.id)?.enabled === false) {
      throw new UnknownModelError(key);
    }
    return { provider, manifest, model: provider.model(manifest.key, manifest) };
  }

  /**
   * An early company (meta.stable false, §6.2): its models stay off the list until Settings >
   * Experimental shows them, and are never picked for the person.
   */
  early(providerId: string): boolean {
    return this.opts.providers.find((p) => p.meta.id === providerId)?.meta.stable === false;
  }

  /**
   * Whether the model check may call this company: it has a key, and isn't a hidden early one. A
   * key found in the environment is never sent to a company the person can't see.
   */
  #asks(providerId: string): boolean {
    const shown = !this.early(providerId) || this.opts.settings.get().showExperimental;
    return shown && this.opts.credentials.resolve(providerId).present;
  }

  /**
   * The models to show. `modality` defaults to image, so everything written before video (the
   * composer, agents' tools, the canvas's image nodes) never meets a video model; "all" lists every
   * one.
   */
  list(query: { provider?: string | undefined; modality?: string | undefined } = {}): ModelsListResponse {
    const showEarly = this.opts.settings.get().showExperimental;
    const providerEnabled = new Map(listProviders(this.opts.db).map((r) => [r.id, r.enabled]));
    const modelEnabled = new Map(
      listModels(this.opts.db).map((r) => [`${r.providerId}:${r.modelId}`, r.enabled]),
    );
    const ready = new Map(
      this.opts.providers.map((p) => [
        p.meta.id,
        (providerEnabled.get(p.meta.id) ?? true) && this.opts.credentials.usable(p.meta.id),
      ]),
    );
    const modality = query.modality ?? "image";
    const manifests = [...this.#manifests.values()].filter(
      (m) => modality === "all" || modalityOf(m) === modality,
    );
    return {
      models: manifests
        .filter((m) => !query.provider || m.providerId === query.provider)
        .filter((m) => showEarly || !this.early(m.providerId))
        .map((m) =>
          toModelListItem(m, {
            ready: ready.get(m.providerId) ?? false,
            enabled: (modelEnabled.get(m.key) ?? true) && (providerEnabled.get(m.providerId) ?? true),
          }),
        ),
      staleAt: this.staleAt(),
    };
  }

  /** Ids a provider listed that no adapter recognises, for Settings > Models > Not supported. */
  unrecognised(providerId: string): RefreshReport["unrecognised"] {
    return this.#unrecognised.get(providerId) ?? [];
  }

  staleAt(): string | null {
    const { modelRefreshedAt, modelRefreshHours } = this.opts.settings.get();
    if (!modelRefreshedAt) return null;
    return new Date(Date.parse(modelRefreshedAt) + modelRefreshHours * HOUR).toISOString();
  }

  isStale(now = Date.now()): boolean {
    const staleAt = this.staleAt();
    return staleAt === null || Date.parse(staleAt) <= now;
  }

  /** Background refresh when the list is older than modelRefreshHours (default 24 h). */
  async refreshIfStale(): Promise<void> {
    if (!this.isStale()) return;
    if (!this.opts.providers.some((p) => this.opts.credentials.resolve(p.meta.id).present)) return;
    try {
      await this.refresh();
    } catch (err) {
      this.opts.logger.warn("Couldn't update the model list", { error: err });
    }
  }

  /** Asks each provider with a key for its models. A failure keeps the last good list. */
  refresh(providerId?: string): Promise<ModelsRefreshResponse> {
    if (providerId !== undefined) this.#provider(providerId);
    // One refresh at a time; a second caller waits for the first and then runs its own.
    const run = (this.#refreshing ?? Promise.resolve()).then(
      () => this.#refresh(providerId),
      () => this.#refresh(providerId),
    );
    this.#refreshing = run;
    return run.finally(() => {
      if (this.#refreshing === run) this.#refreshing = null;
    });
  }

  async #refresh(providerId?: string): Promise<ModelsRefreshResponse> {
    const withKey = this.opts.providers
      .filter((p) => providerId === undefined || p.meta.id === providerId)
      .filter((p) => this.#asks(p.meta.id))
      .map((p) => p.meta.id);
    const reports = await this.#registry.refresh(providerId);
    const fresh = this.#registry.models();
    const out: ModelsRefreshResponse = { added: [], updated: [], removed: [], errors: [] };
    const refreshed: string[] = [];

    for (const report of reports) {
      const id = report.providerId;
      if (report.error) {
        out.errors.push({ providerId: id, code: report.error.code, message: report.error.userMessage });
        this.opts.logger.warn("Couldn't update the model list", { providerId: id, error: report.error });
        continue;
      }
      if (!withKey.includes(id)) continue;
      refreshed.push(id);
      this.#unrecognised.set(id, report.unrecognised);

      const change = { added: [] as ModelKey[], updated: [] as ModelKey[], removed: [] as ModelKey[] };
      const next = new Map<string, ModelManifest>(
        fresh.filter((m) => m.providerId === id).map((m) => [m.key, m]),
      );
      for (const [key, old] of this.#manifests) {
        if (old.providerId !== id || next.has(key)) continue;
        this.#manifests.delete(key);
        change.removed.push(old.key);
      }
      for (const [key, manifest] of next) {
        const old = this.#manifests.get(key);
        if (!old) change.added.push(manifest.key);
        else if (JSON.stringify(old) !== JSON.stringify(manifest)) change.updated.push(manifest.key);
        this.#manifests.set(key, manifest);
      }
      out.added.push(...change.added);
      out.updated.push(...change.updated);
      out.removed.push(...change.removed);
      if (change.added.length || change.updated.length || change.removed.length) {
        this.opts.events.publish("models.updated", { providerId: id, ...change });
      }
    }

    if (refreshed.length) {
      this.#persist(refreshed);
      this.opts.settings.update({ modelRefreshedAt: new Date().toISOString() });
    }
    return out;
  }

  /**
   * Whether a call picks up after a restart, and whether its create can be sent again with the same
   * key, are facts about the adapter's code, not data (§6.3). A models.json entry replaces the whole
   * manifest, often only to change a price, so both always come from the adapter's own manifest for
   * that key, and an entry that says otherwise is ignored with a warning. Adding a speed would mark a
   * blocking call resumable, so a crash would interrupt it instead of running it again; leaving one
   * out would make the runner drop a live call after a crash and send a second one.
   */
  #fromAdapter(manifest: ModelManifest): ModelManifest {
    const { resumableSpeeds, idempotentSubmit, ...rest } = manifest;
    const own = this.#adapterManifest(manifest);
    // Only speeds this entry still offers: a resumable speed must be one the model has.
    const kept = (own?.resumableSpeeds ?? []).filter(
      (speed) => speed === "standard" || rest.speeds?.some((o) => o.id === speed && o.delivery === "sync"),
    );
    const listed = resumableSpeeds !== undefined && !sameSpeeds(resumableSpeeds, kept);
    const sameKey = own?.idempotentSubmit === true;
    if (listed || (idempotentSubmit !== undefined && idempotentSubmit !== sameKey)) {
      this.opts.logger.warn("A model in models.json can't change whether it picks up after a restart", {
        model: manifest.key,
      });
    }
    return {
      ...rest,
      ...(kept.length > 0 && { resumableSpeeds: kept }),
      ...(sameKey && { idempotentSubmit: true as const }),
    };
  }

  /** The manifest the adapter itself gives this key: its catalog, or a model it recognises. */
  #adapterManifest(manifest: ModelManifest): ModelManifest | undefined {
    const provider = this.opts.providers.find((p) => p.meta.id === manifest.providerId);
    if (!provider) return undefined;
    const listed = provider.catalog().find((m) => m.key === manifest.key);
    if (listed || !provider.recognise(manifest.modelId)) return listed;
    try {
      return manifestOnly(provider.model(manifest.key));
    } catch {
      return undefined;
    }
  }

  #provider(id: string): Provider {
    const provider = this.opts.providers.find((p) => p.meta.id === id);
    if (!provider)
      throw new ApiFailure(404, "not_found", `No company called "${id}"`, { field: "providerId" });
    return provider;
  }

  /** Mirrors the list into the models table. `enabled` is the person's and survives. */
  #persist(providerIds: string[]): void {
    const now = new Date().toISOString();
    for (const id of providerIds) {
      const manifests = [...this.#manifests.values()].filter((m) => m.providerId === id);
      const rows: Omit<NewModelRow, "updatedAt">[] = manifests.map((m, i) => ({
        providerId: m.providerId,
        modelId: m.modelId,
        displayName: m.displayName,
        family: m.family ?? null,
        modality: modalityOf(m),
        badges: m.badges ?? null,
        capabilities: m.capabilities,
        pricing: m.price,
        speeds: m.speeds ?? null,
        source: m.source,
        sortOrder: i,
        discoveredAt: m.source === "discovered" ? now : null,
      }));
      upsertModels(this.opts.db, rows);
      const keep = new Set(manifests.map((m) => m.modelId));
      const stale = listModels(this.opts.db, { providerId: id })
        .map((r) => r.modelId)
        .filter((modelId) => !keep.has(modelId));
      removeModels(this.opts.db, id, stale);
    }
  }
}

/**
 * ~/.openfield/models.json: `[manifest, …]` or `{ "models": [...] }`. Entries that don't match the
 * manifest schema are skipped with a warning naming the entry and the field.
 */
function loadModelsJson(file: string, logger: Logger): ModelManifest[] {
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    logger.warn("models.json isn't valid JSON, so it was skipped");
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) {
    logger.warn("models.json should be a list of models, so it was skipped");
    return [];
  }
  const out: ModelManifest[] = [];
  list.forEach((entry, index) => {
    const parsed = modelManifestSchema.safeParse({ ...(entry as object), source: "user" });
    if (parsed.success) out.push(parsed.data);
    else {
      const issue = parsed.error.issues[0];
      logger.warn("Skipped a model in models.json", {
        index,
        field: issue?.path.join("."),
        problem: issue?.message,
      });
    }
  });
  return out;
}

const sameSpeeds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((speed) => b.includes(speed));
