import { Info, type LucideIcon, TriangleAlert, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { IconButton } from "./icon-button";

export interface BannerProps extends Omit<ComponentProps<"div">, "children"> {
  /** `info` is neutral. `error` (and `offline`, the same look) is for things that will fail. */
  variant?: "info" | "error" | "offline";
  message: ReactNode;
  icon?: LucideIcon;
  /** Buttons that replace the close button, such as "Keep mine" and "Reload". */
  actions?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}

/** Banner / Info, / Error and / Offline: a 40px strip with an icon, a message and a close button. */
export function Banner({
  variant = "info",
  message,
  icon,
  actions,
  onDismiss,
  dismissLabel,
  className,
  ...props
}: BannerProps) {
  const info = variant === "info";
  const Icon = icon ?? (info ? Info : TriangleAlert);
  return (
    <div
      role={info ? "status" : "alert"}
      className={cn(
        "flex h-40 w-full items-center gap-10 rounded-10 px-16",
        info ? "bg-elevated inset-ring inset-ring-border" : "bg-danger-soft",
        className,
      )}
      {...props}
    >
      <Icon size={16} aria-hidden className={cn("shrink-0", info ? "text-text-secondary" : "text-danger")} />
      <span className="min-w-0 flex-1 truncate text-small text-text-primary">{message}</span>
      {actions ? <div className="flex shrink-0 items-center gap-8">{actions}</div> : null}
      {!actions && onDismiss && dismissLabel ? (
        <IconButton icon={X} label={dismissLabel} onClick={onDismiss} />
      ) : null}
    </div>
  );
}
