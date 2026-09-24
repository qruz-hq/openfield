import type { CostEstimate } from "@openfield/core";
import { type ModelListItem, t } from "@openfield/core";
import { Button, ProviderLogo, Select, SelectItem, Tooltip } from "@openfield/ui";
import { Play } from "lucide-react";
import type { ReactNode } from "react";
import { defaultPrice, type SpeedPrice, speedPrice, tightCost } from "../../../lib/cost";
import { logoFor } from "../../../lib/provider";
import { useCanvasEngineContext } from "../../engine/engine-store";
import type { SizeControl } from "../generate/controls";
import { useNodeSpeed } from "./speed";

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
  const ctx = useCanvasEngineContext();
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
          // At its company's speed, with "· Standard" when it lacks that speed, as in the composer.
          const run = ctx.runSpeed?.(model);
          const { price, note, hint }: SpeedPrice = run
            ? speedPrice(model, run)
            : { price: defaultPrice(model) };
          return (
            <SelectItem
              key={model.key}
              value={model.key}
              leading={itemLogo ? <ProviderLogo provider={itemLogo} /> : undefined}
              price={
                note ? (
                  <span title={hint}>
                    {price} <span className="font-sans text-caption text-text-tertiary">{note}</span>
                  </span>
                ) : (
                  price
                )
              }
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

/**
 * Button / Primary / M / Icon / Price, full width (design C0Ph6). The price is at the company's
 * speed; the tooltip names it, and "Standard for this model" sits under the button when the model
 * lacks that speed (§0.3).
 */
export function InspectorRun({
  estimate,
  models = [],
  disabled,
  onRun,
}: {
  estimate: CostEstimate | null;
  /** The models it runs, for the speed note. */
  models?: readonly (ModelListItem | undefined)[];
  disabled: boolean;
  onRun: (anchor: Element, bypass: boolean) => void;
}) {
  const speed = useNodeSpeed(models);
  const button = (
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
  if (!speed) return button;
  return (
    <div className="flex w-full flex-col items-center gap-6">
      <Tooltip
        content={
          <span className="flex flex-col gap-2">
            {speed.tips.map((tip) => (
              <span key={tip}>{tip}</span>
            ))}
          </span>
        }
      >
        {button}
      </Tooltip>
      {speed.fallback ? (
        <span className="text-micro text-text-tertiary">
          {t("speed.standardForModel", { speed: speed.fallback })}
        </span>
      ) : null}
    </div>
  );
}
