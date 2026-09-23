import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleDashed,
  Clock3,
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

export type TileStatus = "generating" | "queued";

export interface TileStatusPillProps extends ComponentProps<"span"> {
  status: TileStatus;
}

/** Pill / Tile status / Generating and / Queued. Sits on a tile, so it keeps its dark fill in both themes. */
export function TileStatusPill({ status, className, children, ...props }: TileStatusPillProps) {
  const Icon = status === "generating" ? Loader : Clock3;
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
      {children}
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
        "cursor-pointer bg-status-fill px-10 py-5 text-overlay-fg-muted transition-colors hover:text-danger",
        className,
      )}
      {...props}
    >
      <X size={12} aria-hidden className="shrink-0 text-overlay-fg-muted" />
      {children}
    </button>
  );
}
