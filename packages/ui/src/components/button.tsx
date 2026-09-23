import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { Spinner } from "./spinner";

// Button / {Primary, Secondary, Ghost, Danger, ...} / {S, M, L, XL, Field} on the Primitives board.
// Hover states aren't designed; they only nudge a fill or ring and never move anything.
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap transition-colors disabled:cursor-default",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg not-disabled:hover:bg-accent-hover",
        secondary:
          "bg-elevated-2 text-text-primary inset-ring inset-ring-border not-disabled:hover:inset-ring-border-strong",
        ghost: "text-text-secondary not-disabled:hover:bg-elevated-2 not-disabled:hover:text-text-primary",
        "ghost-accent": "text-accent not-disabled:hover:bg-accent-soft",
        danger: "bg-danger text-danger-fg not-disabled:hover:brightness-105",
        "danger-ghost":
          "bg-danger-soft text-danger not-disabled:hover:inset-ring not-disabled:hover:inset-ring-danger-line",
        overlay:
          "bg-overlay text-overlay-fg inset-ring inset-ring-overlay-line backdrop-blur-chip disabled:opacity-40",
        link: "text-accent underline-offset-2 not-disabled:hover:underline",
      },
      size: {
        s: "h-32 gap-6 rounded-8 px-12 text-small font-semibold",
        m: "h-40 gap-8 rounded-10 px-16 text-body-strong",
        l: "h-40 gap-6 rounded-10 px-12 text-small font-medium",
        xl: "h-44 gap-8 rounded-12 px-20 text-body-strong",
        field: "h-38 gap-6 rounded-10 px-14 text-small font-semibold",
      },
    },
    compoundVariants: [
      {
        variant: ["primary", "secondary", "danger", "danger-ghost"],
        class:
          "disabled:bg-elevated-2 disabled:text-text-tertiary disabled:inset-ring disabled:inset-ring-border",
      },
      { variant: ["ghost", "ghost-accent", "link"], class: "disabled:text-text-tertiary" },
      // Button / Link / S has no box: 12/600 text with 6px above and below.
      { variant: "link", class: "h-auto gap-4 rounded-8 px-0 py-6 text-caption font-semibold" },
    ],
    defaultVariants: { variant: "primary", size: "m" },
  },
);

const ICON_SIZE = { s: 14, m: 16, l: 15, xl: 16, field: 15 } as const;

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  /** Leading lucide icon, sized and colored by the button. */
  icon?: LucideIcon;
  /** Trailing price in mono, such as "~$0.04". */
  price?: string;
  /** Swaps the icon for a spinner and marks the button busy. */
  loading?: boolean;
  /** Render the child element (a router link, say) with the button's look. */
  asChild?: boolean;
}

export function Button({
  variant = "primary",
  size = "m",
  icon: Icon,
  price,
  loading = false,
  asChild = false,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  const Comp = (asChild ? Slot.Root : "button") as "button";
  const iconSize = variant === "link" ? 12 : ICON_SIZE[size ?? "m"];
  return (
    <Comp
      type={asChild ? undefined : type}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {loading ? (
        <Spinner size={iconSize} />
      ) : Icon ? (
        <Icon size={iconSize} aria-hidden className="shrink-0" />
      ) : null}
      <Slot.Slottable>{children}</Slot.Slottable>
      {price ? <span className="text-mono-12 font-normal">{price}</span> : null}
    </Comp>
  );
}
