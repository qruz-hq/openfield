import {
  errorCopy,
  type KeyStatus,
  type ModelListItem,
  type ModelManifest,
  modalityOf,
  type ProviderSummary,
} from "@openfield/core";
import type { ProviderRow } from "@openfield/db";
import type { Provider } from "@openfield/providers/server";

// Provider and model rows to wire shapes (§8.3). Status only: a key never leaves the server.

export function toProviderSummary(row: ProviderRow, provider: Provider, key: KeyStatus): ProviderSummary {
  return {
    id: row.id,
    displayName: row.displayName,
    enabled: row.enabled,
    credentialSource: key.source,
    credentialHint: key.hint,
    lastOkAt: row.lastOkAt,
    lastError: row.lastError ? errorCopy(row.lastError).reason : null,
    lastErrorCode: row.lastError,
    concurrencyCap: row.concurrencyCap,
    meta: provider.meta,
    credentials: provider.credentials,
  };
}

export function toModelListItem(
  manifest: ModelManifest,
  state: { ready: boolean; enabled: boolean },
): ModelListItem {
  // Every item says what it makes, so a client never has to know that absent means images.
  return { ...manifest, modality: modalityOf(manifest), ready: state.ready, enabled: state.enabled };
}
