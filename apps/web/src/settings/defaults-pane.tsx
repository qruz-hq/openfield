import { type AspectRatio, MAX_CONCURRENCY, type ModelKey, SETTINGS_DEFAULTS, t } from "@openfield/core";
import { Select, SelectItem, Stepper } from "@openfield/ui";
import { useId } from "react";
import { useModels } from "../api/hooks/models";
import { useSettings, useUpdateSettings } from "../api/hooks/settings";
import { aspectLabel } from "../lib/controls";
import { SettingRow, SettingsSection } from "./section";

// Settings · Defaults: what the composer starts with, and how many runs go at once overall.

const DEFAULT_ASPECT = "default";

export function DefaultsPane() {
  const settings = useSettings().data;
  const models = useModels().data ?? [];
  const update = useUpdateSettings();
  const runsId = useId();
  const ready = models.filter((m) => m.ready);
  // Every ratio some model offers, in the order the models list them.
  const ratios = [
    ...new Set(
      models.flatMap((m) => (m.capabilities.size.mode === "aspect" ? m.capabilities.size.ratios : [])),
    ),
  ].filter((r) => r !== "auto");

  return (
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
          decrementLabel={t("settings.apiKeys.runsAtOnce.fewer")}
          incrementLabel={t("settings.apiKeys.runsAtOnce.more")}
        />
      </SettingRow>
    </SettingsSection>
  );
}
