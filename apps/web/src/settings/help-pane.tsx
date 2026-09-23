import { LOG_LEVELS, type LogLevel, SETTINGS_DEFAULTS, t } from "@openfield/core";
import { Select, SelectItem } from "@openfield/ui";
import { useSettings, useUpdateSettings } from "../api/hooks/settings";
import { SettingRow, SettingsSection } from "./section";

// Settings · Help: how much the log records.

export function HelpPane() {
  const settings = useSettings().data;
  const update = useUpdateSettings();

  return (
    <SettingsSection label={t("settings.help.log")}>
      <SettingRow title={t("settings.help.logLevel")} description={t("settings.help.logLevelHint")}>
        <div className="w-200 shrink-0">
          <Select
            aria-label={t("settings.help.logLevel")}
            value={settings?.logLevel ?? SETTINGS_DEFAULTS.logLevel}
            onValueChange={(value) => update.mutate({ logLevel: value as LogLevel })}
          >
            {LOG_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {t(`settings.help.logLevels.${level}`)}
              </SelectItem>
            ))}
          </Select>
        </div>
      </SettingRow>
    </SettingsSection>
  );
}
