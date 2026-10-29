import { MASK_COMPOSITE_MAX_PX, t } from "@openfield/core";
import { cn, Field, SliderRow, Switch } from "@openfield/ui";
import { useEditSession } from "./session";

// Image edit / Keep the rest (design ZwaJzzNsbg, and / Off): put the original back outside the mask,
// on by default, with how far to grow the mask and soften its edge. Off, the model's whole result
// is kept and Feather and Expand rest at 40%. Once new images are in, their words say they apply
// to the next Generate.

export function KeepRest({ resting, afterRun }: { resting: boolean; afterRun: boolean }) {
  const composite = useEditSession((s) => s.composite);
  const featherPx = useEditSession((s) => s.featherPx);
  const expandPx = useEditSession((s) => s.expandPx);
  const { setComposite, setFeatherPx, setExpandPx } = useEditSession.getState();
  // Named by its field's label.
  const slider = (value: number, onChange: (px: number) => void) => (
    <SliderRow
      value={[value]}
      min={0}
      max={MASK_COMPOSITE_MAX_PX}
      step={1}
      disabled={!composite}
      onValueChange={([next]) => next !== undefined && onChange(next)}
      valueLabel={t("edit.options.px", { value })}
      // The field rests as a whole; the slider doesn't dim twice.
      className="data-disabled:opacity-100"
    />
  );
  return (
    // Image edit / Keep the rest: the switch, then Feather and Expand, 4 apart.
    <div inert={resting} className={cn("flex w-full shrink-0 flex-col gap-4", resting && "opacity-45")}>
      <Field
        layout="inline"
        label={t("edit.keep.label")}
        description={t(composite ? "edit.keep.on" : "edit.keep.off")}
        className="px-2 py-4"
      >
        <Switch checked={composite} onCheckedChange={setComposite} />
      </Field>
      <Field
        label={t("edit.keep.feather")}
        description={t(afterRun ? "edit.keep.featherNext" : "edit.keep.featherHint")}
        className={cn("px-2 py-4", !composite && "opacity-40")}
      >
        {slider(featherPx, setFeatherPx)}
      </Field>
      <Field
        label={t("edit.keep.expand")}
        description={t(afterRun ? "edit.keep.expandNext" : "edit.keep.expandHint")}
        className={cn("px-2 py-4", !composite && "opacity-40")}
      >
        {slider(expandPx, setExpandPx)}
      </Field>
    </div>
  );
}
