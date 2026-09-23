import { Check, CircleAlert, Info, Loader, type LucideIcon, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { IconButton } from "./icon-button";
import { ProgressBar } from "./progress";

type ToastTone = "neutral" | "success" | "danger" | "progress";

const TONE: Record<ToastTone, { icon: LucideIcon; className: string }> = {
  neutral: { icon: Info, className: "text-text-secondary" },
  success: { icon: Check, className: "text-text-secondary" },
  danger: { icon: CircleAlert, className: "text-danger" },
  progress: { icon: Loader, className: "text-text-secondary motion-safe:animate-spin" },
};

const toastShell =
  "relative flex w-max max-w-420 items-center gap-12 overflow-hidden rounded-12 bg-elevated py-10 pr-10 pl-14 inset-ring inset-ring-border shadow-popover";

export interface ToastProps extends Omit<ComponentProps<"div">, "children" | "title"> {
  tone?: ToastTone;
  message: ReactNode;
  /** Optional second line. */
  description?: ReactNode;
  /** Ghost S button, such as "Undo". */
  actionLabel?: ReactNode;
  onAction?: () => void;
  onClose?: () => void;
  closeLabel?: string;
  /** 0 to 1. Draws the progress line along the bottom edge. */
  progress?: number;
}

/**
 * Feedback / Toast. Render it with sonner's toast.custom so it matches exactly:
 * toast.custom((id) => <Toast message="Deleted 2 images." actionLabel="Undo" onClose={() => toast.dismiss(id)} />)
 */
export function Toast({
  tone = "success",
  message,
  description,
  actionLabel,
  onAction,
  onClose,
  closeLabel,
  progress,
  className,
  ...props
}: ToastProps) {
  const { icon: Icon, className: iconClass } = TONE[tone];
  return (
    <div className={cn(toastShell, className)} {...props}>
      <Icon size={16} aria-hidden className={cn("shrink-0", iconClass)} />
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-small text-text-primary">{message}</span>
        {description ? <span className="text-caption text-text-tertiary">{description}</span> : null}
      </div>
      {actionLabel ? (
        <Button variant="ghost" size="s" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
      {onClose && closeLabel ? <IconButton icon={X} label={closeLabel} onClick={onClose} /> : null}
      {progress !== undefined ? (
        <ProgressBar value={progress} className="absolute inset-x-0 bottom-0" />
      ) : null}
    </div>
  );
}

/**
 * Class names for sonner's <Toaster toastOptions={{ unstyled: true, classNames: toastClassNames }} />,
 * for plain toast("...") calls. toast.custom with <Toast> is the exact match.
 */
export const toastClassNames = {
  toast: cn(toastShell, "font-sans"),
  content: "flex min-w-0 flex-col gap-2",
  title: "text-small text-text-primary",
  description: "text-caption text-text-tertiary",
  icon: "flex size-16 shrink-0 items-center justify-center text-text-secondary",
  error: "[&_[data-icon]]:text-danger",
  actionButton:
    "inline-flex h-32 shrink-0 cursor-pointer items-center rounded-8 px-12 text-small font-semibold text-text-secondary hover:bg-elevated-2 hover:text-text-primary",
  cancelButton:
    "inline-flex h-32 shrink-0 cursor-pointer items-center rounded-8 px-12 text-small font-semibold text-text-secondary hover:bg-elevated-2 hover:text-text-primary",
  closeButton:
    "inline-flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-8 text-text-secondary hover:bg-elevated-2 hover:text-text-primary",
} as const;

/** Where toasts sit: bottom center, 16 from the edge, 8 apart. On /image lift them to 170 above the composer. */
export const toasterPosition = { position: "bottom-center", offset: 16, gap: 8 } as const;
