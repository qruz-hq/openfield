import { t } from "@openfield/core";
import { Banner } from "@openfield/ui";
import { useStats } from "../api/hooks/settings";
import { errorMessage } from "../api/raw";
import { SettingRow, SettingsSection } from "./section";
import { StorageMeter } from "./storage-meter";

// Settings · Storage: how much room the library takes, and whether thumbnails are on (§8.5.2).

export function StoragePane() {
  const stats = useStats();
  if (stats.isError) return <Banner variant="error" message={errorMessage(stats.error)} />;
  if (!stats.data) return null;
  const { bytes, thumbsBytes, trash, freeBytes, thumbnailEngine } = stats.data;
  const thumbsOn = thumbnailEngine !== "originals";

  return (
    <>
      <StorageMeter
        freeBytes={freeBytes}
        segments={[
          { label: t("settings.storage.images"), bytes },
          { label: t("settings.storage.thumbnails"), bytes: thumbsBytes },
          { label: t("settings.storage.trash"), bytes: trash.bytes },
        ]}
      />
      <SettingsSection label={t("settings.storage.library")}>
        <SettingRow
          title={t("settings.storage.thumbnails")}
          description={thumbsOn ? undefined : t("settings.storage.originalsOnly")}
        >
          <span className="shrink-0 text-small text-text-secondary">
            {t(thumbsOn ? "settings.storage.on" : "settings.storage.off")}
          </span>
        </SettingRow>
      </SettingsSection>
    </>
  );
}
