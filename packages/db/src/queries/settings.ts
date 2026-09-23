import {
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  type SettingKey,
  type Settings,
  type SettingsPatch,
  settingsSchema,
} from "@openfield/core/schemas";
import { sql } from "drizzle-orm";
import type { Executor } from "../client";
import { settings } from "../schema";
import { nowIso } from "./_util";

const isSettingKey = (key: string): key is SettingKey => (SETTING_KEYS as string[]).includes(key);

/**
 * Every setting, with defaults for keys never saved. A stored value that no longer parses
 * (a key whose rules changed) falls back to its default instead of breaking the app.
 */
export function readSettings(db: Executor): Settings {
  const out: Record<string, unknown> = { ...SETTINGS_DEFAULTS };
  for (const row of db.select().from(settings).all()) {
    if (!isSettingKey(row.key)) continue;
    const parsed = settingsSchema.shape[row.key].safeParse(row.value);
    if (parsed.success) out[row.key] = parsed.data;
  }
  return out as Settings;
}

/** Saves the keys present in `patch` (already validated by settingsPatchSchema) and returns all settings. */
export function writeSettings(db: Executor, patch: SettingsPatch, at = nowIso()): Settings {
  const rows = Object.entries(patch)
    .filter(([key, value]) => isSettingKey(key) && value !== undefined)
    // Serialised by hand: Drizzle would write a JSON null as SQL NULL, and the column is NOT NULL.
    .map(([key, value]) => ({ key, value: sql`${JSON.stringify(value)}`, updatedAt: at }));
  if (rows.length > 0) {
    db.insert(settings)
      .values(rows)
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
      })
      .run();
  }
  return readSettings(db);
}
