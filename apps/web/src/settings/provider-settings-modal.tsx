import {
  type ModelListItem,
  type ProviderSummary,
  type SettingsPanel,
  type SettingValue,
  speedSettingField,
  t,
} from "@openfield/core";
import { Banner, GroupHeader, Modal, ModalContent, ModalTrigger, NavRow, ProviderLogo } from "@openfield/ui";
import { Hourglass, type LucideIcon, Settings2, SlidersHorizontal, Timer } from "lucide-react";
import { type KeyboardEvent, type ReactElement, useEffect, useId, useRef, useState } from "react";
import { useProviderSettings, useUpdateProviderSettings } from "../api/hooks/provider-settings";
import { errorMessage } from "../api/raw";
import { logoFor } from "../lib/provider";
import { isLimitsPanel, isSpeedField } from "../lib/provider-settings";
import { SettingsPanelBody } from "./settings-panel";

// Modal / Provider settings (design bTybF): a company's own panels, then Openfield's Limits panel,
// drawn from GET /api/providers/:id/settings with no per-company code (§6.17). Saves on change.

/** How long the panel header says "Saved" after a change lands. */
const SAVED_MS = 2000;

/** Speed has a timer, Limits sliders; a panel that only matters at some speeds, an hourglass. */
function panelIcon(panel: SettingsPanel, speedFieldId: string | undefined): LucideIcon {
  if (isLimitsPanel(panel)) return SlidersHorizontal;
  if (panel.fields.some(isSpeedField)) return Timer;
  if (speedFieldId && panel.fields.every((f) => f.showWhen?.some((c) => c.field === speedFieldId))) {
    return Hourglass;
  }
  return Settings2;
}

export interface ProviderSettingsModalProps {
  provider: ProviderSummary;
  /** The company's models, for prices and availability. */
  models: readonly ModelListItem[];
  /** The button that opens it. Focus goes back to it on close. */
  children: ReactElement;
  /** Open as it mounts. */
  defaultOpen?: boolean;
}

export function ProviderSettingsModal({
  provider,
  models,
  children,
  defaultOpen = false,
}: ProviderSettingsModalProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Modal open={open} onOpenChange={setOpen}>
      <ModalTrigger asChild>{children}</ModalTrigger>
      {open ? <SettingsContent provider={provider} models={models} /> : null}
    </Modal>
  );
}

function SettingsContent({ provider, models }: Pick<ProviderSettingsModalProps, "provider" | "models">) {
  const company = provider.meta.displayName;
  const logo = logoFor(provider.id);
  const settings = useProviderSettings(provider.id);
  const update = useUpdateProviderSettings(provider.id);
  const panels = settings.data?.schema.panels ?? [];
  const values = settings.data?.values ?? {};
  const [picked, setPicked] = useState<string>();
  const current = panels.find((p) => p.id === picked) ?? panels[0];
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const base = useId();
  const speedFieldId = speedSettingField(settings.data?.schema)?.id;

  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const save = (panelId: string, patch: Record<string, SettingValue>) =>
    update.mutate(patch, {
      onSuccess: () => {
        clearTimeout(savedTimer.current);
        setSaved(panelId);
        savedTimer.current = setTimeout(() => setSaved(null), SAVED_MS);
      },
    });

  const select = (panelId: string, focus = false) => {
    setPicked(panelId);
    if (focus) tabs.current.get(panelId)?.focus();
  };

  // A vertical tablist: ↑ and ↓ move and open, Home and End jump (§2.11).
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!current) return;
    const order = panels.map((p) => p.id);
    const at = order.indexOf(current.id);
    const next =
      event.key === "ArrowDown"
        ? (at + 1) % order.length
        : event.key === "ArrowUp"
          ? (at - 1 + order.length) % order.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? order.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    select(order[next]!, true);
  };

  const groups = [
    { label: company, panels: panels.filter((p) => !isLimitsPanel(p)) },
    { label: t("app.name"), panels: panels.filter(isLimitsPanel) },
  ].filter((g) => g.panels.length);

  const tabId = (panel: SettingsPanel) => `${base}-tab-${panel.id}`;

  return (
    <ModalContent
      title={
        <span className="flex items-center gap-12">
          {logo ? <ProviderLogo provider={logo} variant="tile" /> : null}
          <span>{t("providerSettings.title", { company })}</span>
        </span>
      }
      closeLabel={t("actions.close")}
      headerClassName="py-20 pr-20 pl-24"
      className="w-800 gap-0 p-0"
      aria-describedby={undefined}
    >
      <div className="flex w-full flex-col">
        <div aria-hidden className="h-px w-full shrink-0 bg-border" />
        <div className="flex h-500 w-full">
          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label={t("providerSettings.panels")}
            className="flex h-full min-h-0 w-220 shrink-0 flex-col gap-16 overflow-y-auto p-12"
          >
            {groups.map((group) => (
              <div key={group.label} role="none" className="flex w-full flex-col gap-2">
                <GroupHeader label={group.label} />
                {group.panels.map((panel) => {
                  const selected = panel.id === current?.id;
                  return (
                    <NavRow
                      key={panel.id}
                      asChild
                      icon={panelIcon(panel, speedFieldId)}
                      label={panel.label}
                      active={selected}
                      aria-current={false}
                    >
                      <button
                        ref={(el) => {
                          if (el) tabs.current.set(panel.id, el);
                          else tabs.current.delete(panel.id);
                        }}
                        type="button"
                        role="tab"
                        id={tabId(panel)}
                        aria-selected={selected}
                        aria-controls={`${base}-panel`}
                        tabIndex={selected ? 0 : -1}
                        className="text-left"
                        onClick={() => select(panel.id)}
                        onKeyDown={onTabKey}
                      />
                    </NavRow>
                  );
                })}
              </div>
            ))}
          </div>
          <div aria-hidden className="h-full w-px shrink-0 bg-border" />
          <div
            role="tabpanel"
            id={`${base}-panel`}
            aria-labelledby={current ? tabId(current) : undefined}
            className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto p-24"
          >
            {settings.isError ? (
              <Banner variant="error" message={errorMessage(settings.error)} />
            ) : current ? (
              <SettingsPanelBody
                key={current.id}
                panel={current}
                panels={panels}
                values={values}
                models={models}
                company={company}
                saved={saved === current.id}
                onChange={(patch) => save(current.id, patch)}
                onJump={(panelId) => select(panelId, true)}
              />
            ) : null}
          </div>
        </div>
      </div>
    </ModalContent>
  );
}
