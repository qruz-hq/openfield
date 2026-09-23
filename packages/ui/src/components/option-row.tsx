import { Check } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";

// Popover / Option row / {Default, Selected, Disabled} and / With subtitle. Rows are 36 tall,
// 48 with a subtitle. Highlight (keyboard or hover) uses elevated-2; selection uses accent-soft.
export const optionRowClass =
  "flex w-full cursor-pointer select-none items-center gap-12 rounded-10 px-12 text-left outline-none transition-colors data-selected:bg-accent-soft not-data-selected:data-highlighted:bg-elevated-2 not-data-selected:not-data-disabled:hover:bg-elevated-2 data-selected:data-highlighted:inset-ring data-selected:data-highlighted:inset-ring-accent-line data-disabled:cursor-default";

export interface OptionRowContentProps {
  title: ReactNode;
  /** Second line. For a disabled row, say why. */
  subtitle?: ReactNode;
  /** 16px slot before the text: an aspect glyph, icon or company logo. */
  leading?: ReactNode;
  /** Mono price before the check, such as "~$0.04". */
  price?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  /** Replaces the check slot, for libraries (Radix Select) that render their own indicator. */
  indicator?: ReactNode;
}

/** The inside of an option row, so Radix items and plain rows share one layout. */
export function OptionRowContent({
  title,
  subtitle,
  leading,
  price,
  selected = false,
  disabled = false,
  indicator,
}: OptionRowContentProps) {
  return (
    <>
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span
          className={cn("truncate text-body-medium", disabled ? "text-text-tertiary" : "text-text-primary")}
        >
          {title}
        </span>
        {subtitle ? <span className="truncate text-caption text-text-tertiary">{subtitle}</span> : null}
      </span>
      {price ? <span className="shrink-0 text-mono-12 text-text-secondary">{price}</span> : null}
      <span className="flex size-16 shrink-0 items-center justify-center">
        {indicator ?? (selected ? <Check size={16} aria-hidden className="text-accent" /> : null)}
      </span>
    </>
  );
}

export interface OptionRowProps
  extends Omit<ComponentProps<"div">, "title">,
    Omit<OptionRowContentProps, "indicator"> {
  /** Render the child element (a Radix menu item, say) with the row's look. */
  asChild?: boolean;
}

/** A standalone option row. Wrap it in your own listbox or menu item with `asChild`. */
export function OptionRow({
  title,
  subtitle,
  leading,
  price,
  selected = false,
  disabled = false,
  asChild = false,
  className,
  children,
  ...props
}: OptionRowProps) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      role={asChild ? undefined : "option"}
      data-selected={selected || undefined}
      data-disabled={disabled || undefined}
      aria-selected={asChild ? undefined : selected}
      aria-disabled={disabled || undefined}
      className={cn(optionRowClass, subtitle ? "h-48" : "h-36", className)}
      {...props}
    >
      {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : null}
      <OptionRowContent
        title={title}
        subtitle={subtitle}
        leading={leading}
        price={price}
        selected={selected}
        disabled={disabled}
      />
    </Comp>
  );
}
