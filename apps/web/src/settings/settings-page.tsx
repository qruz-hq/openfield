import { t } from "@openfield/core";
import { GroupHeader, NavRow } from "@openfield/ui";
import type { ComponentType } from "react";
import { Link, Navigate, useParams } from "react-router";
import { AgentsPane } from "./agents-pane";
import { ApiKeysPane } from "./api-keys-pane";
import { AppearancePane } from "./appearance-pane";
import { DefaultsPane } from "./defaults-pane";
import { ExperimentalPane } from "./experimental-pane";
import { HelpPane } from "./help-pane";
import { ModelsPane } from "./models-pane";
import { PANES } from "./panes";
import { PrivacyPane } from "./privacy-pane";
import { SpendingPane } from "./spending-pane";
import { StoragePane } from "./storage-pane";

// Settings / Shell: rail, a hairline, then the pane with its header (§6.17). A pane with nothing
// that works yet stays off the rail (§0.15); Experimental joined with the canvas file switch.

const CONTENT: Partial<Record<string, ComponentType>> = {
  "api-keys": ApiKeysPane,
  models: ModelsPane,
  defaults: DefaultsPane,
  appearance: AppearancePane,
  storage: StoragePane,
  spending: SpendingPane,
  agents: AgentsPane,
  privacy: PrivacyPane,
  help: HelpPane,
  experimental: ExperimentalPane,
};

const SHOWN = PANES.filter((p) => CONTENT[p.slug]);

export function SettingsPage() {
  const { pane: slug } = useParams();
  const pane = SHOWN.find((p) => p.slug === slug);
  if (!pane) return <Navigate to={`/settings/${SHOWN[0]!.slug}`} replace />;
  const Content = CONTENT[pane.slug]!;

  return (
    <div className="flex min-h-0 w-full flex-1">
      <nav aria-label={t("settings.title")} className="flex h-full w-232 shrink-0 flex-col gap-2 px-12 py-16">
        <GroupHeader label={t("settings.title")} />
        {SHOWN.map((p) => (
          <NavRow key={p.slug} asChild icon={p.icon} label={t(p.label)} active={p.slug === pane.slug}>
            <Link to={`/settings/${p.slug}`} />
          </NavRow>
        ))}
      </nav>
      <div aria-hidden className="h-full w-px shrink-0 bg-border" />
      <section
        aria-labelledby="settings-title"
        className="flex h-full min-w-0 flex-1 flex-col gap-20 overflow-y-auto px-40 py-28"
      >
        <header className="flex w-full flex-col gap-6">
          <h1 id="settings-title" className="text-page-title text-text-primary">
            {t(pane.title)}
          </h1>
          <p className="w-full max-w-720 text-small leading-[1.5] text-text-secondary">{t(pane.intro)}</p>
        </header>
        <div className="flex w-full flex-col gap-32">
          <Content />
        </div>
      </section>
    </div>
  );
}
