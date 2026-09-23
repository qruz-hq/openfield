import type { LucideIcon } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactElement } from "react";
import { cn } from "../lib/cn";

// Icon button / {Ghost, Secondary, Overlay, Round, Tool, Accent} / {size}. Only the pairs that
// exist in design.pen are allowed, so a size can't drift from its radius and icon.
type Kind =
  | { variant?: "ghost"; size?: 24 | 28 | 32 | 40 }
  | { variant: "secondary"; size: 32 | 40 | "44x40" }
  | { variant: "overlay"; size: 32 | 38 }
  | { variant: "round"; size: 30 | 32 }
  | { variant: "tool"; size?: 36 }
  | { variant: "accent"; size?: 40 };

const DEFAULT_SIZE = { ghost: 28, secondary: 40, overlay: 38, round: 30, tool: 36, accent: 40 } as const;

const SPECS: Record<string, { box: string; icon: number }> = {
  "ghost-24": { box: "size-24 rounded-6", icon: 14 },
  "ghost-28": { box: "size-28 rounded-8", icon: 16 },
  "ghost-32": { box: "size-32 rounded-8", icon: 16 },
  "ghost-40": { box: "size-40 rounded-10", icon: 16 },
  "secondary-32": { box: "size-32 rounded-10 text-text-secondary", icon: 16 },
  "secondary-40": { box: "size-40 rounded-10 text-text-primary", icon: 16 },
  "secondary-44x40": { box: "h-40 w-44 rounded-10 text-text-primary", icon: 15 },
  "overlay-32": { box: "size-32 rounded-8", icon: 15 },
  "overlay-38": { box: "size-38 rounded-10", icon: 17 },
  "round-30": { box: "size-30 rounded-full", icon: 16 },
  "round-32": { box: "size-32 rounded-16 inset-ring inset-ring-border", icon: 16 },
  "tool-36": { box: "size-36 rounded-8", icon: 18 },
  "accent-40": { box: "size-40 rounded-full", icon: 18 },
};

const VARIANT = {
  ghost:
    "text-text-secondary not-disabled:hover:bg-elevated-2 not-disabled:hover:text-text-primary data-active:bg-elevated-2 data-active:text-text-primary disabled:text-text-tertiary",
  secondary:
    "bg-elevated-2 inset-ring inset-ring-border not-disabled:hover:inset-ring-border-strong disabled:text-text-tertiary",
  overlay:
    "bg-overlay text-overlay-fg inset-ring inset-ring-overlay-line backdrop-blur-chip disabled:opacity-40",
  round: "bg-elevated-2 text-text-secondary not-disabled:hover:text-text-primary disabled:text-text-tertiary",
  tool: "text-text-secondary not-data-active:not-disabled:hover:bg-elevated-2 data-active:bg-accent-soft data-active:text-accent disabled:text-text-tertiary",
  accent:
    "bg-accent text-accent-fg not-disabled:hover:bg-accent-hover disabled:bg-elevated-2 disabled:text-text-tertiary",
} as const;

export type IconButtonProps = Omit<ComponentProps<"button">, "children"> &
  Kind & {
    icon: LucideIcon;
    /** Accessible name. Icon-only buttons always need one. */
    label: string;
    /** Selected look: Ghost 28 / Active and Tool 36 / Active. */
    active?: boolean;
    /** Red icon, as on the selection bar's delete. */
    tone?: "danger";
    /** Render the child element (a router link, say) as the button. */
    asChild?: boolean;
    children?: ReactElement;
  };

export function IconButton({
  variant = "ghost",
  size,
  icon: Icon,
  label,
  active = false,
  tone,
  asChild = false,
  className,
  type = "button",
  children,
  ...props
}: IconButtonProps) {
  const spec = SPECS[`${variant}-${size ?? DEFAULT_SIZE[variant]}`] ?? SPECS["ghost-28"]!;
  const Comp = (asChild ? Slot.Root : "button") as "button";
  return (
    <Comp
      type={asChild ? undefined : type}
      aria-label={label}
      data-active={active || undefined}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center transition-colors disabled:cursor-default",
        VARIANT[variant],
        spec.box,
        tone === "danger" && "text-danger",
        className,
      )}
      {...props}
    >
      {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : null}
      <Icon size={spec.icon} aria-hidden className="shrink-0" />
    </Comp>
  );
}
