import { buildEngineContext } from "@openfield/canvas/engine/context-base";
import type { EngineContext } from "@openfield/canvas/engine/types";
import { useMemo } from "react";
import { useProviders } from "../../api/hooks/keys";
import { useModels } from "../../api/hooks/models";
import { useAllProviderSettings } from "../../api/hooks/provider-settings";
import { useSettings } from "../../api/hooks/settings";
import { askedPrice } from "../../lib/remote-price";

export { buildEngineContext, EMPTY_ENGINE_CONTEXT, speedOf } from "@openfield/canvas/engine/context-base";

// The engine context from the models, settings, providers and company settings queries.
// CanvasEngine builds it once and shares it through the engine store; nodes read it there
// (useCanvasEngineContext).

/** The context, and whether models and settings have arrived (fingerprints wait for both). */
export function useEngineContextState(): { ctx: EngineContext; ready: boolean } {
  const models = useModels();
  const settings = useSettings();
  const providers = useProviders().data;
  const speeds = useAllProviderSettings();
  const ctx = useMemo(
    () => buildEngineContext(models.data ?? [], settings.data, providers, speeds, askedPrice),
    [models.data, settings.data, providers, speeds],
  );
  // The default model comes from Settings, so both have to be in before anything is hashed.
  return { ctx, ready: (models.isSuccess || models.isError) && (settings.isSuccess || settings.isError) };
}

export const useEngineContext = (): EngineContext => useEngineContextState().ctx;
