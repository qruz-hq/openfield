import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";

/** The row of steps on first run: steps and connectors, 16 apart. */
export function Steps({ className, ...props }: ComponentProps<"ol">) {
  return <ol className={cn("flex items-center gap-16", className)} {...props} />;
}

export interface StepProps extends Omit<ComponentProps<"li">, "children"> {
  state: "current" | "upcoming" | "done";
  number: number;
  label: ReactNode;
}

/** Step indicator / Current, Upcoming and Done. */
export function Step({ state, number, label, className, ...props }: StepProps) {
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className={cn("flex items-center gap-8", className)}
      {...props}
    >
      <span
        className={cn(
          "flex size-22 shrink-0 items-center justify-center rounded-full text-micro font-semibold",
          state === "current" && "bg-accent-soft inset-ring inset-ring-accent-line text-accent",
          state === "upcoming" && "inset-ring inset-ring-border-strong text-text-tertiary",
          state === "done" && "bg-accent text-accent-fg",
        )}
      >
        {state === "done" ? <Check size={12} aria-hidden /> : number}
      </span>
      <span
        className={cn(
          "text-small font-medium",
          state === "current" ? "text-text-primary" : "text-text-secondary",
        )}
      >
        {label}
      </span>
    </li>
  );
}

/** Step connector: a 32px hairline between steps. */
export function StepConnector({ className, ...props }: Omit<ComponentProps<"li">, "children">) {
  return (
    <li aria-hidden className={cn("flex h-22 w-32 items-center", className)} {...props}>
      <span className="h-px w-full bg-border-strong" />
    </li>
  );
}
