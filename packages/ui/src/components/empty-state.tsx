import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { BrandMark } from "./brand";

export interface EmptyStateProps extends Omit<ComponentProps<"div">, "title"> {
  title: ReactNode;
  body?: ReactNode;
  /** Buttons, 12 apart. */
  actions?: ReactNode;
}

/** Empty state / Page: the 56px mark, a display headline and a line, then actions. 520 wide. */
export function EmptyStatePage({ title, body, actions, className, children, ...props }: EmptyStateProps) {
  return (
    <div className={cn("flex w-520 max-w-full flex-col items-center gap-32", className)} {...props}>
      <div className="flex w-full flex-col items-center gap-24">
        <BrandMark size={56} />
        <div className="flex w-full flex-col items-center gap-10">
          <h1 className="w-full text-center text-display leading-[1.2] text-text-primary">{title}</h1>
          {body ? (
            <p className="w-full text-center text-[15px] leading-[1.45] text-text-secondary">{body}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex items-center gap-12">{actions}</div> : null}
      {children}
    </div>
  );
}

export interface EmptyStateInlineProps extends EmptyStateProps {
  icon: LucideIcon;
}

/** Empty state / Inline: an icon in a circle, a title, a line and one action. 320 wide. */
export function EmptyStateInline({
  icon: Icon,
  title,
  body,
  actions,
  className,
  ...props
}: EmptyStateInlineProps) {
  return (
    <div className={cn("flex w-320 max-w-full flex-col items-center gap-12", className)} {...props}>
      <span className="flex size-40 items-center justify-center rounded-full bg-elevated-2">
        <Icon size={18} aria-hidden className="text-text-tertiary" />
      </span>
      <div className="flex w-full flex-col items-center gap-4">
        <p className="w-full text-center text-body-strong text-text-primary">{title}</p>
        {body ? (
          <p className="w-full text-center text-small leading-[1.45] text-text-secondary">{body}</p>
        ) : null}
      </div>
      {actions}
    </div>
  );
}
