import { Check } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { optionRowClass } from "./option-row";

// Model picker / Row / {Default, Selected, Needs key}: 56 tall, a 32px logo tile, name 14/500,
// description 12, a mono 12/500 price, then the 16px check slot.

export interface ModelRowProps extends Omit<ComponentProps<"div">, "title"> {
  name: ReactNode;
  description?: ReactNode;
  /** The 32px logo tile (ProviderLogo variant="tile"). */
  logo?: ReactNode;
  /** "~$0.04". */
  price?: ReactNode;
  /** Words after the price, such as "· Standard". */
  priceNote?: ReactNode;
  selected?: boolean;
  /** Set when the company has no key yet: the row greys out and this link takes the price's place. */
  addKeyLabel?: string;
  /** Render the child element (a listbox button, say) with the row's look. */
  asChild?: boolean;
}

export function ModelRow({
  name,
  description,
  logo,
  price,
  priceNote,
  selected = false,
  addKeyLabel,
  asChild = false,
  className,
  children,
  ...props
}: ModelRowProps) {
  const Comp = asChild ? Slot.Root : "div";
  const needsKey = addKeyLabel !== undefined;
  return (
    <Comp data-selected={selected || undefined} className={cn(optionRowClass, "h-56", className)} {...props}>
      {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : null}
      {logo ? <span className={cn("flex shrink-0", needsKey && "opacity-50")}>{logo}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span
          className={cn(
            "truncate text-body-medium leading-18",
            needsKey ? "text-text-tertiary" : "text-text-primary",
          )}
        >
          {name}
        </span>
        {description ? (
          <span className="truncate text-caption leading-16 text-text-tertiary">{description}</span>
        ) : null}
      </span>
      {needsKey ? (
        <span className="shrink-0 py-6 text-caption font-semibold text-accent">{addKeyLabel}</span>
      ) : price ? (
        <span className="flex shrink-0 items-center gap-4">
          <span className="text-mono-12 font-medium text-text-secondary">{price}</span>
          {priceNote ? <span className="text-caption text-text-tertiary">{priceNote}</span> : null}
        </span>
      ) : null}
      <span className="flex size-16 shrink-0 items-center justify-center">
        {selected ? <Check size={16} aria-hidden className="text-accent" /> : null}
      </span>
    </Comp>
  );
}
