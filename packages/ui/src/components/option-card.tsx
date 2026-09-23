import { RadioGroup as RadixRadioGroup } from "radix-ui";
import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "../lib/cn";
import { Badge } from "./badge";

export interface OptionCardProps extends Omit<ComponentProps<typeof RadixRadioGroup.Item>, "title"> {
  title: ReactNode;
  /** Neutral badge after the title, such as "Nano Banana Pro only". */
  badge?: ReactNode;
  /** Mono amount on the right, such as "$0.017–0.12". */
  price?: ReactNode;
  /** Words after the amount, such as "per image". */
  unit?: ReactNode;
  description?: ReactNode;
}

/**
 * Settings / Option card / {Idle, Selected, Disabled}: a radio as a whole card. Put it in a
 * RadioGroup. A disabled card that is still checked keeps the Selected look at half opacity.
 */
export function OptionCard({ title, badge, price, unit, description, className, ...props }: OptionCardProps) {
  const id = useId();
  // The name is the title; the badge, price and description are read after it.
  const described = [badge && `${id}-badge`, price && `${id}-price`, description && `${id}-description`]
    .filter(Boolean)
    .join(" ");
  return (
    <RadixRadioGroup.Item
      aria-labelledby={`${id}-title`}
      aria-describedby={described || undefined}
      className={cn(
        "group flex w-full cursor-pointer items-start gap-12 rounded-12 px-16 py-14 text-left inset-ring inset-ring-border transition-colors",
        "not-data-disabled:data-[state=unchecked]:hover:inset-ring-border-strong data-[state=checked]:bg-accent-soft data-[state=checked]:inset-ring-accent-line",
        "data-disabled:cursor-default data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {/* Radio / Off and / On: 18px, an 8px dot when checked. */}
      <span className="flex h-20 shrink-0 items-center">
        <span className="flex size-18 items-center justify-center rounded-full inset-ring inset-ring-control-line group-data-[state=checked]:bg-accent group-data-[state=checked]:inset-ring-0">
          <span className="hidden size-8 rounded-full bg-accent-fg group-data-[state=checked]:block" />
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-4">
        <span className="flex w-full items-center justify-between gap-12">
          <span className="flex min-w-0 items-center gap-8">
            <span id={`${id}-title`} className="text-body-medium leading-[1.43] text-text-primary">
              {title}
            </span>
            {badge ? (
              <Badge id={`${id}-badge`} variant="neutral">
                {badge}
              </Badge>
            ) : null}
          </span>
          {price ? (
            <span id={`${id}-price`} className="flex shrink-0 items-center gap-4">
              <span className="text-mono-13 font-medium text-text-primary">{price}</span>
              {/* Tertiary is too faint on the selected fill, so a checked card lifts it (WCAG AA). */}
              {unit ? (
                <span className="text-caption text-text-tertiary group-data-[state=checked]:text-text-secondary">
                  {unit}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        {description ? (
          <span id={`${id}-description`} className="w-full text-small leading-[1.45] text-text-secondary">
            {description}
          </span>
        ) : null}
      </span>
    </RadixRadioGroup.Item>
  );
}
