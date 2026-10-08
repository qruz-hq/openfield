import { t } from "@openfield/core";
import { Surface } from "@openfield/ui";
import { useProviders } from "../api/hooks/keys";
import { isDesktop } from "../lib/desktop";
import { SettingRow, SettingsSection } from "./section";

// Settings · Privacy: nothing is tracked, and the only sites Openfield contacts (§0.6). The desktop
// app adds GitHub, where it looks for updates (Settings > Updates).

export function PrivacyPane() {
  const providers = useProviders().data ?? [];

  return (
    <>
      <Surface variant="card">
        <p className="text-small leading-[1.5] text-text-secondary">{t("settings.privacy.disclosure")}</p>
      </Surface>
      <SettingsSection label={t("settings.privacy.tracking")}>
        <SettingRow
          title={t("settings.privacy.noTracking")}
          description={t("settings.privacy.noTrackingHint")}
        >
          {null}
        </SettingRow>
      </SettingsSection>
      <SettingsSection label={t("settings.privacy.sites")}>
        {providers.map((provider) => (
          <SettingRow key={provider.id} title={provider.meta.displayName}>
            <span className="flex shrink-0 flex-col items-end gap-2 text-mono-12 text-text-secondary">
              {[...provider.meta.networkHosts, ...provider.meta.assetHosts].map((host) => (
                <span key={host}>{host}</span>
              ))}
            </span>
          </SettingRow>
        ))}
        {isDesktop() ? (
          <SettingRow title={t("settings.privacy.updates")} description={t("settings.privacy.updatesHint")}>
            <span className="flex shrink-0 flex-col items-end gap-2 text-mono-12 text-text-secondary">
              <span>github.com</span>
              <span>*.githubusercontent.com</span>
            </span>
          </SettingRow>
        ) : null}
      </SettingsSection>
    </>
  );
}
