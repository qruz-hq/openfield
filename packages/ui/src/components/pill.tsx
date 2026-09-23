import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleDashed,
  Clock3,
  Hourglass,
  Loader,
  Lock,
  type LucideIcon,
  X,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";

const pillBase =
  "inline-flex shrink-0 items-center gap-6 whitespace-nowrap rounded-full text-caption font-medium";

export interface FilterPillProps extends ComponentProps<"button"> {
  active?: boolean;
  /** Adds a chevron, for a filter that opens a list ("All folders"). */
  dropdown?: boolean;
}

/** Pill / Filter / Active and / Idle: feed and library filters. A toggle button. */
export function FilterPill({
  active = false,
  dropdown = false,
  className,
  children,
  type = "button",
  ...props
}: FilterPillProps) {
  return (
    <button
      type={type}
      aria-pressed={dropdown ? undefined : active}
      className={cn(
        pillBase,
        "cursor-pointer px-10 py-4 inset-ring transition-colors",
        active
          ? "bg-elevated-2 inset-ring-border-strong text-text-primary"
          : "inset-ring-border text-text-secondary hover:text-text-primary",
        className,
      )}
      {...props}
    >
      {children}
      {dropdown ? <ChevronDown size={12} aria-hidden className="shrink-0 text-text-tertiary" /> : null}
    </button>
  );
}

export type StatusPillStatus = "connected" | "not-connected" | "error" | "checking" | "set-outside";

const STATUS: Record<StatusPillStatus, { icon: LucideIcon; box: string; iconClass: string; label: string }> =
  {
    connected: {
      icon: Check,
      box: "bg-elevated-2 inset-ring inset-ring-border",
      iconClass: "text-text-secondary",
      label: "text-text-secondary",
    },
    "not-connected": {
      icon: CircleDashed,
      box: "inset-ring inset-ring-border",
      iconClass: "text-text-tertiary",
      label: "text-text-tertiary",
    },
    error: { icon: CircleAlert, box: "bg-danger-soft", iconClass: "text-danger", label: "text-danger" },
    checking: {
      icon: Loader,
      box: "inset-ring inset-ring-border",
      iconClass: "text-text-secondary motion-safe:animate-spin",
      label: "text-text-secondary",
    },
    "set-outside": {
      icon: Lock,
      box: "bg-elevated-2 inset-ring inset-ring-border",
      iconClass: "text-text-tertiary",
      label: "text-text-secondary",
    },
  };

export interface StatusPillProps extends ComponentProps<"span"> {
  status: StatusPillStatus;
}

/** Pill / Status / *: a company's key status on its Settings card. */
export function StatusPill({ status, className, children, ...props }: StatusPillProps) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className={cn(pillBase, "px-10 py-5", s.box, s.label, className)} {...props}>
      <Icon size={12} aria-hidden className={cn("shrink-0", s.iconClass)} />
      {children}
    </span>
  );
}

export interface SpendPillProps extends Omit<ComponentProps<"span">, "children"> {
  label: ReactNode;
  /** Already formatted, such as "$0.42". */
  amount: ReactNode;
}

/** Pill / Spend: "Spent today $0.42" in the top nav. */
export function SpendPill({ label, amount, className, ...props }: SpendPillProps) {
  return (
    <span
      className={cn(pillBase, "bg-elevated px-10 py-5 inset-ring inset-ring-border", className)}
      {...props}
    >
      <span className="text-text-tertiary">{label}</span>
      <span className="text-mono-12 font-medium text-text-primary">{amount}</span>
    </span>
  );
}

export type TileStatus = "generating" | "queued" | "waiting";

const TILE_ICON: Record<TileStatus, LucideIcon> = { generating: Loader, queued: Clock3, waiting: Hourglass };

export interface TileStatusPillProps extends ComponentProps<"span"> {
  status: TileStatus;
}

/**
 * Pill / Tile status / Generating, / Queued and / Waiting (at the company, for Batch and Flex).
 * Sits on a tile, so it keeps its dark fill in both themes. Given `min-w-0 shrink`, a long label
 * ends in an ellipsis rather than running under what sits beside it.
 */
export function TileStatusPill({ status, className, children, ...props }: TileStatusPillProps) {
  const Icon = TILE_ICON[status];
  return (
    <span className={cn(pillBase, "bg-status-fill px-10 py-5 text-overlay-fg", className)} {...props}>
      <Icon
        size={12}
        aria-hidden
        className={cn(
          "shrink-0 text-overlay-fg-muted",
          status === "generating" && "motion-safe:animate-spin",
        )}
      />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/** Pill / Tile status / Cancel: a button, red on hover. */
export function TileCancelPill({ className, children, type = "button", ...props }: ComponentProps<"button">) {
  return (
    <button
      type={type}
      className={cn(
        pillBase,
        "cursor-pointer bg-status-fill px-10 py-5 text-overlay-fg-muted transition-colors not-disabled:not-aria-disabled:hover:text-danger disabled:cursor-default aria-disabled:cursor-default aria-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <X size={12} aria-hidden className="shrink-0 text-overlay-fg-muted" />
      {children}
    </button>
  );
}

export interface SettingSummaryPillProps extends ComponentProps<"span"> {
  icon: LucideIcon;
}

/** Pill / Setting summary: a company setting that isn't the default ("Batch") on its key card. */
export function SettingSummaryPill({ icon: Icon, className, children, ...props }: SettingSummaryPillProps) {
  return (
    <span
      className={cn(pillBase, "px-10 py-5 inset-ring inset-ring-border text-text-secondary", className)}
      {...props}
    >
      <Icon size={12} aria-hidden className="shrink-0 text-text-tertiary" />
      {children}
    </span>
  );
}
