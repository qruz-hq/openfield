import { type AspectRatio, MAX_CONCURRENCY, type ModelKey, SETTINGS_DEFAULTS, t } from "@openfield/core";
import { aspectLabel } from "@openfield/providers/manifest";
import { Select, SelectItem, Stepper, Switch } from "@openfield/ui";
import { useId } from "react";
import { useModels } from "../api/hooks/models";
import { useSettings, useUpdateSettings } from "../api/hooks/settings";
import { SettingRow, SettingsSection } from "./section";

// Settings · Defaults: what the composer starts with, how many runs go at once overall, and what
// happens to an image a restart cut off.

const DEFAULT_ASPECT = "default";

export function DefaultsPane() {
  const settings = useSettings().data;
  const models = useModels().data ?? [];
  const update = useUpdateSettings();
  const runsId = useId();
  const rerunId = useId();
  const rerunHintId = useId();
  const ready = models.filter((m) => m.ready);
  // Every ratio some model offers, in the order the models list them.
  const ratios = [
    ...new Set(
      models.flatMap((m) => (m.capabilities.size.mode === "aspect" ? m.capabilities.size.ratios : [])),
    ),
  ].filter((r) => r !== "auto");

  return (
    <>
      <SettingsSection label={t("settings.defaults.newImages")}>
        <SettingRow title={t("settings.defaults.model")} description={t("settings.defaults.modelHint")}>
          <div className="w-240 shrink-0">
            <Select
              aria-label={t("settings.defaults.model")}
              // "" shows the placeholder and keeps the select controlled while settings load.
              value={settings?.defaultModel ?? ""}
              onValueChange={(key) => update.mutate({ defaultModel: key as ModelKey })}
              placeholder={t("composer.chips.model.empty")}
              disabled={ready.length === 0}
            >
              {ready.map((model) => (
                <SelectItem key={model.key} value={model.key}>
                  {model.displayName}
                </SelectItem>
              ))}
            </Select>
          </div>
        </SettingRow>
        <SettingRow title={t("settings.defaults.aspect")} description={t("settings.defaults.aspectHint")}>
          <div className="w-240 shrink-0">
            <Select
              aria-label={t("settings.defaults.aspect")}
              value={settings?.defaultAspect ?? DEFAULT_ASPECT}
              onValueChange={(value) =>
                update.mutate({ defaultAspect: value === DEFAULT_ASPECT ? null : (value as AspectRatio) })
              }
            >
              <SelectItem value={DEFAULT_ASPECT}>{t("settings.defaults.modelDefault")}</SelectItem>
              {ratios.map((ratio) => (
                <SelectItem key={ratio} value={ratio}>
                  {aspectLabel(ratio)}
                </SelectItem>
              ))}
            </Select>
          </div>
        </SettingRow>
        <SettingRow
          title={t("settings.defaults.concurrency")}
          description={t("settings.defaults.concurrencyHint")}
          titleId={runsId}
        >
          <Stepper
            aria-labelledby={runsId}
            value={settings?.globalConcurrency ?? SETTINGS_DEFAULTS.globalConcurrency}
            min={1}
            max={MAX_CONCURRENCY}
            onValueChange={(globalConcurrency) => update.mutate({ globalConcurrency })}
            decrementLabel={t("runsAtOnce.fewer")}
            incrementLabel={t("runsAtOnce.more")}
          />
        </SettingRow>
      </SettingsSection>
      {/* Recovery reads it once at boot, so a change applies from the next restart. */}
      <SettingsSection label={t("settings.defaults.restarts")}>
        <SettingRow
          title={t("settings.defaults.rerunInterrupted")}
          // The switch reads it out too: it's where the person learns a rerun may cost twice.
          description={<span id={rerunHintId}>{t("settings.defaults.rerunInterruptedHint")}</span>}
          titleId={rerunId}
        >
          <Switch
            aria-labelledby={rerunId}
            aria-describedby={rerunHintId}
            checked={settings?.rerunInterrupted ?? SETTINGS_DEFAULTS.rerunInterrupted}
            onCheckedChange={(rerunInterrupted) => update.mutate({ rerunInterrupted })}
          />
        </SettingRow>
      </SettingsSection>
    </>
  );
}
