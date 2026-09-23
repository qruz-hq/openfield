import { ClipboardPaste, Eye, EyeOff, Lock, Search, X } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./field";

// The 38px field box shared by Input / Text, Key, Select and Stepper. The focus ring goes on the
// box, not the bare <input> inside it.
export const fieldBox =
  "flex h-38 w-full min-w-0 items-center rounded-10 bg-surface px-12 inset-ring inset-ring-border transition-shadow has-[input:focus]:inset-ring-border-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent";

const bareInput =
  "min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-tertiary focus-visible:outline-none disabled:cursor-default";

export interface InputProps extends Omit<ComponentProps<"input">, "size"> {
  /** JetBrains Mono, for numbers such as a price limit. */
  mono?: boolean;
  /** Text before the value, such as "$". */
  leading?: ReactNode;
  /** Text after the value, such as a unit. */
  trailing?: ReactNode;
  /** Classes for the box. `className` goes on the <input>. */
  boxClassName?: string;
}

/** Input / Text and Input / Text / Mono. */
export function Input({ mono = false, leading, trailing, boxClassName, className, ...props }: InputProps) {
  const field = useFieldControl({ id: props.id, "aria-describedby": props["aria-describedby"] });
  return (
    <div className={cn(fieldBox, "gap-8", props.disabled && "opacity-40", boxClassName)}>
      {leading ? <span className="shrink-0 text-mono-13 text-text-tertiary">{leading}</span> : null}
      <input
        {...props}
        id={field.id}
        aria-describedby={field["aria-describedby"]}
        className={cn(bareInput, mono ? "text-mono-13" : "text-small", className)}
      />
      {trailing ? <span className="shrink-0 text-small text-text-secondary">{trailing}</span> : null}
    </div>
  );
}

export interface SearchInputProps extends Omit<ComponentProps<"input">, "size" | "type"> {
  /** `field` is the 32px box (Input / Search). `header` is the 48px bare row at the top of a picker. */
  variant?: "field" | "header";
  /** Shows a clear button while there is text. */
  onClear?: () => void;
  clearLabel?: string;
  boxClassName?: string;
}

