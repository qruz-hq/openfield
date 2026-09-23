import { OptionRow, type OptionRowProps } from "@openfield/ui";
import type { KeyboardEvent, ReactNode } from "react";

// A popover list of options: ↑/↓ move, Enter or Space picks, Esc closes (Radix handles Esc).

export function Listbox({
  label,
  children,
  className,
  onType,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  /** A letter typed while the list has focus, for lists with a search field. */
  onType?: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const printable = event.key.length === 1 && event.key !== " ";
    if (onType && printable && !event.metaKey && !event.ctrlKey && !event.altKey) return onType();
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not([aria-disabled="true"])',
      ),
    ];
    if (!options.length) return;
    event.preventDefault();
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (at + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  };
  return (
    <div role="listbox" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown} className={className}>
      {children}
    </div>
  );
}

export function Option({
  onPick,
  disabled,
  selected,
  ...row
}: Omit<OptionRowProps, "asChild" | "children"> & { onPick: () => void }) {
  return (
    <OptionRow asChild selected={selected} disabled={disabled} {...row}>
      <button
        type="button"
        role="option"
        aria-selected={selected ?? false}
        aria-disabled={disabled || undefined}
        data-selected={selected || undefined}
        onClick={() => !disabled && onPick()}
      />
    </OptionRow>
  );
}

/** For PopoverContent's onOpenAutoFocus: focus the chosen row when a list opens, or the first one. */
export function focusSelected(container: { current: HTMLElement | null }) {
  return (event: Event) => {
    event.preventDefault();
    requestAnimationFrame(() => {
      const root = container.current;
      const target =
        root?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
        root?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])');
      target?.focus();
    });
  };
}
