import { type ModelListItem, type ResolutionTier, type SpeedId, t } from "@openfield/core";
import {
  type ComposerValues,
  type EditBase,
  editedSize,
  estimateRun,
  qualityLabel,
  type Resolved,
  resolveControl,
} from "@openfield/providers/manifest";
import { cn, Field, Select, SelectItem, Stepper } from "@openfield/ui";
import { Lock } from "lucide-react";
import { useId } from "react";
import { tightCost } from "../../lib/cost";
import { askedPrice } from "../../lib/remote-price";
import { aspectText } from "./plan";

// Image edit / Size fields (design SPFi6esXtD): Resolution and Quality side by side, the number of
// images, the aspect ratio locked to the image, and the size the new image comes out at. Each
// option's price is this edit's, for one image. The canvas Edit node's settings leave the size note
// out (design MZI3JqbHJr), and may not know the image yet: then nothing is priced and the aspect
// ratio just follows it.

export interface SizeFieldsProps {
  model: ModelListItem | undefined;
  resolved: Resolved | undefined;
  /** The image being edited, or null while there's none. */
  base: EditBase | null;
  /** A mask goes with the edit, so the model changes only that area where it can. */
  masked: boolean;
  /** Keep the rest of the image is on. */
  composite: boolean;
  speed: SpeedId;
  resting: boolean;
  /** The size the new image comes out at, under the fields. */
  note?: boolean;
  onValues: (values: ComposerValues) => void;
  onBatch: (batch: number) => void;
}

export function SizeFields({
  model,
  resolved,
  base,
  masked,
  composite,
  speed,
  resting,
  note = true,
  onValues,
  onBatch,
}: SizeFieldsProps) {
  const imagesLabel = useId();
  const caps = model?.capabilities;
  const resolution = caps ? resolveControl(caps, "resolution") : undefined;
  const quality = caps ? resolveControl(caps, "quality") : undefined;
  const batch = caps ? resolveControl(caps, "batch") : undefined;
  const offered = (state: string | undefined) =>
    state !== undefined && state !== "absent" && state !== "unsupported";

  const priceAt = (change: Partial<Resolved>) =>
    model && resolved && base
      ? tightCost(
          estimateRun(
            model,
            { ...resolved, ...change, batch: 1 },
            "",
            speed,
            { edit: { base, masked } },
            askedPrice,
          ),
        )
      : undefined;
  const off = (unavailable: string[] | undefined, value: string) => unavailable?.includes(value) ?? false;

  // The note reads the edit as it will run: with a mask, which Generate waits for.
  const size =
    base && model && resolved ? editedSize(model, resolved, { base, masked: true, composite }) : base;
  const kept = !!size && !!base && size.width === base.width && size.height === base.height;

  return (
    // Image edit / Size fields: a column, 12 apart.
    <div inert={resting} className={cn("flex w-full shrink-0 flex-col gap-12", resting && "opacity-45")}>
      {/* Size row */}
      <div className="flex w-full gap-8">
        {offered(resolution?.state) && resolved?.resolution ? (
          <Field label={t("edit.size.resolution")} className="min-w-0 flex-1 px-2 py-4">
            <Select
              value={resolved.resolution}
              onValueChange={(value) => onValues({ resolution: value as ResolutionTier })}
            >
              {((resolution?.options ?? []) as ResolutionTier[]).map((tier) => (
                <SelectItem
                  key={tier}
                  value={tier}
                  subtitle={
                    off(resolution?.unavailable, tier)
                      ? resolution?.reason
                      : t(`composer.chips.resolution.tiers.${tier}`)
                  }
                  price={priceAt({ resolution: tier })}
                  disabled={off(resolution?.unavailable, tier)}
                >
                  {tier}
                </SelectItem>
              ))}
            </Select>
          </Field>
        ) : null}
        {offered(quality?.state) && caps?.quality && resolved?.quality ? (
          <Field label={t("edit.size.quality")} className="min-w-0 flex-1 px-2 py-4">
            <Select value={resolved.quality} onValueChange={(value) => onValues({ quality: value })}>
              {caps.quality.levels.map((level) => (
                <SelectItem
                  key={level.id}
                  value={level.id}
                  subtitle={off(quality?.unavailable, level.id) ? quality?.reason : level.hint}
                  price={priceAt({ quality: level.id })}
                  disabled={off(quality?.unavailable, level.id)}
                >
                  {qualityLabel(caps, level.id)}
                </SelectItem>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      {/* Images */}
      <div className="flex w-full items-center justify-between px-2">
        <span id={imagesLabel} className="text-small font-medium text-text-primary">
          {t("edit.size.images")}
        </span>
        <Stepper
          aria-labelledby={imagesLabel}
          value={resolved?.batch ?? 1}
          min={1}
          max={batch?.max ?? caps?.batch.max ?? 1}
          disabled={!caps}
          onValueChange={onBatch}
          decrementLabel={t("composer.chips.batch.fewer")}
          incrementLabel={t("composer.chips.batch.more")}
        />
      </div>
      {/* Aspect ratio */}
      <div className="flex w-full items-center justify-between px-2">
        <span className="text-small font-medium text-text-primary">{t("edit.size.aspect")}</span>
        <span className="flex items-center gap-6">
          <Lock size={12} aria-hidden className="shrink-0 text-text-tertiary" />
          <span className="text-small text-text-secondary">
            {base
              ? t("edit.size.aspectValue", { ratio: aspectText(base.width, base.height) })
              : t("edit.size.aspectSame")}
          </span>
        </span>
      </div>
      {note && size ? (
        <p className="w-full text-caption leading-[1.45] text-text-tertiary">
          {/* Pixels read as they're written, 1152 × 1536, never grouped like a count. */}
          {t(kept ? "edit.size.keepsSize" : "edit.size.comesOut", {
            width: String(size.width),
            height: String(size.height),
          })}
        </p>
      ) : null}
    </div>
  );
}
