import { Tooltip as RadixTooltip } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { Keycap } from "./keycap";

/** Put one near the app root. */
export function TooltipProvider({
  delayDuration = 400,
  ...props
}: ComponentProps<typeof RadixTooltip.Provider>) {
  return <RadixTooltip.Provider delayDuration={delayDuration} {...props} />;
}

export interface TooltipProps extends Omit<ComponentProps<typeof RadixTooltip.Content>, "content"> {
  content: ReactNode;
  /** Key hint shown after the text, such as "F". */
  shortcut?: string;
  /** The element that shows the tooltip. It must accept a ref (every ui button does). */
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Feedback / Tooltip: 12/500 text on elevated-2, up to 240 wide, optional keycap. */
export function Tooltip({
  content,
  shortcut,
  children,
  open,
  defaultOpen,
  onOpenChange,
  sideOffset = 6,
  className,
  ...props
}: TooltipProps) {
  return (
    <RadixTooltip.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          sideOffset={sideOffset}
          className={cn(
            "z-50 flex max-w-240 items-center gap-8 rounded-8 bg-elevated-2 px-8 py-6 inset-ring inset-ring-border shadow-popover text-caption font-medium text-text-primary data-[state=delayed-open]:animate-pop-in",
            className,
          )}
          {...props}
        >
          <span>{content}</span>
          {shortcut ? <Keycap>{shortcut}</Keycap> : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
