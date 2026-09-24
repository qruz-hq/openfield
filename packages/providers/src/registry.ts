import type { ModelKey, ModelManifest, ProviderErrorData, ProviderId, RefreshReport } from "@openfield/core";
import { safeParseModelKey } from "@openfield/core";
import { createGoogleProvider } from "./google";
import { createResumableFakeProvider } from "./testing/resumable";
import {
  type CallContext,
  type ImageModel,
  isProviderError,
  type ModelRegistry,
  type Provider,
  ProviderError,
  UnknownModelError,
} from "./types";

/**
 * Every adapter Openfield ships. Static on purpose: adding one is a pull request, with no plugin
 * loading and no remote code (§6.12).
 */
export const builtinProviders: readonly Provider[] = [createGoogleProvider()];

/**
 * Companies that exist only with OPENFIELD_FAKE_PROVIDERS=1: the test company and its resumable
 * model (§6.12), so the resume path runs without keys. Never registered outside fake mode.
 */
export const fakeOnlyProviders: readonly Provider[] = [createResumableFakeProvider()];

/** The adapters a server registers: the built-ins, plus the test company in fake mode. */
export function providersFor(opts: { fake: boolean }): readonly Provider[] {
  return opts.fake ? [...builtinProviders, ...fakeOnlyProviders] : builtinProviders;
}

export interface RegistryOptions {
  providers?: readonly Provider[];
  /** True when the provider has a usable key. */
  hasCredentials: (providerId: ProviderId) => boolean;
  /** A call context for discovery, or null when the provider has no key. */
  context: (providerId: ProviderId) => CallContext | null;
  /** The person's own model list (models.json), already validated. Merged last. */
  overlay?: ModelManifest[];
  now?: () => number;
}

/**
 * §6.4: static catalog, then recognised discoveries, then the person's own list, last wins.
 * Discovery failures never empty the picker; the last good list stays and the report says why.
 */
export function createModelRegistry(opts: RegistryOptions): ModelRegistry {
  const providers = [...(opts.providers ?? builtinProviders)];
  const discovered = new Map<ProviderId, ModelManifest[]>();
  const now = opts.now ?? Date.now;
  let overlay = opts.overlay ?? [];

  const providerOf = (providerId: string) => providers.find((p) => p.meta.id === providerId);
  const current = (p: Provider) => discovered.get(p.meta.id) ?? p.catalog();

  function merged(): ModelManifest[] {
    const byKey = new Map<string, ModelManifest>();
    for (const p of providers) for (const m of current(p)) byKey.set(m.key, m);
    for (const m of overlay) {
      if (providerOf(m.providerId)) byKey.set(m.key, { ...m, source: "user" });
    }
    return [...byKey.values()];
  }

  async function refreshOne(p: Provider): Promise<RefreshReport> {
    const checkedAt = new Date(now()).toISOString();
    const report: RefreshReport = {
      providerId: p.meta.id,
      added: [],
      updated: [],
      removed: [],
      unrecognised: [],
      checkedAt,
    };
    const ctx = opts.context(p.meta.id);
    if (!ctx) return report;

    try {
      let next: ModelManifest[];
      if (p.discoverIds) {
        const ids = await p.discoverIds(ctx);
        report.unrecognised = ids
          .filter((id) => !p.recognise(id))
          .map((modelId) => ({ modelId, seenAt: checkedAt }));
        next = withDiscoveries(
          p,
          ids.filter((id) => p.recognise(id)),
        );
      } else {
        next = await p.listModels(ctx);
      }

      const before = new Map(current(p).map((m) => [m.key, m]));
      const after = new Map(next.map((m) => [m.key, m]));
      for (const [key, m] of after) {
        const old = before.get(key);
        if (!old) report.added.push(key as ModelKey);
        else if (JSON.stringify(old) !== JSON.stringify(m)) report.updated.push(key as ModelKey);
      }
      for (const key of before.keys()) if (!after.has(key)) report.removed.push(key as ModelKey);
      discovered.set(p.meta.id, next);
    } catch (err) {
      report.error = errorData(err);
    }
    return report;
  }

  return {
    providers: () => [...providers],

    models: (query) => merged().filter((m) => !query?.ready || opts.hasCredentials(m.providerId)),

    get(key): ImageModel {
      const provider = providerOf(safeParseModelKey(key)?.providerId ?? "");
      const manifest = merged().find((m) => m.key === key);
      if (!provider || !manifest) throw new UnknownModelError(key);
      return provider.model(key, manifest);
    },

    async refresh(providerId) {
      const targets =
        providerId === undefined ? providers : providers.filter((p) => p.meta.id === providerId);
      return Promise.all(targets.map(refreshOne));
    },

    setOverlay(manifests) {
      overlay = manifests;
    },
  };
}

/** The catalog plus manifests for recognised ids it doesn't already have. Static entries win. */
function withDiscoveries(p: Provider, ids: string[]): ModelManifest[] {
  const models = p.catalog();
  const known = new Set(models.map((m) => m.modelId));
  const listed = new Set(ids);
  for (const id of ids) {
    if (known.has(id)) continue;
    const base = p.variantOf?.(id);
    if (base && listed.has(base)) continue;
    try {
      models.push(manifestOnly(p.model(`${p.meta.id}:${id}`)));
      known.add(id);
    } catch (err) {
      if (!(err instanceof UnknownModelError)) throw err;
    }
  }
  return models;
}

/** The data half of a bound model: no methods, and no batch path, so it can go to the browser. */
export function manifestOnly(model: ImageModel): ModelManifest {
  const { submit: _s, poll: _p, stream: _st, cancel: _c, estimateRemote: _e, batch: _b, ...manifest } = model;
  return manifest;
}

function errorData(err: unknown): ProviderErrorData {
  if (isProviderError(err)) return err.toJSON();
  return new ProviderError("unknown", { message: err instanceof Error ? err.message : String(err) }).toJSON();
}
