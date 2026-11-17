import { type LayerTextSummary, t } from "@openfield/core";
import { cn } from "@openfield/ui";

// The words a model read on a text layer, as a layer row shows them: the text in quotes, then its
// colour as a swatch with the font beside it. Read only: the words are part of the layer's image.

/** “Presented By :”, on one line, the whole text in its tooltip. */
export function LayerWords({ text, className }: { text: LayerTextSummary; className?: string }) {
  const oneLine = text.text.replace(/\s*\n\s*/g, " ");
  return (
    <span className={cn("truncate", className)} title={t("layers.text.words", { text: text.text })}>
      {t("layers.text.quoted", { text: oneLine })}
    </span>
  );
}

/**
 * The colour swatch and "Helvetica Neue · #193366", whichever of the two the model gave. Without
 * `hex`, the swatch alone stands for the colour, for a row with little room.
 */
export function LayerTextLook({
  text,
  className,
  hex = true,
}: {
  text: LayerTextSummary;
  className?: string;
  hex?: boolean;
}) {
  const color = hex ? text.color : undefined;
  if (!text.font && !text.color) return null;
  const words =
    text.font && color ? t("layers.text.style", { font: text.font, color }) : (text.font ?? color);
  return (
    <span className={cn("flex min-w-0 items-center gap-4", className)}>
      {text.color ? (
        <span
          aria-hidden
          className="size-8 shrink-0 rounded-full inset-ring inset-ring-border-strong"
          style={{ backgroundColor: text.color }}
        />
      ) : null}
      {words ? <span className="truncate">{words}</span> : null}
    </span>
  );
}
