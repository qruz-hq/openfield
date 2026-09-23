import { formatDateTime, t } from "@openfield/core";
import { Banner, Button, ProviderLogo } from "@openfield/ui";
import { useProviders } from "../api/hooks/keys";
import { useModels, useRefreshModels } from "../api/hooks/models";
import { useSettings } from "../api/hooks/settings";
import { errorMessage } from "../api/raw";
import { defaultPrice } from "../lib/cost";
import { companyName, logoFor } from "../lib/provider";
import { SettingRow, SettingsSection } from "./section";

// Settings · Models: every model with its usual price, and the daily check for new ones.

export function ModelsPane() {
  const models = useModels();
  const providers = useProviders().data;
  const settings = useSettings().data;
  const refresh = useRefreshModels();

  if (models.isError) return <Banner variant="error" message={errorMessage(models.error)} />;
  const checked = settings?.modelRefreshedAt;

  return (
    <>
      <SettingsSection label={t("settings.models.yours")}>
        {(models.data ?? []).map((model) => {
          const logo = logoFor(model.providerId);
          return (
            <SettingRow
              key={model.key}
              title={
                <span className="flex items-center gap-8">
                  {logo ? <ProviderLogo provider={logo} /> : null}
                  {model.displayName}
                </span>
              }
              description={
                model.ready
                  ? model.description
                  : t("composer.chips.model.addKeyFor", { company: companyName(providers, model.providerId) })
              }
            >
              <span className="shrink-0 text-mono-12 text-text-secondary">
                {defaultPrice(model) ?? t("cost.unknown")}
              </span>
            </SettingRow>
          );
        })}
      </SettingsSection>
      <SettingsSection label={t("settings.models.list")}>
        <SettingRow
          title={t("settings.models.checkNew")}
          description={
            refresh.isError
              ? t("settings.models.checkFailed")
              : checked
                ? t("settings.models.lastChecked", { when: formatDateTime(checked) })
                : t("settings.models.neverChecked")
          }
        >
          <Button variant="secondary" size="s" loading={refresh.isPending} onClick={() => refresh.mutate()}>
            {t("settings.models.checkNow")}
          </Button>
        </SettingRow>
      </SettingsSection>
    </>
  );
}
