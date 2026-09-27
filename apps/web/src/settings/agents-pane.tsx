import { formatMoney, SETTINGS_DEFAULTS, t } from "@openfield/core";
import { SettingText, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@openfield/ui";
import { ChevronRight, Info } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router";
import { useAgents, useNewAgentKey, useSetAgentsEnabled } from "../api/hooks/agents";
import { useSettings, useUpdateSettings } from "../api/hooks/settings";
import { notify } from "../lib/notify";
import { AccessKey, AmountInput, ClientRow, CodeBlock } from "./agents/parts";
import { PermissionsSection } from "./agents/permissions-section";
import { AGENT_APPS, type AgentApp, snippetFor } from "./agents/snippets";
import { SettingRow, SettingsSection } from "./section";
import { useSpendingPrefs } from "./spending/prefs";

// Settings · Agents (design: Settings · Agents · Off, Settings · Agents, … · Claude Desktop). Off,
// it says what agents could do. On: the key, how to add Openfield to each app, what agents may do
// (Allow, Ask or Default per action), their spending limits, and the apps that connected.

const CAN_DO = [
  ["settings.agents.canDoCanvases", "settings.agents.canDoCanvasesHint"],
  ["settings.agents.canDoImages", "settings.agents.canDoImagesHint"],
  ["settings.agents.canDoLibrary", "settings.agents.canDoLibraryHint"],
  ["settings.agents.canDoKeys", "settings.agents.canDoKeysHint"],
] as const;

export function AgentsPane() {
  const status = useAgents().data;
  const setEnabled = useSetAgentsEnabled();
  const enabledId = useId();
  const enabledHintId = useId();
  const on = status?.enabled ?? false;

  return (
    <>
      <SettingsSection label={t("settings.agents.connection")}>
        <SettingRow
          title={t("settings.agents.enable")}
          description={
            <span id={enabledHintId}>
              {t(on ? "settings.agents.enableHintOn" : "settings.agents.enableHintOff")}
            </span>
          }
          titleId={enabledId}
        >
          <Switch
            aria-labelledby={enabledId}
            aria-describedby={enabledHintId}
            checked={on}
            disabled={!status || setEnabled.isPending}
            onCheckedChange={(enabled) => setEnabled.mutate(enabled)}
          />
        </SettingRow>
        {on && status?.key ? <KeyRow value={status.key} /> : null}
      </SettingsSection>
      {on && status?.key ? (
        <>
          <AddToApp />
          <PermissionsSection />
          <AgentSpending />
          <ConnectedApps />
        </>
      ) : (
        <SettingsSection label={t("settings.agents.canDo")}>
          {CAN_DO.map(([title, hint]) => (
            <SettingRow key={title} title={t(title)} description={t(hint)}>
              {null}
            </SettingRow>
          ))}
        </SettingsSection>
      )}
    </>
  );
}

function KeyRow({ value }: { value: string }) {
  const newKey = useNewAgentKey();
  return (
    <SettingRow title={t("settings.agents.key")} description={t("settings.agents.keyHint")}>
      <AccessKey
        value={value}
        busy={newKey.isPending}
        onNewKey={() =>
          newKey.mutate(undefined, {
            onSuccess: () => notify(t("settings.agents.newKeyDone"), { tone: "success" }),
          })
        }
      />
    </SettingRow>
  );
}

/** Add to an app: a tab per app, what to do there, and the snippet to copy. */
function AddToApp() {
  const status = useAgents().data!;
  const [app, setApp] = useState<AgentApp>("claude-code");
  return (
    <SettingsSection label={t("settings.agents.addToApp")} stack>
      <Tabs value={app} onValueChange={(value) => setApp(value as AgentApp)} className="flex flex-col gap-12">
        <TabsList aria-label={t("settings.agents.addToApp")}>
          {AGENT_APPS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {t(`settings.agents.apps.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {AGENT_APPS.map((id) => {
          const snippet = snippetFor(id, status);
          return (
            <TabsContent key={id} value={id} className="flex flex-col gap-12">
              <p className="text-small text-text-secondary">{t(`settings.agents.howTo.${id}`)}</p>
              <CodeBlock shown={snippet.shown} copied={snippet.copied} label={t("settings.agents.copy")} />
              <p className="flex items-center gap-6">
                <Info aria-hidden size={14} className="shrink-0 text-text-tertiary" />
                <span className="text-caption text-text-tertiary">
                  {snippet.hasKey
                    ? t("settings.agents.withKey")
                    : t("settings.agents.withoutKey", { app: t(`settings.agents.apps.${id}`) })}
                </span>
              </p>
            </TabsContent>
          );
        })}
      </Tabs>
    </SettingsSection>
  );
}

/** The agents' own limits (settings), and what they spent today. */
function AgentSpending() {
  const status = useAgents().data!;
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const showByPlace = useSpendingPrefs((s) => s.set);
  const showToday = useSpendingPrefs((s) => s.showToday);
  const askId = useId();
  const askHintId = useId();
  const capId = useId();
  const capHintId = useId();
  const askAbove = settings?.agentAskAboveUsd ?? SETTINGS_DEFAULTS.agentAskAboveUsd;
  const cap = settings === undefined ? SETTINGS_DEFAULTS.agentDailyCapUsd : settings.agentDailyCapUsd;
  const spent = formatMoney(status.today.usd);

  return (
    <SettingsSection label={t("settings.agents.spending")}>
      <SettingRow
        title={t("settings.agents.askAbove")}
        description={<span id={askHintId}>{t("settings.agents.askAboveHint")}</span>}
        titleId={askId}
      >
        <AmountInput
          value={askAbove}
          onSave={(amount) => update.mutate({ agentAskAboveUsd: amount ?? 0 })}
          aria-labelledby={askId}
          aria-describedby={askHintId}
        />
      </SettingRow>
      <SettingRow
        title={t("settings.agents.dailyLimit")}
        description={<span id={capHintId}>{t("settings.agents.dailyLimitHint")}</span>}
        titleId={capId}
      >
        <AmountInput
          value={cap}
          allowEmpty
          placeholder={t("settings.agents.noLimit")}
          onSave={(amount) => update.mutate({ agentDailyCapUsd: amount })}
          aria-labelledby={capId}
          aria-describedby={capHintId}
        />
      </SettingRow>
      {/* Settings / Row / Link: opens Spending on today, split by where it ran. */}
      <Link
        to="/settings/spending"
        onClick={() => {
          showToday();
          showByPlace({ groupBy: "place" });
        }}
        className="flex w-full items-center justify-between gap-16 py-12"
      >
        <SettingText
          title={t("settings.agents.spentToday")}
          description={t("settings.agents.spentTodayHint")}
          className="flex-1"
        />
        <span className="flex shrink-0 items-center gap-6">
          <span className="text-small text-text-secondary">
            {cap === null ? spent : t("settings.agents.spentOf", { spent, limit: formatMoney(cap) })}
          </span>
          <ChevronRight aria-hidden size={16} className="text-text-tertiary" />
        </span>
      </Link>
    </SettingsSection>
  );
}

function ConnectedApps() {
  const status = useAgents().data!;
  const now = Date.now();
  return (
    <SettingsSection label={t("settings.agents.connected")}>
      {status.clients.length === 0 ? (
        <SettingRow title={t("settings.agents.noApps")} description={t("settings.agents.noAppsHint")}>
          {null}
        </SettingRow>
      ) : (
        status.clients.map((client) => <ClientRow key={client.name} client={client} now={now} />)
      )}
    </SettingsSection>
  );
}
