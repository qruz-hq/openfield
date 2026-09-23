import type { ModelKey, ModelManifest, ProviderId, RefreshReport } from "@openfield/core";
import type { ImageModel } from "./model";
import type { Provider } from "./provider";

// §6.4

export interface ModelRegistry {
  providers(): Provider[];
  /** ready = the model's company has a usable key. */
  models(opts?: { ready?: boolean }): ModelManifest[];
  /** Throws UnknownModelError. */
  get(key: ModelKey): ImageModel;
  /** One report per provider refreshed. The PRD sketch returns one; refreshing all needs a list. */
  refresh(providerId?: ProviderId): Promise<RefreshReport[]>;
  /** Replaces the person's own model list (models.json), merged over everything else. */
  setOverlay(manifests: ModelManifest[]): void;
}
