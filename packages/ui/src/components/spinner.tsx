import { Loader } from "lucide-react";
import { cn } from "../lib/cn";

export interface SpinnerProps {
  /** 12 in pills, 16 in buttons and on its own. */
  size?: 12 | 14 | 15 | 16 | 17 | 18;
  /** Read out to screen readers. Leave it out when nearby text already says what is loading. */
  label?: string;
  className?: string;
}

/** Feedback / Spinner: lucide loader in the color of its surroundings. */
export function Spinner({ size = 16, label, className }: SpinnerProps) {
  const icon = (
    <Loader size={size} aria-hidden className={cn("shrink-0 motion-safe:animate-spin", className)} />
  );
  if (!label) return icon;
  return (
    <span role="status" className="inline-flex">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}
