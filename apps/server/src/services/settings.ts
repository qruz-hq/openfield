import type { Settings, SettingsPatch } from "@openfield/core";
import { type Db, readSettings, writeSettings } from "@openfield/db";

// Settings are read on every scheduler tick, so they're cached here and written through (§6.17).

type Listener = (next: Settings, changed: (keyof Settings)[]) => void;

export class SettingsService {
  #current: Settings;
  readonly #listeners: Listener[] = [];

  constructor(private readonly db: Db) {
    this.#current = readSettings(db);
  }

  get(): Settings {
    return this.#current;
  }

  /** Saves the keys present and tells listeners, so changes apply without a restart. */
  update(patch: SettingsPatch): Settings {
    const changed = (Object.keys(patch) as (keyof SettingsPatch)[]).filter((k) => patch[k] !== undefined);
    this.#current = writeSettings(this.db, patch);
    if (changed.length) for (const listener of this.#listeners) listener(this.#current, changed);
    return this.#current;
  }

  onChange(listener: Listener): void {
    this.#listeners.push(listener);
  }
}
