import { t } from "@openfield/core";
import { Chip, GroupLabel, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@openfield/ui";
import type { LucideIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { focusSelected, Listbox, Option } from "./listbox";

// Chip / Setting / Default with its option list above it (aspect, quality, resolution).
// Options are the model's own, never a house list (§0.3).

export interface ChipOption<V extends string> {
  value: V;
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  price?: string;
  /** Greyed out, with the reason as its subtitle (a "partial" control). */
  disabled?: boolean;
}

export function OptionChip<V extends string>({
  icon,
  label,
  value,
  valueLabel,
  options,
  onChange,
  width,
  emulated,
}: {
  icon: LucideIcon;
  /** The list's heading and the chip's accessible name, such as "Aspect ratio". */
  label: string;
  value: V | undefined;
  valueLabel: string;
  options: readonly ChipOption<V>[];
  onChange: (value: V) => void;
  /** Popover width class: w-240 for aspect and resolution, w-300 for quality. */
  width: string;
  emulated?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Chip
          icon={icon}
          value={valueLabel}
          emulated={emulated}
          aria-label={t("composer.chips.value", { label, value: valueLabel })}
        />
      </PopoverTrigger>
      <PopoverContent side="top" className={width} onOpenAutoFocus={focusSelected(list)}>
        <div ref={list} className="flex flex-col gap-2">
          <GroupLabel>{label}</GroupLabel>
          <Listbox label={label} className="flex flex-col gap-2">
            {options.map((option) => (
              <Option
                key={option.value}
                title={option.title}
                subtitle={option.subtitle}
                leading={option.leading}
                price={option.price}
                disabled={option.disabled}
                selected={option.value === value}
                onPick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              />
            ))}
          </Listbox>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A core control this model doesn't have: shown disabled so the bar doesn't jump, with the reason.
 * aria-disabled rather than disabled, so it still takes focus and shows its tooltip.
 */
export function DisabledChip({ icon, value, reason }: { icon: LucideIcon; value: string; reason: string }) {
  return (
    <Tooltip content={reason}>
      <Chip
        icon={icon}
        value={value}
        aria-disabled="true"
        aria-label={t("composer.chips.value", { label: value, value: reason })}
        onClick={(event) => event.preventDefault()}
        className="cursor-default opacity-40"
      />
    </Tooltip>
  );
}
