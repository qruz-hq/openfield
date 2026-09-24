import { t } from "@openfield/core";
import { Spinner } from "@openfield/ui";
import { Plus } from "lucide-react";

// New canvas (KkAp5 PPpbF): always the first cell. A dashed tile with a + circle.

export function NewCanvasCard({ onCreate, busy }: { onCreate: () => void; busy: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-10">
      <button
        type="button"
        onClick={onCreate}
        disabled={busy}
        aria-busy={busy || undefined}
        className="group/new relative flex aspect-video w-full cursor-pointer flex-col items-center justify-center gap-12 rounded-12 disabled:cursor-default"
      >
        {/* Dashed outline: 6 on, 5 off, 1px border-strong, inside the 12px corners (nDwu9). */}
        <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
          <rect
            x={0.5}
            y={0.5}
            rx={11.5}
            style={{ width: "calc(100% - 1px)", height: "calc(100% - 1px)" }}
            className="fill-none stroke-border-strong"
            strokeWidth={1}
            strokeDasharray="6 5"
            strokeLinecap="round"
          />
        </svg>
        <span className="flex size-40 items-center justify-center rounded-full bg-elevated-2 text-text-secondary transition-colors group-hover/new:text-text-primary">
          {busy ? <Spinner size={18} /> : <Plus size={18} aria-hidden />}
        </span>
        <span className="text-body-medium text-text-primary">{t("canvas.index.newCanvas")}</span>
      </button>
    </div>
  );
}
