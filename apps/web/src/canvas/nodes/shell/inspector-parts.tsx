import type { CostEstimate } from "@openfield/core";
import { type ModelListItem, t } from "@openfield/core";
import { Button, ProviderLogo, Select, SelectItem } from "@openfield/ui";
import { Play } from "lucide-react";
import type { ReactNode } from "react";
import { defaultPrice, tightCost } from "../../../lib/cost";
import { logoFor } from "../../../lib/provider";
import type { SizeControl } from "../generate/controls";

// Pieces of the node settings drawer (design AWQzm): a labelled field (Form / Field / Select with
// the 12/tertiary label and 4×2 padding), the model field, size fields and the Run button.

export function InspectorField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-8 px-2 py-4">
      <span className="text-caption text-text-tertiary">{label}</span>
      {children}
    </div>
  );
}

export function ModelField({
  models,
  selected,
  disabled,
  onSelect,
}: {
  models: readonly ModelListItem[];
  selected: ModelListItem | undefined;
  disabled?: boolean;
  onSelect: (model: ModelListItem) => void;
}) {
  const options = models.filter((m) => m.ready || m.key === selected?.key);
  const logo = logoFor(selected?.providerId);
  return (
    <InspectorField label={t("canvas.nodes.inspector.model")}>
      <Select
        value={selected?.key ?? ""}
        disabled={disabled}
        aria-label={t("canvas.nodes.inspector.model")}
        placeholder={t("composer.chips.model.empty")}
        leading={logo ? <ProviderLogo provider={logo} /> : undefined}
        onValueChange={(value) => {
          const next = models.find((m) => m.key === value);
          if (next) onSelect(next);
        }}
      >
        {options.map((model) => {
          const itemLogo = logoFor(model.providerId);
          return (
            <SelectItem
              key={model.key}
              value={model.key}
              leading={itemLogo ? <ProviderLogo provider={itemLogo} /> : undefined}
              price={defaultPrice(model)}
            >
              {model.displayName}
            </SelectItem>
          );
        })}
      </Select>
    </InspectorField>
  );
}

export function SizeField({
  control,
  disabled,
  onPick,
}: {
  control: SizeControl;
  disabled?: boolean;
  onPick: (value: string) => void;
}) {
  return (
    <InspectorField label={control.label}>
      <Select value={control.value} disabled={disabled} aria-label={control.label} onValueChange={onPick}>
        {control.options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            subtitle={option.subtitle}
            leading={option.leading}
            price={option.price}
          >
            {option.title}
          </SelectItem>
        ))}
      </Select>
    </InspectorField>
  );
}

/** Button / Primary / M / Icon / Price, full width (design C0Ph6). */
export function InspectorRun({
  estimate,
  disabled,
  onRun,
}: {
  estimate: CostEstimate | null;
  disabled: boolean;
  onRun: (anchor: Element, bypass: boolean) => void;
}) {
  return (
    <Button
      variant="primary"
      size="m"
      icon={Play}
      price={estimate ? tightCost(estimate) : undefined}
      disabled={disabled}
      className="w-full"
      onClick={(event) => onRun(event.currentTarget, event.altKey)}
    >
      {t("canvas.nodes.inspector.run")}
    </Button>
  );
}
