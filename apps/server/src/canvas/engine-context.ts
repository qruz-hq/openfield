import { buildEngineContext, type EngineContext } from "@openfield/canvas";
import type { ProviderSettingsResponse } from "@openfield/core";
import type { Db } from "@openfield/db";
import type { Provider } from "@openfield/providers/server";
import type { CredentialService } from "../services/credentials";
import type { ModelService } from "../services/models";
import type { ProviderSettingsService } from "../services/provider-settings";
import { providerSummaries } from "../services/provider-summaries";
import type { SettingsService } from "../services/settings";

// The canvas engine's view of the app, built on the server from the same data the editor builds its
// own from (the models, settings, providers and provider settings it queries), so a canvas compiled
// here plans, prices and caches exactly as it would in a tab (§7.7).

export interface EngineContextDeps {
  db: Db;
  providers: readonly Provider[];
  credentials: CredentialService;
  models: ModelService;
  settings: SettingsService;
  providerSettings: ProviderSettingsService;
}

export function serverEngineContext(deps: EngineContextDeps): EngineContext {
  // Every model: image nodes keep to image models themselves, and the Video node to video ones.
  const { models } = deps.models.list({ modality: "all" });
  const providers = providerSummaries(deps);
  const speeds = new Map<string, ProviderSettingsResponse>(
    providers.map((p) => [p.id, deps.providerSettings.view(p.id)]),
  );
  return buildEngineContext(models, deps.settings.get(), providers, speeds);
}
