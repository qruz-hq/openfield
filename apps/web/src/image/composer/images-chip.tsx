import { t } from "@openfield/core";
import { Divider, Popover, PopoverContent, PopoverTrigger, Stepper, Switch } from "@openfield/ui";
import { ChevronUp, GalleryHorizontal } from "lucide-react";
import { useId } from "react";

// Chip / Setting / Images and its Popover / Images / Related set (design Zn3DlLHTxJ, h2bPH8Zad4):
// the image count for a model that can make a related set, in place of the stepper. Off, the count
// is exact as with any model; on, the model makes up to that many in one call and bills only what
// comes back, so the chip reads "Up to 4". It
// needs a count of 2: a set of one would read "Up to 1" for what is just one image.

export interface RelatedSet {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Fewer than the model's count when the images sent in leave less room in a set. */
  max?: number;
  /** Why it can't be turned on yet (a count of 1, or no room left beside the images sent in). */
  blocked?: string | null;
}

export function ImagesChip({
  value,
  max,
  onValueChange,
  relatedSet,
}: {
  value: number;
  max: number;
  onValueChange: (value: number) => void;
  relatedSet: RelatedSet;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const shown = relatedSet.on ? t("composer.chips.batch.upTo", { count: value }) : String(value);
  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* The shared Chip's icon is secondary and has no chevron, so this one is drawn to its node. */}
        <button
          type="button"
          aria-label={t("composer.chips.value", { label: t("composer.chips.batch.label"), value: shown })}
          className="inline-flex h-40 shrink-0 cursor-pointer items-center gap-6 whitespace-nowrap rounded-12 bg-elevated-2 px-12 inset-ring inset-ring-border transition-colors data-[state=open]:inset-ring-accent-line"
        >
          <GalleryHorizontal size={14} aria-hidden className="shrink-0 text-text-primary" />
          <span className="text-body-medium text-text-primary">{shown}</span>
          <ChevronUp size={12} aria-hidden className="shrink-0 text-text-tertiary" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-300 gap-4">
        <div className="flex w-full items-center justify-between px-10 py-4">
          <span className="text-small font-medium text-text-primary">{t("composer.chips.batch.label")}</span>
          <Stepper
            aria-label={t("composer.chips.batch.label")}
            value={value}
            min={1}
            max={max}
            onValueChange={onValueChange}
            decrementLabel={t("composer.chips.batch.fewer")}
            incrementLabel={t("composer.chips.batch.more")}
          />
        </div>
        <Divider />
        <div className="flex w-full items-start justify-between gap-16 px-10 py-8">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span id={titleId} className="text-small font-medium text-text-primary">
              {t("composer.chips.batch.relatedSet")}
            </span>
            <span id={descriptionId} className="w-full text-caption leading-[1.45] text-text-tertiary">
              {relatedSet.blocked ?? t("composer.chips.batch.relatedSetHint", { count: value })}
            </span>
          </div>
          <Switch
            checked={relatedSet.on}
            disabled={!!relatedSet.blocked}
            onCheckedChange={relatedSet.onChange}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
