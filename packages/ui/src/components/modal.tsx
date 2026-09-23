import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { IconButton } from "./icon-button";

export const Modal = Dialog.Root;
export const ModalTrigger = Dialog.Trigger;
export const ModalClose = Dialog.Close;

export interface ModalContentProps extends Omit<ComponentProps<typeof Dialog.Content>, "title"> {
  title: ReactNode;
  /** Name of the close button. Leave it out to hide the button (Esc still closes). */
  closeLabel?: string;
  /** For destructive confirmations: announced as an alert dialog. */
  alert?: boolean;
  /** Classes for the title row, for shells with their own insets (Modal / Provider settings). */
  headerClassName?: string;
}

/** Modal / Shell: 480 wide, title and close, then body and footer, over the scrim. */
export function ModalContent({
  title,
  closeLabel,
  alert = false,
  headerClassName,
  className,
  children,
  ...props
}: ModalContentProps) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim data-[state=open]:animate-pop-in" />
      <Dialog.Content
        role={alert ? "alertdialog" : "dialog"}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-48px)] w-480 max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-20 overflow-auto rounded-20 bg-elevated p-24 inset-ring inset-ring-border shadow-popover outline-none data-[state=open]:animate-pop-in",
          className,
        )}
        {...props}
      >
        <div className={cn("flex w-full items-center justify-between", headerClassName)}>
          <Dialog.Title className="text-page-title text-text-primary">{title}</Dialog.Title>
          {closeLabel ? (
            <Dialog.Close asChild>
              <IconButton icon={X} label={closeLabel} />
            </Dialog.Close>
          ) : null}
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
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
