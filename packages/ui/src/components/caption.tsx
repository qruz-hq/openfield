import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { ProviderLogo, type ProviderLogoId } from "./provider-logo";

export interface ModelCaptionProps extends Omit<ComponentProps<"span">, "children"> {
  provider: ProviderLogoId;
  name: ReactNode;
  /** Billed amount in mono, such as "$0.04". */
  cost?: ReactNode;
  /** `stacked` puts the cost under the name (library hover). */
  layout?: "inline" | "stacked";
  /** On a photo: light text in both themes. */
  onImage?: boolean;
}

/** Caption / Model / Inline and / Stacked: logo, model name, cost. */
export function ModelCaption({
  provider,
  name,
  cost,
  layout = "inline",
  onImage = false,
  className,
  ...props
}: ModelCaptionProps) {
  const nameClass = cn("text-micro font-medium", onImage ? "text-overlay-fg" : "text-text-primary");
  const costClass = cn("text-mono-11", onImage ? "text-overlay-fg-muted" : "text-text-secondary");
  const logo = <ProviderLogo provider={provider} className={onImage ? "text-overlay-fg" : undefined} />;
  if (layout === "stacked") {
    return (
      <span className={cn("inline-flex flex-col gap-2", className)} {...props}>
        <span className="inline-flex items-center gap-6">
          {logo}
          <span className={nameClass}>{name}</span>
        </span>
        {cost ? <span className={costClass}>{cost}</span> : null}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-6", className)} {...props}>
      {logo}
      <span className={nameClass}>{name}</span>
      {cost ? <span className={costClass}>{cost}</span> : null}
    </span>
  );
}

/** Text / Highlight: a changed span in the improved prompt. */
export function Highlight({ className, ...props }: ComponentProps<"mark">) {
  return <mark className={cn("rounded-4 bg-accent-soft px-2 text-text-primary", className)} {...props} />;
}
