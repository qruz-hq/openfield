import { type CostEstimate, costParts, formatDate, t, tParts } from "@openfield/core";
import { cn, Spinner, Tooltip } from "@openfield/ui";
import type { ReactNode } from "react";
import type { GenerateState } from "../../lib/controls";

// Composer / Generate / {Ready, Range, Working, Cost unknown, Needs key, Disabled}. 144×84, radius 12.

const shell =
  "flex h-84 w-144 shrink-0 cursor-pointer flex-col items-center justify-center gap-3 rounded-12 transition-colors";
const accent = "bg-accent text-accent-fg hover:bg-accent-hover";
const quiet = "bg-elevated-2 inset-ring inset-ring-border";

/** The company's speed, as the button shows it (§3.6, design NwR6Y and IMDHT). */
export interface GenerateSpeed {
  /** The speed's name, when the run isn't at Standard: "Batch". */
  name?: string;
  /** The model lacks the chosen speed, so it runs at this one (Standard) and says so. */
  fallback?: string;
  /** One line for the tooltip. */
  tip: string;
}

/** "About" in Inter, "$0.16" in mono, then "· Batch", 4 apart. */
function Estimate({ estimate, tone, speed }: { estimate: CostEstimate; tone: string; speed?: string }) {
  const cost = costParts(estimate);
  const suffix = speed ? <span key="speed">{t("speed.suffix", { speed })}</span> : null;
  if (cost.kind !== "amount") {
    return (
      <span className={cn("flex items-center gap-4 text-micro", tone)}>
        <span>{cost.text}</span>
        {suffix}
      </span>
    );
  }
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
      {suffix}
    </span>
  );
}

/** "Standard for this model", under the price wherever it shows (design IMDHT). */
function FallbackNote({ speed, tone }: { speed: GenerateSpeed | undefined; tone?: string }) {
  if (!speed?.fallback) return null;
  return (
    <span className={cn("text-micro", tone)}>{t("speed.standardForModel", { speed: speed.fallback })}</span>
  );
}

/** How the estimate was worked out, how fresh the prices are, and the speed. */
function tooltipFor(estimate: CostEstimate | undefined, speed: GenerateSpeed | undefined): ReactNode {
  const known = estimate && estimate.confidence !== "unknown";
  if (!known && !speed) return undefined;
  return (
    <span className="flex flex-col gap-2">
      {known ? <span>{estimate.basis}</span> : null}
      {known && estimate.pricedAt ? (
        <span>{t("cost.pricesAsOf", { date: formatDate(estimate.pricedAt) })}</span>
      ) : null}
      {speed ? <span>{speed.tip}</span> : null}
    </span>
  );
}

export function GenerateButton({
  state,
  firstRun = false,
  working,
  batch,
  speed,
  onGenerate,
}: {
  state: GenerateState;
  /** The first-run page shows its own Add a key button, so here Generate only waits. */
  firstRun?: boolean;
  working: boolean;
  batch: number;
  /** Absent at Standard. */
  speed?: GenerateSpeed;
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
    const tip = speed ? (
      <span className="flex flex-col gap-2">
        <span>{state.reason}</span>
        <span>{speed.tip}</span>
      </span>
    ) : (
      state.reason
    );
    return (
      <Tooltip content={tip}>
        <button
          type="button"
          aria-disabled
          onClick={onGenerate}
          className={cn(shell, quiet, "cursor-default")}
        >
          <span className="text-button-l text-text-tertiary">{t("composer.generate.label")}</span>
          {state.estimate ? (
            <>
              <Estimate estimate={state.estimate} tone="text-text-tertiary" speed={speed?.name} />
              <FallbackNote speed={speed} tone="text-text-tertiary" />
            </>
          ) : null}
        </button>
      </Tooltip>
    );
  }

  const range = costParts(state.estimate);
  const tip = tooltipFor(state.estimate, speed);
  const button = (
    <button type="button" aria-busy={working || undefined} className={cn(shell, accent)} onClick={onGenerate}>
      <span className="text-button-l">{t("composer.generate.label")}</span>
      {working ? (
        <Spinner size={16} />
      ) : (
        <>
          <Estimate estimate={state.estimate} tone="text-accent-fg" speed={speed?.name} />
          {range.kind === "amount" && range.range ? (
            <span className="text-micro">{t("feed.tile.images", { count: batch })}</span>
          ) : null}
          <FallbackNote speed={speed} />
        </>
      )}
    </button>
  );
  return tip ? <Tooltip content={tip}>{button}</Tooltip> : button;
}
