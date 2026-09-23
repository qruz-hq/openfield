import { DEFAULT_FEED_ZOOM, MAX_FEED_ZOOM, THEMES, type Theme, t } from "@openfield/core";
import { Segmented, SegmentedItem, SliderRow } from "@openfield/ui";
import { useId } from "react";
import { useSettings, useUpdateSettings } from "../api/hooks/settings";
import { applyTheme } from "../lib/theme";
import { SettingRow, SettingsSection } from "./section";

// Settings · Appearance: theme and grid size, written through PATCH /api/settings.

export function AppearancePane() {
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const themeId = useId();
  const gridId = useId();
  const zoom = settings?.feedZoom ?? DEFAULT_FEED_ZOOM;

  const setTheme = (value: string) => {
    const theme = value as Theme;
    applyTheme(theme);
    update.mutate({ theme });
  };

  return (
    <SettingsSection label={t("settings.appearance.look")}>
      <SettingRow
        title={t("settings.appearance.theme")}
        description={t("settings.appearance.themeHint")}
        titleId={themeId}
      >
        <Segmented
          aria-labelledby={themeId}
          value={settings?.theme ?? "system"}
          onValueChange={setTheme}
          className="w-280 shrink-0"
        >
          {THEMES.map((theme) => (
            <SegmentedItem key={theme} value={theme}>
              {t(`settings.appearance.themes.${theme}`)}
            </SegmentedItem>
          ))}
        </Segmented>
      </SettingRow>
      <SettingRow
        title={t("settings.appearance.gridSize")}
        description={t("settings.appearance.gridSizeHint")}
        titleId={gridId}
      >
        <div className="w-240 shrink-0">
          <SliderRow
            aria-labelledby={gridId}
            min={0}
            max={MAX_FEED_ZOOM}
            step={1}
            value={[zoom]}
            valueLabel={zoom}
            onValueChange={([next]) =>
              next !== undefined && next !== zoom && update.mutate({ feedZoom: next })
            }
          />
        </div>
      </SettingRow>
    </SettingsSection>
  );
}
