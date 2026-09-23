import {
  CONCURRENCY_CAP_FIELD,
  type ProviderSettingsResponse,
  type ProviderSettingsSchema,
  type SettingValue,
  withLimitsPanel,
} from "@openfield/core";
import { type Db, getProvider, getProviderSettings, updateProviderSettings } from "@openfield/db";
import { checkSettingsPatch, settingValues, staleSettingIds } from "@openfield/providers/manifest";
import type { Provider } from "@openfield/providers/server";
import { ApiFailure } from "../http/errors";
import type { Logger } from "../log/logger";

// Company settings (§0.3, §6.17): the adapter's panels plus Openfield's Limits panel, served to the
// settings modal. The adapter's values live in providers.settings (only what the person changed);
// "Runs at once" lives in providers.concurrency_cap, where the scheduler reads it.

/** Runs at once per company by default (§0.12). */
const DEFAULT_CAPS: Record<string, number> = { openai: 2, google: 4, higgsfield: 2 };
export const defaultCap = (providerId: string): number => DEFAULT_CAPS[providerId] ?? 2;

export class ProviderSettingsService {
  constructor(
    private readonly db: Db,
    private readonly providers: readonly Provider[],
    private readonly logger: Logger,
  ) {}

  /** The modal's schema: the adapter's panels in declared order, then Limits. */
  schema(providerId: string): ProviderSettingsSchema {
    const provider = this.#provider(providerId);
    return withLimitsPanel(provider.settings, {
      company: provider.meta.displayName,
      defaultCap: defaultCap(providerId),
    });
  }

  /** GET /api/providers/:id/settings. Works with or without a key. */
  view(providerId: string): ProviderSettingsResponse {
    const schema = this.schema(providerId);
    const row = getProvider(this.db, providerId);
    if (!row) throw notFound();
    const values: Record<string, SettingValue> = {
      ...settingValues(schema, getProviderSettings(this.db, providerId)),
      [CONCURRENCY_CAP_FIELD]: row.concurrencyCap,
    };
    return { schema, values };
  }

  /** PATCH: every key a declared field, every value legal, else 400 naming the field. */
  update(providerId: string, patch: Readonly<Record<string, SettingValue>>): ProviderSettingsResponse {
    const schema = this.schema(providerId);
    if (!getProvider(this.db, providerId)) throw notFound();
    const checked = checkSettingsPatch(schema, patch);
    if (!checked.ok) {
      throw new ApiFailure(400, "bad_request", checked.message, { field: `values.${checked.field}` });
    }
    updateProviderSettings(this.db, providerId, {
      set: checked.set,
      unset: checked.unset,
      ...(checked.concurrencyCap !== undefined && { concurrencyCap: checked.concurrencyCap }),
    });
    return this.view(providerId);
  }

  /** What normalize() resolves and freezes onto a run (§0.3). Stale stored values are skipped, not rewritten. */
  forRun(providerId: string): { schema?: ProviderSettingsSchema; stored: Record<string, SettingValue> } {
    const provider = this.#provider(providerId);
    const stored = getProviderSettings(this.db, providerId);
    const stale = staleSettingIds(provider.settings, stored);
    if (stale.length) {
      this.logger.debug("Some saved company settings no longer apply, so their defaults were used", {
        providerId,
        fields: stale,
      });
    }
    return { ...(provider.settings && { schema: provider.settings }), stored };
  }

  #provider(id: string): Provider {
    const provider = this.providers.find((p) => p.meta.id === id);
    if (!provider) throw notFound();
    return provider;
  }
}

const notFound = () => new ApiFailure(404, "not_found", "That company doesn't exist", { field: "id" });
