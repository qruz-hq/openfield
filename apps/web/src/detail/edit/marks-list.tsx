import { type Mark, t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { useEditSession } from "./session";
import { previewLine } from "./sketch";
import { kindName, MarkChip } from "./sketch-chrome";

// Image edit / Marks list (design dGmKS7RNNK, and / Empty fVYLRNCACZ): the marks in the Edit panel,
// numbered as on the image, each with its colour and material. Picking a row picks the mark, which
// opens its popover on the image. Under them, the lines that go into the prompt with them.

/** "#C8102E · brushed steel": a mark's colour, then its material if it has one. */
const detailOf = (mark: Mark) => [mark.color, mark.material?.toLocaleLowerCase()].filter(Boolean).join(" · ");

export function MarksList({ resting }: { resting: boolean }) {
  const marks = useEditSession((s) => s.marks);
  const selected = useEditSession((s) => s.selectedMark);
  const { selectMark, clearMarks } = useEditSession.getState();

  if (marks.length === 0)
    return (
      <div
        data-marks-empty
        className={cn(
          "flex w-full shrink-0 flex-col items-center gap-4 rounded-14 border border-dashed border-border px-16 py-14",
          resting && "opacity-45",
        )}
      >
        <p className="text-small font-medium text-text-primary">{t("edit.sketch.emptyTitle")}</p>
        <p className="w-full text-center text-caption leading-[1.45] font-normal text-text-tertiary">
          {t("edit.sketch.emptyHint")}
        </p>
      </div>
    );

  return (
    <section
      inert={resting}
      aria-label={t("edit.sketch.marks")}
      className={cn("flex w-full shrink-0 flex-col gap-8", resting && "opacity-45")}
    >
      {/* Header */}
      <div className="flex w-full items-center justify-between px-2">
        <div className="flex items-center gap-6">
          <span className="text-small font-medium text-text-primary">{t("edit.sketch.marks")}</span>
          <span className="text-mono-12 text-text-tertiary">{marks.length}</span>
        </div>
        <button
          type="button"
          onClick={clearMarks}
          className="cursor-pointer text-caption font-semibold text-text-secondary hover:text-text-primary"
        >
          {t("edit.sketch.clearAll")}
        </button>
      </div>
      {/* Rows */}
      <div className="flex w-full flex-col gap-2 rounded-14 bg-surface p-4">
        {marks.map((mark, i) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: a mark is its number.
            key={i}
            type="button"
            aria-pressed={i === selected}
            onClick={() => selectMark(i === selected ? null : i)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-10 rounded-10 px-10 py-8 text-left",
              i === selected ? "bg-accent-soft" : "hover:bg-elevated",
            )}
          >
            <MarkChip mark={mark} n={i + 1} selected={false} />
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="text-small font-medium text-text-primary">{kindName(mark)}</span>
              <span className="truncate text-caption font-normal text-text-tertiary">{detailOf(mark)}</span>
            </span>
            <span
              aria-hidden
              className="size-14 shrink-0 rounded-full inset-ring inset-ring-border-strong"
              style={{ backgroundColor: mark.color }}
            />
          </button>
        ))}
      </div>
      {/* Prompt preview */}
      <div className="flex w-full flex-col gap-6 rounded-10 border border-dashed border-border px-12 py-10">
        <span className="text-micro font-medium text-text-tertiary">{t("edit.sketch.sent")}</span>
        {marks.map((mark, i) => (
          <p
            // biome-ignore lint/suspicious/noArrayIndexKey: as above.
            key={i}
            className="text-mono-11 leading-[1.45] break-words text-text-secondary"
          >
            {previewLine(
              { ...mark, material: mark.material?.toLocaleLowerCase() },
              t("edit.sketch.mark", { n: i + 1 }),
              kindName(mark).toLocaleLowerCase(),
            )}
          </p>
        ))}
      </div>
    </section>
  );
}
