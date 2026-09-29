import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { IconButton } from "./icon-button";

export const Modal = Dialog.Root;
export const ModalTrigger = Dialog.Trigger;
export const ModalClose = Dialog.Close;

export interface ModalSurfaceProps extends ComponentProps<typeof Dialog.Content> {
  /** For destructive confirmations: announced as an alert dialog. */
  alert?: boolean;
}

/**
 * The portal, scrim and positioned, rounded panel every modal shares - no forced width, padding or
 * header, for a shell built to its own spec (the Assets picker, design q31cb) instead of
 * ModalContent's title-and-body common case below.
 */
export function ModalSurface({ alert = false, className, children, ...props }: ModalSurfaceProps) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim data-[state=open]:animate-pop-in" />
      <Dialog.Content
        role={alert ? "alertdialog" : "dialog"}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-48px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-20 bg-elevated inset-ring inset-ring-border shadow-popover outline-none data-[state=open]:animate-pop-in",
          className,
        )}
        {...props}
      >
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

export interface ModalContentProps extends Omit<ModalSurfaceProps, "title"> {
  title: ReactNode;
  /** Name of the close button. Leave it out to hide the button (Esc still closes). */
  closeLabel?: string;
  /** Classes for the title row, for shells with their own insets (Modal / Provider settings). */
  headerClassName?: string;
}

/** Modal / Shell: 480 wide, title and close, then body and footer, over the scrim. */
export function ModalContent({
  title,
  closeLabel,
  headerClassName,
  className,
  children,
  ...props
}: ModalContentProps) {
  return (
    <ModalSurface className={cn("w-480 gap-20 overflow-auto p-24", className)} {...props}>
      <div className={cn("flex w-full items-center justify-between", headerClassName)}>
        <ModalTitle>{title}</ModalTitle>
        {closeLabel ? (
          <Dialog.Close asChild>
            <IconButton icon={X} label={closeLabel} />
          </Dialog.Close>
        ) : null}
      </div>
      {children}
    </ModalSurface>
  );
}

/**
 * The dialog's accessible name: required somewhere in a ModalSurface, since Radix otherwise leaves
 * it unnamed. ModalContent renders one itself; a shell built on ModalSurface directly needs its own.
 */
export function ModalTitle({ className, ...props }: ComponentProps<typeof Dialog.Title>) {
  return <Dialog.Title className={cn("text-page-title text-text-primary", className)} {...props} />;
}

/** Body copy: 14px, line height 1.5, secondary. Also the dialog's accessible description. */
export function ModalDescription({ className, ...props }: ComponentProps<typeof Dialog.Description>) {
  return (
    <Dialog.Description
      className={cn("w-full text-body leading-[1.5] text-text-secondary", className)}
      {...props}
    />
  );
}

/** Footer: buttons on the right, 8 apart. */
export function ModalFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex w-full items-center justify-end gap-8", className)} {...props} />;
}
