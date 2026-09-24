import type { ModelListItem, ProviderSummary, Settings } from "@openfield/core";
import type { EngineContext } from "./types";

// The engine's view of the app: enabled models with their manifests, the defaults from Settings,
// and which companies are turned off. Pure; ./context.ts builds it from the queries.

export function buildEngineContext(
  models: readonly ModelListItem[],
  settings: Pick<Settings, "defaultModel" | "defaultBatch" | "defaultAspect"> | undefined,
  providers: readonly Pick<ProviderSummary, "id" | "enabled">[] | undefined,
): EngineContext {
  const byKey = new Map(models.map((m) => [m.key as string, m]));
  const wanted = settings?.defaultModel;
  const defaultModel =
    (wanted && byKey.has(wanted) ? wanted : null) ??
    models.find((m) => m.ready)?.key ??
    models[0]?.key ??
    null;
  const off = new Set(providers?.filter((p) => !p.enabled).map((p) => p.id));
  return {
    models,
    model: (key) => (key ? byKey.get(key) : undefined),
    defaultModel,
    defaultBatch: settings?.defaultBatch ?? 1,
    defaultAspect: settings?.defaultAspect ?? null,
    companyOff: (providerId) => off.has(providerId),
  };
}

export const EMPTY_ENGINE_CONTEXT: EngineContext = buildEngineContext([], undefined, undefined);
