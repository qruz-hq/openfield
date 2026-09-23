import type { ComponentProps, SVGProps } from "react";
import { cn } from "../lib/cn";

// The aperture mark, from the Brand board at 56px. Smaller sizes scale the same paths.
const PETALS = [
  "M38.22 16.184l-11.163-6.888c-1.941-1.167-4.499-0.579-5.628 1.344-0.989 1.745-0.383 4.032 1.447 5.049l11.657 7.075c1.857 1.064 4.153 0.42 5.208-1.512 0.868-1.755 0.205-4.023-1.521-5.068z",
  "M18.359 17.547l-7.971 8.353c-1.503 1.596-1.307 4.256 0.383 5.824 1.671 1.484 4.284 1.232 5.731-0.467l7.177-8.54c1.372-1.568 1.129-3.957-0.373-5.385-1.512-1.204-3.584-1.092-4.947 0.215z",
  "M21.597 32.368c-1.932-1.157-4.48-0.467-5.497 1.521-0.887 1.876-0.243 4.125 1.521 5.292l11.769 7.504c1.923 1.176 4.489 0.616 5.721-1.297 1.055-1.783 0.513-4.097-1.288-5.124l-12.227-7.896z",
  "M40.152 23.231l-7.345 10.239c-1.232 1.708-0.803 4.191 0.952 5.423 1.764 1.185 4.135 0.569 5.395-1.185l6.907-9.753c1.139-1.727 0.775-4.135-0.859-5.479-1.596-1.148-3.771-0.775-5.049 0.756z",
];

const BRAND_NAME = "Openfield";

export interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  /** 18 in the nav, 24 in canvas chrome, 56 on empty states. */
  size?: 18 | 24 | 56;
  /** Gives the mark an accessible name. Leave it out when a visible name sits next to it. */
  title?: string;
}

export function BrandMark({ size = 18, title, className, ...props }: BrandMarkProps) {
  const petals = PETALS.map((d) => <path key={d} d={d} />);
  const shared = {
    viewBox: "0 0 56 56",
    width: size,
    height: size,
    className: cn("shrink-0 fill-accent", className),
  };
  if (title) {
    return (
      <svg role="img" {...shared} {...props}>
        <title>{title}</title>
        {petals}
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" {...shared} {...props}>
      {petals}
    </svg>
  );
}

export type BrandLockupProps = ComponentProps<"span">;

/** Brand / Lockup: the 18px mark and the wordmark, gap 8. */
export function BrandLockup({ className, ...props }: BrandLockupProps) {
  return (
    <span className={cn("inline-flex items-center gap-8", className)} {...props}>
      <BrandMark size={18} />
      <span className="text-body-strong text-text-primary">{BRAND_NAME}</span>
    </span>
  );
}
