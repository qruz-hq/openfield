import { Check, ChevronDown } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./field";
import { OptionRowContent } from "./option-row";

export interface SelectProps extends ComponentProps<typeof RadixSelect.Root> {
  placeholder?: ReactNode;
  /** 16px slot before the value: a company logo, aspect glyph or icon. */
  leading?: ReactNode;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

/**
 * Input / Select: the 38px trigger opens a Surface / Popover of option rows.
 * The open trigger gets the accent-line ring and its chevron flips.
 */
export function Select({
  placeholder,
  leading,
  id,
  className,
  children,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  ...props
}: SelectProps) {
  const field = useFieldControl({ id, "aria-describedby": describedBy });
  return (
    <RadixSelect.Root {...props}>
      <RadixSelect.Trigger
        id={field.id}
        aria-label={ariaLabel}
        aria-describedby={field["aria-describedby"]}
        className={cn(
          "group flex h-38 w-full min-w-0 cursor-pointer items-center justify-between gap-8 rounded-10 bg-surface px-12 inset-ring inset-ring-border text-small text-text-primary transition-shadow data-[state=open]:inset-ring-accent-line data-placeholder:text-text-tertiary disabled:cursor-default disabled:opacity-40",
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-8">
          {leading}
          <span className="truncate">
            <RadixSelect.Value placeholder={placeholder} />
          </span>
        </span>
        <RadixSelect.Icon asChild>
          <ChevronDown
            size={14}
            aria-hidden
            className="shrink-0 text-text-tertiary transition-transform group-data-[state=open]:rotate-180"
          />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={8}
          className="z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden rounded-16 bg-elevated inset-ring inset-ring-border shadow-popover data-[state=open]:animate-pop-in"
        >
          <RadixSelect.Viewport className="flex flex-col gap-2 p-8">{children}</RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

export interface SelectItemProps extends Omit<ComponentProps<typeof RadixSelect.Item>, "title" | "children"> {
  /** What the trigger shows once picked. */
  children: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  price?: ReactNode;
}

/** A Popover / Option row inside a Select. */
export function SelectItem({
  children,
  subtitle,
  leading,
  price,
  disabled,
  className,
  ...props
}: SelectItemProps) {
  return (
    <RadixSelect.Item
      disabled={disabled}
      className={cn(
        "flex w-full cursor-pointer select-none items-center gap-12 rounded-10 px-12 text-left outline-none transition-colors data-[state=checked]:bg-accent-soft data-[state=unchecked]:data-highlighted:bg-elevated-2 data-[state=checked]:data-highlighted:inset-ring data-[state=checked]:data-highlighted:inset-ring-accent-line data-disabled:cursor-default",
        subtitle ? "h-48" : "h-36",
        className,
      )}
      {...props}
    >
      <OptionRowContent
        title={<RadixSelect.ItemText>{children}</RadixSelect.ItemText>}
        subtitle={subtitle}
        leading={leading}
        price={price}
        disabled={disabled}
        indicator={
          <RadixSelect.ItemIndicator>
            <Check size={16} aria-hidden className="text-accent" />
          </RadixSelect.ItemIndicator>
        }
      />
    </RadixSelect.Item>
  );
}
