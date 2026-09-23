import { ChevronDown, CircleDashed, type LucideIcon, Minus, Plus } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { ProviderLogo, type ProviderLogoId } from "./provider-logo";

// Chip / Setting / *: the 40px composer chips. They are buttons that open a popover, so Radix's
// data-state="open" on the trigger gives the Active look (accent-line ring) for free.
const chipBase =
  "group inline-flex h-40 shrink-0 cursor-pointer items-center gap-6 whitespace-nowrap rounded-12 bg-elevated-2 px-12 inset-ring inset-ring-border transition-colors data-[state=open]:inset-ring-accent-line data-open:inset-ring-accent-line disabled:cursor-default disabled:opacity-40";

export interface ChipProps extends Omit<ComponentProps<"button">, "children" | "value"> {
  icon: LucideIcon;
  value: ReactNode;
  /** Small label before the value, as in "Enhance Off". */
  label?: ReactNode;
  /** Active look when you control the popover yourself. */
  open?: boolean;
  /** Muted look: the value isn't in play for this model. */
  muted?: boolean;
  /** The model has no native control, so Openfield fakes it. Shows "~" before the value. */
  emulated?: boolean;
  /** The current value won't work with this model. */
  invalid?: boolean;
}

export function Chip({
  icon: Icon,
  value,
  label,
  open,
  muted = false,
  emulated = false,
  invalid = false,
  className,
  type = "button",
  ...props
}: ChipProps) {
  const quiet = muted || label !== undefined;
  return (
    <button
      type={type}
      data-open={open || undefined}
      aria-invalid={invalid || undefined}
      className={cn(chipBase, invalid && "inset-ring-danger", className)}
      {...props}
    >
      <Icon
        size={14}
        aria-hidden
        className={cn("shrink-0", quiet ? "text-text-tertiary" : "text-text-secondary")}
      />
      {label !== undefined ? (
        <span className="text-caption font-medium text-text-tertiary">{label}</span>
      ) : null}
      {emulated ? <span className="font-mono text-body text-text-tertiary">~</span> : null}
      <span className={cn("text-body-medium", muted ? "text-text-tertiary" : "text-text-primary")}>
        {value}
      </span>
    </button>
  );
}

export interface ModelChipProps extends Omit<ComponentProps<"button">, "children" | "name"> {
  /** Company whose logo leads the chip. Leave it out for the empty "Pick a model" state. */
  provider?: ProviderLogoId | null;
  /** Model name, or the empty-state prompt. */
  name: ReactNode;
  open?: boolean;
}

/** Chip / Setting / Model, / Model / Empty and / Model / Open. */
export function ModelChip({ provider, name, open, className, type = "button", ...props }: ModelChipProps) {
  return (
    <button type={type} data-open={open || undefined} className={cn(chipBase, className)} {...props}>
      {provider ? (
        <ProviderLogo provider={provider} />
      ) : (
        <CircleDashed size={14} aria-hidden className="shrink-0 text-text-tertiary" />
      )}
      <span className={cn("text-body-medium", provider ? "text-text-primary" : "text-text-secondary")}>
        {name}
      </span>
      <ChevronDown
        size={14}
        aria-hidden
        className="shrink-0 text-text-tertiary transition-transform group-data-open:rotate-180 group-data-open:text-text-secondary group-data-[state=open]:rotate-180 group-data-[state=open]:text-text-secondary"
      />
    </button>
  );
}

export interface StepperChipProps extends Omit<ComponentProps<"fieldset">, "children" | "onChange"> {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange: (value: number) => void;
  /** Accessible names, from the string catalogue. */
  label: string;
  decrementLabel: string;
  incrementLabel: string;
  disabled?: boolean;
  /** The model makes one image per call and Openfield repeats it. Shows a leading "~". */
  emulated?: boolean;
}

/** Chip / Setting / Stepper: the composer's image count. */
export function StepperChip({
  value,
  min = 1,
  max = 4,
  step = 1,
  onValueChange,
  label,
  decrementLabel,
  incrementLabel,
  disabled = false,
  emulated = false,
  className,
  ...props
}: StepperChipProps) {
  const atMin = disabled || value <= min;
  const atMax = disabled || value >= max;
  // A 24px hit area around each 14px icon, pulled back with a negative margin so the layout stays 14.
  const stepButton =
    "-m-5 inline-flex cursor-pointer items-center justify-center rounded-6 p-5 disabled:cursor-default";
  return (
    <fieldset
      aria-label={label}
      disabled={disabled}
      className={cn(
        "inline-flex h-40 min-w-0 shrink-0 items-center gap-10 rounded-12 bg-elevated-2 px-12 inset-ring inset-ring-border",
        disabled && "opacity-40",
        className,
      )}
      {...props}
    >
      {emulated ? (
        <span aria-hidden className="font-mono text-body text-text-tertiary">
          ~
        </span>
      ) : null}
      <button
        type="button"
        aria-label={decrementLabel}
        disabled={atMin}
        onClick={() => onValueChange(Math.max(min, value - step))}
        className={cn(stepButton, atMin ? "text-text-tertiary" : "text-text-secondary")}
      >
        <Minus size={14} aria-hidden />
      </button>
      <output aria-live="polite" className="text-body-medium text-text-primary">
        {value}
      </output>
      <button
        type="button"
        aria-label={incrementLabel}
        disabled={atMax}
        onClick={() => onValueChange(Math.min(max, value + step))}
        className={cn(stepButton, atMax ? "text-text-tertiary" : "text-text-secondary")}
      >
        <Plus size={14} aria-hidden />
      </button>
    </fieldset>
  );
}

export interface MiniChipProps extends Omit<ComponentProps<"button">, "children"> {
  label: ReactNode;
  /** Outline: a small icon before the label, like Copy. */
  icon?: LucideIcon;
  /** With glyph: a company logo before the label and a chevron after. */
  provider?: ProviderLogoId;
}

/** Chip / Mini / Outline and / With glyph. */
export function MiniChip({
  label,
  icon: Icon,
  provider,
  className,
  type = "button",
  ...props
}: MiniChipProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-6 px-7 py-3 inset-ring inset-ring-border text-micro font-medium text-text-secondary transition-colors not-disabled:hover:text-text-primary",
        provider ? "gap-5" : "gap-4",
        className,
      )}
      {...props}
    >
      {provider ? <ProviderLogo provider={provider} /> : null}
      {Icon && !provider ? <Icon size={11} aria-hidden className="shrink-0" /> : null}
      <span>{label}</span>
      {provider ? <ChevronDown size={11} aria-hidden className="shrink-0 text-text-tertiary" /> : null}
    </button>
  );
}

export interface ModelTagProps extends Omit<ComponentProps<"span">, "children"> {
  provider: ProviderLogoId;
  name: ReactNode;
  /** Compact price such as "~$0.04". Leave it out when there's no price. */
  price?: ReactNode;
}

/** Chip / Model tag: a model on a Settings card. Not interactive. */
export function ModelTag({ provider, name, price, className, ...props }: ModelTagProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-6 whitespace-nowrap rounded-8 bg-elevated-2 px-9 py-5 inset-ring inset-ring-border",
        className,
      )}
      {...props}
    >
      <ProviderLogo provider={provider} />
      <span className="text-caption text-text-primary">{name}</span>
      {price ? <span className="text-mono-11 text-text-tertiary">{price}</span> : null}
    </span>
  );
}
