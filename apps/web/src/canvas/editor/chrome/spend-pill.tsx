import { formatMoney, t } from "@openfield/core";
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { useCanvasSpend, useSpentToday } from "../../../api/hooks/usage";
import { useSession } from "../session";

// Canvas / Chrome / Spend (design f9fk2S): what this canvas's runs have cost, in the top bar before
// the save state. It opens Settings > Spending. On hover or keyboard focus its details (design
// GbW1U) show this canvas beside today everywhere, the top nav's Spent today, which the full-screen
// canvas hides. Both refresh as runs finish (usage.updated). The details stay open while the
// pointer crosses to them and over them, so See spending can be clicked.

/** How long the details wait after the pointer leaves, so a slightly off path to them keeps them. */
const CLOSE_DELAY_MS = 150;

export function SpendPill() {
  const { canvasId } = useSession();
  const canvas = useCanvasSpend(canvasId);
  const today = useSpentToday();
  const [open, setOpen] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const details = useId();
  const keep = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
    setOpen(true);
  };
  const letGo = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  useEffect(
    () => () => {
      if (closing.current) clearTimeout(closing.current);
    },
    [],
  );
  const currency = canvas.data?.currency ?? today.data?.currency ?? "USD";
  const amount = formatMoney(canvas.data?.usd ?? 0, currency);
  const todayImages = today.data?.rows.reduce((sum, row) => sum + row.images, 0) ?? 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the link inside is the control; this only keeps the details open while the pointer is over either.
    <div
      className="relative"
      onPointerEnter={keep}
      onPointerLeave={letGo}
      onFocus={keep}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Link
        to="/settings/spending"
        aria-describedby={open ? details : undefined}
        data-canvas-spend
        className="flex h-40 items-center gap-8 rounded-10 bg-elevated px-12 inset-ring inset-ring-border transition-shadow hover:inset-ring-border-strong focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="text-small font-medium text-text-tertiary">{t("canvas.editor.spend.label")}</span>
        <span className="text-mono-13 font-medium text-text-primary">{amount}</span>
      </Link>
      {open ? (
        // The 6 px above the details is part of this box, so the pointer never leaves on the way.
        <div className="absolute top-full left-0 z-10 pt-6">
          <div
            id={details}
            role="tooltip"
            className="flex w-260 flex-col gap-10 rounded-12 bg-elevated p-12 shadow-popover inset-ring inset-ring-border"
          >
            <SpendLine
              label={t("canvas.editor.spend.canvas")}
              images={canvas.data?.images ?? 0}
              amount={amount}
            />
            <SpendLine
              label={t("canvas.editor.spend.today")}
              images={todayImages}
              amount={formatMoney(today.data?.totalUsd ?? 0, currency)}
            />
            <div aria-hidden className="h-px w-full bg-border" />
            <Link
              to="/settings/spending"
              className="flex w-fit items-center gap-6 rounded-4 text-small font-medium text-text-secondary hover:text-text-primary"
            >
              {t("canvas.editor.spend.see")}
              <ChevronRight size={14} aria-hidden className="text-text-tertiary" />
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One line of the details (design Z8znT1): what, how many images, and the amount. */
function SpendLine({ label, images, amount }: { label: string; images: number; amount: string }) {
  return (
    <div className="flex w-full items-center gap-8">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-small font-medium text-text-primary">{label}</span>
        <span className="text-caption text-text-tertiary">
          {t("canvas.editor.spend.images", { count: images })}
        </span>
      </div>
      <span className="text-mono-13 text-text-primary">{amount}</span>
    </div>
  );
}
