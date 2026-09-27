import { formatDateTime, t } from "@openfield/core";
import { Banner, Button, ProviderLogo } from "@openfield/ui";
import { useProviders } from "../api/hooks/keys";
import { useModels, useRefreshModels } from "../api/hooks/models";
import { useRunSpeed } from "../api/hooks/provider-settings";
import { useSettings } from "../api/hooks/settings";
import { errorMessage } from "../api/raw";
import { speedPrice } from "../lib/cost";
import { companyName, logoFor } from "../lib/provider";
import { SettingRow, SettingsSection } from "./section";

// Settings · Models: every model with its usual price, and the daily check for new ones.

export function ModelsPane() {
  const models = useModels();
  const providers = useProviders().data;
  const settings = useSettings().data;
  const refresh = useRefreshModels();
  const runSpeed = useRunSpeed();

  if (models.isError) return <Banner variant="error" message={errorMessage(models.error)} />;
  const checked = settings?.modelRefreshedAt;

  return (
    <>
      <SettingsSection label={t("settings.models.yours")}>
        {(models.data ?? []).map((model) => {
          const logo = logoFor(model.providerId);
          const { price, note, hint, pending } = speedPrice(model, runSpeed(model));
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
              <span className="flex shrink-0 items-center gap-4" title={hint}>
                {pending ? null : (
                  <span className="text-mono-12 text-text-secondary">{price ?? t("cost.unknown")}</span>
                )}
                {note ? <span className="text-caption text-text-tertiary">{note}</span> : null}
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
