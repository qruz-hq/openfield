import { Banner } from "@openfield/ui";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useKeys, useProviders } from "../api/hooks/keys";
import { useModels } from "../api/hooks/models";
import { useSettings } from "../api/hooks/settings";
import { errorMessage } from "../api/raw";
import { ProviderCard } from "./provider-card";

// Settings · API keys: one card per company. Each company's own settings open in a modal from
// its card, never inline under it (§6.17). An early company's card shows only with Settings >
// Experimental > Show early models on (§6.2).

export function ApiKeysPane() {
  const providers = useProviders();
  const keys = useKeys();
  // Every model a card's speed and price rows can name, images and video both.
  const models = useModels("all");
  const showEarly = useSettings().data?.showExperimental ?? false;
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { focusKey?: boolean; providerSettings?: string } | null;
  const focusKey = state?.focusKey === true;
  const openFor = state?.providerSettings;

  const loaded = !!providers.data;
  // Opened once the cards are there; a reload of this page shouldn't open the modal again.
  useEffect(() => {
    if (openFor && loaded) void navigate(location.pathname, { replace: true, state: null });
  }, [openFor, loaded, navigate, location.pathname]);

  if (providers.isError) return <Banner variant="error" message={errorMessage(providers.error)} />;
  if (!providers.data) return null;

  const shown = providers.data.filter((p) => p.meta.stable || showEarly);
  // First run lands here with the first company that has no key ready to paste into.
  const firstMissing = shown.find((p) => p.credentialSource === "unset")?.id;

  return (
    <>
      {shown.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          status={keys.data?.find((k) => k.providerId === provider.id)}
          models={models.data?.filter((m) => m.providerId === provider.id) ?? []}
          autoFocus={focusKey && provider.id === firstMissing}
          openSettings={openFor === provider.id}
        />
      ))}
    </>
  );
}
