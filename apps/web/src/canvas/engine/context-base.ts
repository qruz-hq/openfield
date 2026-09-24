import type {
  ModelListItem,
  ProviderSettingsResponse,
  ProviderSummary,
  Settings,
  SpeedId,
} from "@openfield/core";
import { runSpeed } from "../../lib/provider-settings";
import type { EngineContext } from "./types";

// The engine's view of the app: enabled models with their manifests, the defaults from Settings,
// which companies are turned off and the speed each company's settings pick. Pure; ./context.ts
// builds it from the queries.

export function buildEngineContext(
  models: readonly ModelListItem[],
  settings: Pick<Settings, "defaultModel" | "defaultBatch" | "defaultAspect"> | undefined,
  providers: readonly Pick<ProviderSummary, "id" | "enabled">[] | undefined,
  providerSettings?: ReadonlyMap<string, ProviderSettingsResponse>,
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
    runSpeed: (model) => runSpeed(providerSettings?.get(model.providerId), model),
  };
}

/** The speed a model runs at, so every price on the canvas follows its company's settings. */
export const speedOf = (ctx: EngineContext, model: ModelListItem): SpeedId =>
  ctx.runSpeed?.(model).speed ?? "standard";

export const EMPTY_ENGINE_CONTEXT: EngineContext = buildEngineContext([], undefined, undefined);
