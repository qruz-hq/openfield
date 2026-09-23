import { ChevronRight, type LucideIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { Keycap } from "./keycap";
import { surfaceVariants } from "./surface";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuGroup = DropdownMenu.Group;
export const MenuSub = DropdownMenu.Sub;

const menuSurface = cn(
  surfaceVariants({ variant: "popover" }),
  "z-50 w-220 gap-0 p-4 outline-none data-[state=open]:animate-pop-in",
);

/** Menu / Container: a 220px popover, 4px padding, rows flush. */
export function MenuContent({
  className,
  sideOffset = 6,
  align = "start",
  ...props
}: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(menuSurface, className)}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

const itemClass =
  "flex h-32 w-full cursor-pointer select-none items-center gap-10 rounded-8 px-10 text-small text-text-primary outline-none transition-colors data-highlighted:bg-elevated-2 data-disabled:cursor-default data-disabled:text-text-tertiary";

export interface MenuItemProps extends ComponentProps<typeof DropdownMenu.Item> {
  icon?: LucideIcon;
  /** Key hint on the right, such as "R". */
  shortcut?: string;
  /** Menu / Item / Danger: red icon and label, for Delete. */
  danger?: boolean;
}

/** Menu / Item, / Item / Icon and / Item / Danger. */
export function MenuItem({
  icon: Icon,
  shortcut,
  danger = false,
  className,
  children,
  ...props
}: MenuItemProps) {
  return (
    <DropdownMenu.Item className={cn(itemClass, danger && "text-danger", className)} {...props}>
      {Icon ? (
        <Icon
          size={16}
          aria-hidden
          className={cn("shrink-0", danger ? "text-danger" : "text-text-secondary")}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <Keycap>{shortcut}</Keycap> : null}
    </DropdownMenu.Item>
  );
}

/** A row that opens a submenu ("Add to folder"). */
export function MenuSubTrigger({
  icon: Icon,
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.SubTrigger> & { icon?: LucideIcon; children: ReactNode }) {
  return (
    <DropdownMenu.SubTrigger
      className={cn(itemClass, "data-[state=open]:bg-elevated-2", className)}
      {...props}
    >
      {Icon ? <Icon size={16} aria-hidden className="shrink-0 text-text-secondary" /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight size={14} aria-hidden className="shrink-0 text-text-tertiary" />
    </DropdownMenu.SubTrigger>
  );
}

export function MenuSubContent({
  className,
  sideOffset = 8,
  ...props
}: ComponentProps<typeof DropdownMenu.SubContent>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent sideOffset={sideOffset} className={cn(menuSurface, className)} {...props} />
    </DropdownMenu.Portal>
  );
}

/** Divider / Horizontal / Inset between menu groups. */
export function MenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenu.Separator>) {
  return (
    <DropdownMenu.Separator className={cn("w-full px-8 py-4", className)} {...props}>
      <div className="h-px w-full bg-border" />
    </DropdownMenu.Separator>
  );
}

/** Row / Group label inside a menu. */
export function MenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenu.Label>) {
  return (
    <DropdownMenu.Label
      className={cn("flex h-32 items-center px-10 text-caption font-medium text-text-tertiary", className)}
      {...props}
    />
  );
}
