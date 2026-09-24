import { type ModelListItem, t } from "@openfield/core";
import { resolveControl } from "@openfield/providers/manifest";
import { Segmented, SegmentedItem } from "@openfield/ui";
import { Dices } from "lucide-react";
import type { SeedParam } from "../params";
import { InspectorField } from "../shell/inspector-parts";

// The seed setting (§7.7, §0.11): on a model without seeds, the core control shows disabled with
// the reason, as the composer's chip does. On one with seeds, Random or Fixed with its number. A
// fixed seed goes into the node's fingerprint, so pinning one makes the node reusable.

const SEED_MAX = 2 ** 32 - 1;

export function SeedField({
  model,
  seed,
  disabled,
  onChange,
}: {
  model: ModelListItem | undefined;
  seed: SeedParam;
  disabled?: boolean;
  onChange: (seed: SeedParam) => void;
}) {
  if (!model) return null;
  const control = resolveControl(model.capabilities, "seed");
  const label = t("composer.chips.seed.label");
  if (control.state === "unsupported" || control.state === "absent") {
    return (
      <InspectorField label={label}>
        <div
          aria-disabled
          className="flex h-36 w-full items-center gap-8 rounded-10 bg-surface px-10 text-small text-text-tertiary"
        >
          <Dices size={14} aria-hidden className="shrink-0" />
          {t("canvas.nodes.seed.random")}
        </div>
        <span className="text-caption text-text-tertiary">
          {t("composer.chips.seed.unsupported", { model: model.displayName })}
        </span>
      </InspectorField>
    );
  }
  const fixed = seed.mode === "fixed";
  return (
    <InspectorField label={label}>
      <Segmented
        value={fixed ? "fixed" : "random"}
        disabled={disabled}
        aria-label={label}
        onValueChange={(mode) =>
          onChange(mode === "fixed" ? { mode: "fixed", value: seed.value ?? 0 } : { mode: "random" })
        }
      >
        <SegmentedItem value="random">{t("canvas.nodes.seed.random")}</SegmentedItem>
        <SegmentedItem value="fixed">{t("canvas.nodes.seed.fixed")}</SegmentedItem>
      </Segmented>
      {fixed ? (
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={SEED_MAX}
          step={1}
          value={seed.value ?? 0}
          disabled={disabled}
          aria-label={t("canvas.nodes.seed.value")}
          onChange={(event) => {
            const value = Math.trunc(Number(event.target.value));
            if (Number.isFinite(value))
              onChange({ mode: "fixed", value: Math.max(0, Math.min(SEED_MAX, value)) });
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="h-36 w-full rounded-10 bg-surface px-10 text-mono-12 text-text-primary outline-none inset-ring inset-ring-border focus-visible:inset-ring-accent"
        />
      ) : null}
    </InspectorField>
  );
}
