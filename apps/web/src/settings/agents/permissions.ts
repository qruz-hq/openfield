import {
  AGENT_ACTION_IDS,
  AGENT_ACTIONS,
  type AgentAction,
  type AgentActionGroup,
  type AgentPermission,
  type AgentPermissions,
} from "@openfield/core";

// Settings > Agents' Allow / Ask / Default switches. The setting keeps only actions that aren't on
// Default. A group's "All of these" shows the value its actions share, or none when they differ.

export const actionsOf = (group: AgentActionGroup): AgentAction[] =>
  AGENT_ACTION_IDS.filter((action) => AGENT_ACTIONS[action].group === group);

export const permissionOf = (permissions: AgentPermissions, action: AgentAction): AgentPermission =>
  permissions[action] ?? "default";

/** The value every action in the group shares, or null when they differ (Mixed). */
export function groupPermission(
  permissions: AgentPermissions,
  group: AgentActionGroup,
): AgentPermission | null {
  const values = new Set(actionsOf(group).map((action) => permissionOf(permissions, action)));
  return values.size === 1 ? [...values][0]! : null;
}

export function withPermission(
  permissions: AgentPermissions,
  actions: readonly AgentAction[],
  value: AgentPermission,
): AgentPermissions {
  const next: AgentPermissions = { ...permissions };
  for (const action of actions) {
    if (value === "default") delete next[action];
    else next[action] = value;
  }
  return next;
}
