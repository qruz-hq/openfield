import { MAX_CONCURRENCY, type ProviderSummary, t } from "@openfield/core";
import { Banner, Stepper } from "@openfield/ui";
import { useId } from "react";
import { useLocation } from "react-router";
import { useKeys, useProviders, useUpdateProvider } from "../api/hooks/keys";
import { useModels } from "../api/hooks/models";
import { errorMessage } from "../api/raw";
import { notifyError } from "../lib/notify";
import { ProviderCard } from "./provider-card";
import { SettingRow, SettingsSection } from "./section";

// Settings · API keys: one card per company, then each company's own settings.

export function ApiKeysPane() {
  const providers = useProviders();
  const keys = useKeys();
  const models = useModels();
  const location = useLocation();
  const focusKey = (location.state as { focusKey?: boolean } | null)?.focusKey === true;

  if (providers.isError) return <Banner variant="error" message={errorMessage(providers.error)} />;
  if (!providers.data) return null;

  // First run lands here with the first company that has no key ready to paste into.
  const firstMissing = providers.data.find((p) => p.credentialSource === "unset")?.id;

  return (
    <>
      {providers.data.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          status={keys.data?.find((k) => k.providerId === provider.id)}
          models={models.data?.filter((m) => m.providerId === provider.id) ?? []}
          autoFocus={focusKey && provider.id === firstMissing}
        />
      ))}
      {providers.data.map((provider) => (
        <ProviderSettings key={provider.id} provider={provider} />
      ))}
    </>
  );
}

function ProviderSettings({ provider }: { provider: ProviderSummary }) {
  const update = useUpdateProvider();
  const runsId = useId();
  const company = provider.meta.displayName;

  const setCap = (concurrencyCap: number) =>
    update.mutate(
      { providerId: provider.id, patch: { concurrencyCap } },
      { onError: (error) => notifyError(errorMessage(error)) },
    );

  return (
    <SettingsSection label={company}>
      <SettingRow
        title={t("settings.apiKeys.runsAtOnce.label")}
        description={t("settings.apiKeys.runsAtOnce.hint", { company })}
        titleId={runsId}
      >
        <Stepper
          aria-labelledby={runsId}
          value={provider.concurrencyCap}
          min={1}
          max={MAX_CONCURRENCY}
          onValueChange={setCap}
          decrementLabel={t("settings.apiKeys.runsAtOnce.fewer")}
          incrementLabel={t("settings.apiKeys.runsAtOnce.more")}
        />
      </SettingRow>
    </SettingsSection>
  );
}
