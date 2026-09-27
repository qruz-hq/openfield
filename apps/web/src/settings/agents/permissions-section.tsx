import {
  AGENT_ACTION_GROUPS,
  AGENT_ACTIONS,
  AGENT_PERMISSIONS,
  type AgentAction,
  type AgentActionGroup,
  type AgentPermission,
  formatMoney,
  SETTINGS_DEFAULTS,
  t,
} from "@openfield/core";
import { Segmented, SegmentedItem } from "@openfield/ui";
import { Info } from "lucide-react";
import { useId } from "react";
import { useSettings, useUpdateSettings } from "../../api/hooks/settings";
import { SettingRow, SettingsSection } from "../section";
import { actionsOf, groupPermission, permissionOf, withPermission } from "./permissions";

// What agents can do, per group and per action (design: Settings · Agents, sections after Add to an
// app). Each row is Settings / Row / Segmented with Segmented / 3 at 228: Allow, Ask, Default.
// "All of these" sets every action in the group, and shows none picked when they differ.

export function PermissionsSection() {
  const settings = useSettings().data;
  const update = useUpdateSettings();
  const permissions = settings?.agentPermissions ?? {};
  const amount = formatMoney(settings?.agentAskAboveUsd ?? SETTINGS_DEFAULTS.agentAskAboveUsd);
  const set = (actions: readonly AgentAction[], value: AgentPermission) =>
    update.mutate({ agentPermissions: withPermission(permissions, actions, value) });

  return (
    <>
      <p className="flex items-center gap-6">
        <Info aria-hidden size={14} className="shrink-0 text-text-tertiary" />
        <span className="text-caption text-text-tertiary">{t("settings.agents.permissions.note")}</span>
      </p>
      {AGENT_ACTION_GROUPS.map((group) => (
        <Group
          key={group}
          group={group}
          value={groupPermission(permissions, group)}
          permissionFor={(action) => permissionOf(permissions, action)}
          amount={amount}
          disabled={!settings}
          onChange={set}
        />
      ))}
    </>
  );
}

function Group({
  group,
  value,
  permissionFor,
  amount,
  disabled,
  onChange,
}: {
  group: AgentActionGroup;
  value: AgentPermission | null;
  permissionFor: (action: AgentAction) => AgentPermission;
  amount: string;
  disabled: boolean;
  onChange: (actions: readonly AgentAction[], value: AgentPermission) => void;
}) {
  const actions = actionsOf(group);
  return (
    <SettingsSection label={t(`settings.agents.permissions.groups.${group}.label`)}>
      <PermissionRow
        title={t("settings.agents.permissions.all")}
        description={t(`settings.agents.permissions.groups.${group}.about`)}
        value={value}
        disabled={disabled}
        onChange={(next) => onChange(actions, next)}
      />
      {actions.map((action) => (
        <PermissionRow
          key={action}
          title={t(`settings.agents.permissions.actions.${action}.label`)}
          description={t(
            `settings.agents.permissions.actions.${action}.rule`,
            AGENT_ACTIONS[action].rule === "spend" ? { amount } : {},
          )}
          value={permissionFor(action)}
          disabled={disabled}
          onChange={(next) => onChange([action], next)}
        />
      ))}
    </SettingsSection>
  );
}

function PermissionRow({
  title,
  description,
  value,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  /** null: the group's actions differ, so none is picked. */
  value: AgentPermission | null;
  disabled: boolean;
  onChange: (value: AgentPermission) => void;
}) {
  const titleId = useId();
  const hintId = useId();
  return (
    <SettingRow title={title} description={<span id={hintId}>{description}</span>} titleId={titleId}>
      <Segmented
        value={value ?? ""}
        onValueChange={(next) => onChange(next as AgentPermission)}
        aria-labelledby={titleId}
        aria-describedby={hintId}
        disabled={disabled}
        className="w-228 shrink-0"
      >
        {AGENT_PERMISSIONS.map((permission) => (
          <SegmentedItem key={permission} value={permission}>
            {t(`settings.agents.permissions.${permission}`)}
          </SegmentedItem>
        ))}
      </Segmented>
    </SettingRow>
  );
}