/** Input / Search and Input / Search / Header. */
export function SearchInput({
  variant = "field",
  onClear,
  clearLabel,
  boxClassName,
  className,
  ...props
}: SearchInputProps) {
  const field = useFieldControl({ id: props.id, "aria-describedby": props["aria-describedby"] });
  const header = variant === "header";
  const hasText = props.value !== undefined && String(props.value).length > 0;
  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-center",
        header
          ? "h-48 gap-10 px-20"
          : "h-32 gap-8 rounded-8 bg-elevated px-10 inset-ring inset-ring-border transition-shadow has-[input:focus]:inset-ring-border-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        boxClassName,
      )}
    >
      <Search size={header ? 16 : 14} aria-hidden className="shrink-0 text-text-tertiary" />
      <input
        {...props}
        type="search"
        id={field.id}
        aria-describedby={field["aria-describedby"]}
        className={cn(
          bareInput,
          header ? "text-body" : "text-small",
          "[&::-webkit-search-cancel-button]:appearance-none",
          className,
        )}
      />
      {onClear && hasText ? (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={onClear}
          className="-m-5 inline-flex shrink-0 cursor-pointer rounded-6 p-5 text-text-tertiary hover:text-text-secondary"
        >
          <X size={14} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export interface KeyInputProps extends Omit<ComponentProps<"input">, "size" | "type" | "onChange"> {
  value: string;
  onValueChange?: (value: string) => void;
  /** Error look: the key was rejected. Put the reason in the field's description. */
  invalid?: boolean;
  /** The key comes from outside Openfield and can't be edited here. */
  locked?: boolean;
  lockedLabel?: string;
  /** A saved key, already masked by the server ("••••3f9a"). Shown read-only. */
  masked?: string;
  /** Called by the paste button, shown while the field is empty. */
  onPasteClick?: () => void;
  pasteLabel?: string;
  revealLabel?: string;
  hideLabel?: string;
  boxClassName?: string;
}

/** Input / Key / {Filled, Empty, Error, Locked}. Masked unless revealed. */
export function KeyInput({
  value,
  onValueChange,
  invalid = false,
  locked = false,
  lockedLabel,
  masked,
  onPasteClick,
  pasteLabel,
  revealLabel,
  hideLabel,
  boxClassName,
  className,
  ...props
}: KeyInputProps) {
  const [revealed, setRevealed] = useState(false);
  const field = useFieldControl({ id: props.id, "aria-describedby": props["aria-describedby"] });
  const iconButton =
    "-m-5 inline-flex shrink-0 cursor-pointer rounded-6 p-5 text-text-tertiary hover:text-text-secondary";

  if (locked) {
    return (
      <div className={cn(fieldBox, "justify-between gap-8 bg-elevated", boxClassName)}>
        <input
          id={field.id}
          aria-describedby={field["aria-describedby"]}
          readOnly
          value={lockedLabel ?? ""}
          className={cn(bareInput, "truncate text-small text-text-tertiary", className)}
        />
        <Lock size={15} aria-hidden className="shrink-0 text-text-tertiary" />
      </div>
    );
  }

  const showMasked = masked !== undefined && value === "";
  return (
    <div className={cn(fieldBox, "justify-between gap-8", invalid && "inset-ring-danger", boxClassName)}>
      <input
        {...props}
        id={field.id}
        aria-describedby={field["aria-describedby"]}
        aria-invalid={invalid || undefined}
        type={revealed ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={showMasked ? masked : props.placeholder}
        onChange={(event) => onValueChange?.(event.target.value)}
        className={cn(
          bareInput,
          "text-mono-12 text-text-secondary placeholder:font-sans placeholder:text-small",
          showMasked && "placeholder:font-mono placeholder:text-mono-12 placeholder:text-text-secondary",
          className,
        )}
      />
      {value === "" && onPasteClick ? (
        <button type="button" aria-label={pasteLabel} onClick={onPasteClick} className={iconButton}>
          <ClipboardPaste size={15} aria-hidden />
        </button>
      ) : value !== "" ? (
        <button
          type="button"
          aria-label={revealed ? hideLabel : revealLabel}
          aria-pressed={revealed}
          onClick={() => setRevealed((r) => !r)}
          className={iconButton}
        >
          {revealed ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
        </button>
      ) : null}
    </div>
  );
}

export interface TextareaProps extends Omit<ComponentProps<"textarea">, "size"> {
  /** Shows "12 / 400" in the corner. Uses `maxLength`. */
  counter?: boolean;
  boxClassName?: string;
}

/** Input / Textarea: grows with its text, from 76px tall. */
export function Textarea({ counter = false, boxClassName, className, onChange, ...props }: TextareaProps) {
  const field = useFieldControl({ id: props.id, "aria-describedby": props["aria-describedby"] });
  const [uncontrolledLength, setLength] = useState(String(props.defaultValue ?? "").length);
  const length = props.value !== undefined ? String(props.value).length : uncontrolledLength;
  return (
    <div
      className={cn(
        "flex min-h-76 w-full flex-col justify-between rounded-10 bg-surface p-10 inset-ring inset-ring-border transition-shadow has-[textarea:focus]:inset-ring-border-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        boxClassName,
      )}
    >
      <textarea
        {...props}
        id={field.id}
        aria-describedby={field["aria-describedby"]}
        onChange={(event) => {
          setLength(event.target.value.length);
          onChange?.(event);
        }}
        className={cn(
          "field-sizing-content min-h-0 w-full flex-1 resize-none bg-transparent text-small leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary focus-visible:outline-none",
          className,
        )}
      />
      {counter && props.maxLength ? (
        <div className="flex justify-end">
          <span className="text-mono-11 text-text-tertiary">
            {length} / {props.maxLength}
          </span>
        </div>
      ) : null}
    </div>
  );
}
