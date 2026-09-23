import type { LucideIcon } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { Keycap } from "./keycap";

/** A <dl> for Row / Key value rows, 8 apart as in the Details block. */
export function KeyValueList({ className, ...props }: ComponentProps<"dl">) {
  return <dl className={cn("flex w-full flex-col gap-8", className)} {...props} />;
}

export interface KeyValueRowProps extends Omit<ComponentProps<"div">, "children"> {
  label: ReactNode;
  value: ReactNode;
  /** Mono value for sizes and costs. */
  mono?: boolean;
  /** A 16px logo before the value (Row / Key value / With glyph). */
  glyph?: ReactNode;
}

/** Row / Key value / {Text, Mono, With glyph}. Use inside a KeyValueList. */
export function KeyValueRow({ label, value, mono = false, glyph, className, ...props }: KeyValueRowProps) {
  return (
    <div className={cn("flex w-full items-center justify-between", className)} {...props}>
      <dt className="shrink-0 text-small text-text-secondary">{label}</dt>
      <dd
        className={cn(
          "flex min-w-0 items-center gap-6 text-text-primary",
          mono ? "text-mono-12" : "text-small",
        )}
      >
        {glyph}
        <span className="truncate">{value}</span>
      </dd>
    </div>
  );
}

/** Row / Section label: "Details", uppercased by CSS. */
export function SectionLabel({
  className,
  asChild = false,
  ...props
}: ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp className={cn("flex w-full items-center text-caps text-text-tertiary", className)} {...props} />
  );
}

/** Row / Group label: a 32px list heading such as "Recent" or "Aspect ratio". */
export function GroupLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-32 w-full items-center px-12 text-caption font-medium text-text-tertiary",
        className,
      )}
      {...props}
    />
  );
}

export interface NavRowProps extends Omit<ComponentProps<"a">, "children"> {
  icon: LucideIcon;
  label: ReactNode;
  /** Mono count on the right, such as the number of images in a folder. */
  count?: ReactNode;
  active?: boolean;
  /** Render the child element (a router link) with the row's look. */
  asChild?: boolean;
  children?: ReactNode;
}

/** Row / Nav / Active and / Idle: settings rail and library sidebar rows. */
export function NavRow({
  icon: Icon,
  label,
  count,
  active = false,
  asChild = false,
  className,
  children,
  ...props
}: NavRowProps) {
  const Comp = (asChild ? Slot.Root : "a") as "a";
  return (
    <Comp
      aria-current={active ? "page" : undefined}
      data-active={active || undefined}
      className={cn(
        "flex h-34 w-full cursor-pointer items-center gap-10 rounded-10 px-10 text-body transition-colors",
        active ? "bg-accent-soft font-medium text-accent" : "text-text-secondary hover:bg-elevated-2",
        className,
      )}
      {...props}
    >
      {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : null}
      <Icon size={16} aria-hidden className={cn("shrink-0", active ? "text-accent" : "text-text-tertiary")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? <span className="shrink-0 text-mono-12 text-text-tertiary">{count}</span> : null}
    </Comp>
  );
}

export interface GroupHeaderProps extends Omit<ComponentProps<"div">, "children"> {
  label: ReactNode;
  /** Usually a Ghost 24 icon button, such as "New folder". */
  action?: ReactNode;
}

/** Row / Group header: sidebar section heading with an optional action. */
export function GroupHeader({ label, action, className, ...props }: GroupHeaderProps) {
  return (
    <div className={cn("flex h-28 w-full items-center justify-between pr-4 pl-10", className)} {...props}>
      <span className="text-caption font-medium text-text-tertiary">{label}</span>
      {action}
    </div>
  );
}

export interface SettingTextProps extends Omit<ComponentProps<"div">, "title" | "children"> {
  title: ReactNode;
  description?: ReactNode;
  /** Id for the title, so a control on the row can point at it. */
  titleId?: string;
}

/** Row / Setting / Text: the left side of every settings row. */
export function SettingText({ title, description, titleId, className, ...props }: SettingTextProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} {...props}>
      <span id={titleId} className="text-body-medium text-text-primary">
        {title}
      </span>
      {description ? (
        <span className="text-small leading-[1.45] text-text-secondary">{description}</span>
      ) : null}
    </div>
  );
}

export interface CommandRowProps extends Omit<ComponentProps<"div">, "children"> {
  /** Leading 16px: an icon, company logo or thumbnail. */
  leading?: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  /** Key hints, each shown as a keycap. */
  shortcut?: string[];
  active?: boolean;
}

/** Row / Command / Default, Active and Model. cmdk's data-selected also gives the Active look. */
export function CommandRow({
  leading,
  label,
  meta,
  shortcut,
  active = false,
  className,
  ...props
}: CommandRowProps) {
  return (
    <div
      data-active={active || undefined}
      className={cn(
        "flex h-40 w-full cursor-pointer items-center gap-12 rounded-10 px-12 data-active:bg-elevated-2 data-[selected=true]:bg-elevated-2",
        className,
      )}
      {...props}
    >
      {leading ? (
        <span className="flex size-16 shrink-0 items-center justify-center text-text-secondary">
          {leading}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-body text-text-primary">{label}</span>
      {meta ? <span className="shrink-0 text-caption text-text-tertiary">{meta}</span> : null}
      {shortcut?.length ? (
        <span className="flex shrink-0 items-center gap-4">
          {shortcut.map((key) => (
            <Keycap key={key}>{key}</Keycap>
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** App / Nav item / Active and / Idle: Image, Assets, Canvas in the top nav. */
export function TopNavItem({
  active = false,
  asChild = false,
  className,
  ...props
}: ComponentProps<"a"> & { active?: boolean; asChild?: boolean }) {
  const Comp = (asChild ? Slot.Root : "a") as "a";
  return (
    <Comp
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center rounded-8 px-10 py-6 text-body transition-colors",
        active ? "bg-accent-soft font-semibold text-accent" : "text-text-secondary hover:text-text-primary",
        className,
      )}
      {...props}
    />
  );
}
