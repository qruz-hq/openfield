import { t } from "@openfield/core";
import { Switch } from "@openfield/ui";
import { useId } from "react";
import { useSettings, useUpdateSettings } from "../api/hooks/settings";
import { SettingRow, SettingsSection } from "./section";

// Settings · Experimental (§6.17): only switches that do something today (§0.15). Saving canvases
// as files writes each save to canvases/<id>.json in the library too (§7.8), so a canvas can live
// in git. Early models and the upscale program join when they land.

export function ExperimentalPane() {
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const filesId = useId();
  const filesHintId = useId();
  return (
    <SettingsSection label={t("settings.experimental.section")}>
      <SettingRow
        title={t("settings.experimental.canvasFiles")}
        description={<span id={filesHintId}>{t("settings.experimental.canvasFilesHint")}</span>}
        titleId={filesId}
      >
        <Switch
          aria-labelledby={filesId}
          aria-describedby={filesHintId}
          checked={settings?.canvasFileWriteThrough ?? false}
          disabled={!settings}
          onCheckedChange={(canvasFileWriteThrough) => update.mutate({ canvasFileWriteThrough })}
        />
      </SettingRow>
    </SettingsSection>
  );
}
