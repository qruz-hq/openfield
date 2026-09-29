import {
  isEarly,
  type ModelListItem,
  modalityOf,
  type ProviderSettingsResponse,
  type ProviderSummary,
  type Settings,
  type SpeedId,
} from "@openfield/core";
import { type AskPrice, runSpeed } from "@openfield/providers/manifest";
import type { EngineContext } from "./types";

// The engine's view of the app: enabled models with their manifests, the defaults from Settings,
// which companies are turned off and the speed each company's settings pick. Pure; ./context.ts
// builds it from the queries.

export function buildEngineContext(
  models: readonly ModelListItem[],
  settings: Pick<Settings, "defaultModel" | "defaultBatch" | "defaultAspect"> | undefined,
  providers: readonly Pick<ProviderSummary, "id" | "enabled" | "meta">[] | undefined,
  providerSettings?: ReadonlyMap<string, ProviderSettingsResponse>,
  askPrice?: AskPrice,
): EngineContext {
  const byKey = new Map(models.map((m) => [m.key as string, m]));
  const wanted = settings?.defaultModel;
  // Never an early company's model unless the person chose it (§6.2).
  const pickable = models.filter((m) => !isEarly(providers, m.providerId));
  const images = pickable.filter((m) => modalityOf(m) === "image");
  const videos = pickable.filter((m) => modalityOf(m) === "video");
  const wantedImage = wanted && byKey.has(wanted) && modalityOf(byKey.get(wanted)!) === "image";
  const defaultModel =
    (wantedImage ? wanted : null) ?? images.find((m) => m.ready)?.key ?? images[0]?.key ?? null;
  const defaultVideoModel = videos.find((m) => m.ready)?.key ?? videos[0]?.key ?? null;
  const off = new Set(providers?.filter((p) => !p.enabled).map((p) => p.id));
  return {
    models,
    model: (key) => (key ? byKey.get(key) : undefined),
    defaultModel,
    defaultVideoModel,
    defaultBatch: settings?.defaultBatch ?? 1,
    defaultAspect: settings?.defaultAspect ?? null,
    companyOff: (providerId) => off.has(providerId),
    runSpeed: (model) => runSpeed(providerSettings?.get(model.providerId), model),
    ...(askPrice && { askPrice }),
  };
}

/** The speed a model runs at, so every price on the canvas follows its company's settings. */
export const speedOf = (ctx: EngineContext, model: ModelListItem): SpeedId =>
  ctx.runSpeed?.(model).speed ?? "standard";

export const EMPTY_ENGINE_CONTEXT: EngineContext = buildEngineContext([], undefined, undefined);
