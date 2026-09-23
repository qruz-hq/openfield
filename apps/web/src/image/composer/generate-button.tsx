import { type CostEstimate, costParts, formatDate, t, tParts } from "@openfield/core";
import { cn, Spinner, Tooltip } from "@openfield/ui";
import type { ReactNode } from "react";
import type { GenerateState } from "../../lib/controls";

// Composer / Generate / {Ready, Range, Working, Cost unknown, Needs key, Disabled}. 144×84, radius 12.

const shell =
  "flex h-84 w-144 shrink-0 cursor-pointer flex-col items-center justify-center gap-3 rounded-12 transition-colors";
const accent = "bg-accent text-accent-fg hover:bg-accent-hover";
const quiet = "bg-elevated-2 inset-ring inset-ring-border";

/** "About" in Inter, "$0.16" in mono, 4 apart. */
function Estimate({ estimate, tone }: { estimate: CostEstimate; tone: string }) {
  const cost = costParts(estimate);
  if (cost.kind !== "amount") return <span className={cn("text-micro", tone)}>{cost.text}</span>;
  const parts = tParts<ReactNode>("cost.about", {
    cost: (
      <span key="amount" className="text-mono-11">
        {cost.amount}
      </span>
    ),
  });
  return (
    <span className={cn("flex items-center gap-4 text-micro", tone)}>
      {parts.map((part) =>
        typeof part === "string" ? part.trim() ? <span key={part}>{part.trim()}</span> : null : part,
      )}
    </span>
  );
}

/** How the estimate was worked out, and how fresh the prices are. */
function tooltipFor(estimate: CostEstimate | undefined): ReactNode {
  if (!estimate || estimate.confidence === "unknown") return undefined;
  return (
    <span className="flex flex-col gap-2">
      <span>{estimate.basis}</span>
      {estimate.pricedAt ? (
        <span>{t("cost.pricesAsOf", { date: formatDate(estimate.pricedAt) })}</span>
      ) : null}
    </span>
  );
}

export function GenerateButton({
  state,
  firstRun = false,
  working,
  batch,
  onGenerate,
}: {
  state: GenerateState;
  /** The first-run page shows its own Add a key button, so here Generate only waits. */
  firstRun?: boolean;
  working: boolean;
  batch: number;
  onGenerate: () => void;
}) {
  if (state.kind === "no-key" && firstRun) {
    return (
      <button type="button" disabled className={cn(shell, quiet, "cursor-default")}>
        <span className="text-button-l text-text-tertiary">{t("composer.generate.label")}</span>
        <span className="text-micro text-text-tertiary">{t("composer.generate.addKeyFirst")}</span>
      </button>
    );
  }

  // No usable key: Generate becomes the way to add one (design n4ZDxn).
  if (state.kind === "no-key" || state.kind === "needs-key") {
    return (
      <button
        type="button"
        onClick={onGenerate}
        className={cn(shell, quiet, "hover:inset-ring-border-strong")}
      >
        <span className="text-button-l text-text-primary">{t("composer.generate.addKey")}</span>
        <span className="max-w-128 truncate text-micro text-text-secondary">
          {state.kind === "needs-key"
            ? t("composer.generate.forModel", { model: state.model.displayName })
            : t("composer.generate.toMakeImages")}
        </span>
      </button>
    );
  }

  if (state.kind === "blocked") {
    return (
      <Tooltip content={state.reason}>
        <button
          type="button"
          aria-disabled
          onClick={onGenerate}
          className={cn(shell, quiet, "cursor-default")}
        >
          <span className="text-button-l text-text-tertiary">{t("composer.generate.label")}</span>
          {state.estimate ? <Estimate estimate={state.estimate} tone="text-text-tertiary" /> : null}
        </button>
      </Tooltip>
    );
  }

  const range = costParts(state.estimate);
  const tip = tooltipFor(state.estimate);
  const button = (
    <button type="button" aria-busy={working || undefined} className={cn(shell, accent)} onClick={onGenerate}>
      <span className="text-button-l">{t("composer.generate.label")}</span>
      {working ? (
        <Spinner size={16} />
      ) : (
        <>
          <Estimate estimate={state.estimate} tone="text-accent-fg" />
          {range.kind === "amount" && range.range ? (
            <span className="text-micro">{t("feed.tile.images", { count: batch })}</span>
          ) : null}
        </>
      )}
    </button>
  );
  return tip ? <Tooltip content={tip}>{button}</Tooltip> : button;
}
