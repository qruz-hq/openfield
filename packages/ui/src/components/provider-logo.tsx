import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";

// Each company's own mark, copied from the logo components in the design file.
// Brand colors live here and nowhere else; the one-color glyphs follow the text color.
// Higgsfield's mark only ever names that company's key card and models (§1.11).

export const PROVIDER_LOGOS = ["openai", "google", "higgsfield", "fal", "replicate"] as const;
export type ProviderLogoId = (typeof PROVIDER_LOGOS)[number];

const OPENAI =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

const HIGGSFIELD =
  "M18.3498 9.83713l-0.0159-0.17954c-0.1508-1.72312-1.2376-4.96498-4.2523-4.96498-2.2371 0-3.9271 2.27836-5.41849 4.28706-1.19009 1.60863-2.22121 2.98863-3.35581 2.98863-0.30156-0.0326-0.69022-0.1878-0.9281-0.5389-0.21423-0.3186-0.26972-0.7268-0.15874-1.2168 0.17443-0.77576 1.17417-1.4944 2.22917-2.26197 0.57901-0.40825 1.17417-0.84108 1.58671-1.25752 1.19009-1.18401 1.79298-2.04147 1.79298-3.42141 0-1.37994-0.73775-2.06605-1.35656-2.36006-1.23762-0.58779-3.05425-0.24486-4.2125 0.78419-0.17443 0.16339-0.34909 0.31835-0.50783 0.46536-1.16621 1.06978-1.95149 1.79662-3.75243 1.24113v2.2374c2.38791 1.08616 4.39512-0.98808 5.15675-1.94339 0.58697-0.62875 1.20578-0.99627 1.66608-0.99627h0.02388c0.20627 0.00819 0.3807 0.08989 0.50783 0.2369 0.20627 0.24508 0.28564 0.5309 0.24584 0.84926-0.08733 0.66972-0.76163 1.45345-1.99925 2.31091-1.45185 1.00446-3.87933 2.68661-4.06991 4.80157-0.14282 1.519 0.61881 3.0378 1.8089 3.6256 2.77657 1.3555 4.46653-0.9799 6.25928-3.446 1.3725-1.9027 2.6736-3.70727 4.4824-3.70727 1.6263 0 2.2292 1.38813 2.2292 2.26198v0.17158l-0.1587 0.03254c-3.9428 0.71867-6.0928 4.52397-6.0928 6.27957 0 1.7557 1.4439 3.2583 3.2209 3.2583 2.0786 0 4.6489-1.8292 5.0615-6.9737l0.0159-0.1877h1.6422v-2.37623h-1.6502v-0.00024z m-2.15 2.63747c-0.3172 3.0785-1.8485 4.5158-2.7766 4.5158-0.4205 0-1.0074-0.3594-1.0074-1.0289 0-0.7511 1.0868-3.0295 3.5302-3.7072l0.2856-0.0735-0.0318 0.294v-0.0002z";

const FAL =
  "M30.1574 0.740479C30.9676 0.740479 31.6169 1.39923 31.6944 2.20567C32.3853 9.39891 38.1102 15.1234 45.3039 15.8142C46.1104 15.8917 46.7692 16.541 46.7692 17.3511V30.8959C46.7692 31.706 46.1104 32.3553 45.3039 32.4328C38.1102 33.1236 32.3853 38.8481 31.6944 46.0414C31.6169 46.8478 30.9676 47.5065 30.1574 47.5065H16.6118C15.8016 47.5065 15.1523 46.8478 15.0748 46.0414C14.384 38.8481 8.65901 33.1236 1.46528 32.4328C0.658799 32.3553 0 31.706 0 30.8959V17.3511C0 16.541 0.658803 15.8917 1.46529 15.8142C8.65902 15.1234 14.384 9.39891 15.0748 2.20567C15.1523 1.39923 15.8016 0.740479 16.6118 0.740479H30.1574ZM9.39037 24.0839C9.39037 31.865 15.6915 38.1728 23.4644 38.1728C31.2373 38.1728 37.5385 31.865 37.5385 24.0839C37.5385 16.3028 31.2373 9.99498 23.4644 9.99498C15.6915 9.99498 9.39037 16.3028 9.39037 24.0839Z";

const REPLICATE =
  "M24 10.262v2.712h-9.518V24h-3.034V10.262zm0-5.131v2.717H8.755V24H5.722V5.131zM24 0v2.717H3.034V24H0V0z";

function GoogleG() {
  return (
    <>
      <path
        fill="#E33629"
        d="M44.59 4.21a64 64 0 0142.61.37 61.22 61.22 0 0120.35 12.62c-2 2.14-4.11 4.14-6.15 6.22Q95.58 29.23 89.77 35a34.28 34.28 0 00-13.64-8 37.17 37.17 0 00-37.46 9.74 39.25 39.25 0 00-9.18 14.91L8.76 35.6A63.53 63.53 0 0144.59 4.21z"
      />
      <path
        fill="#F8BD00"
        d="M3.26 51.5a62.93 62.93 0 015.5-15.9l20.73 16.09a38.31 38.31 0 000 24.63q-10.36 8-20.73 16.08a63.33 63.33 0 01-5.5-40.9z"
      />
      <path
        fill="#587DBD"
        d="M65.27 52.15h59.52a74.33 74.33 0 01-1.61 33.58 57.44 57.44 0 01-16 26.26c-6.69-5.22-13.41-10.4-20.1-15.62a29.72 29.72 0 0012.66-19.54H65.27c-.01-8.22 0-16.45 0-24.68z"
      />
      <path
        fill="#319F43"
        d="M8.75 92.4q10.37-8 20.73-16.08A39.3 39.3 0 0044 95.74a37.16 37.16 0 0014.08 6.08 41.29 41.29 0 0015.1 0 36.16 36.16 0 0013.93-5.5c6.69 5.22 13.41 10.4 20.1 15.62a57.13 57.13 0 01-25.9 13.47 67.6 67.6 0 01-32.36-.35 63 63 0 01-23-11.59A63.73 63.73 0 018.75 92.4z"
      />
    </>
  );
}

interface LogoArt {
  viewBox: string;
  /** Mark only. `fill` is the tile color; glyphs use currentColor unless the mark is multicolor. */
  art: (fill: string) => ReactNode;
  tile: { background: string; mark: string; inset: number };
}

const LOGOS: Record<ProviderLogoId, LogoArt> = {
  openai: {
    viewBox: "0 0 24 24",
    art: (fill) => <path fill={fill} d={OPENAI} />,
    tile: { background: "#000000", mark: "#FFFFFF", inset: 7 },
  },
  google: {
    viewBox: "0 0 128 128",
    art: () => <GoogleG />,
    tile: { background: "#FFFFFF", mark: "", inset: 7 },
  },
  higgsfield: {
    viewBox: "0 0 20 20",
    art: (fill) => <path fill={fill} d={HIGGSFIELD} />,
    tile: { background: "#D1FE17", mark: "#000000", inset: 7 },
  },
  fal: {
    viewBox: "0 0.74 46.77 46.77",
    art: (fill) => <path fill={fill} fillRule="evenodd" d={FAL} />,
    tile: { background: "#000000", mark: "#FFFFFF", inset: 8 },
  },
  replicate: {
    viewBox: "0 0 24 24",
    art: (fill) => <path fill={fill} d={REPLICATE} />,
    tile: { background: "#000000", mark: "#FFFFFF", inset: 9 },
  },
};

export interface ProviderLogoProps extends Omit<ComponentProps<"span">, "children"> {
  provider: ProviderLogoId;
  /** `glyph` is 16px for chips and captions. `tile` is the 32px square for lists and Settings. */
  variant?: "glyph" | "tile";
  /** Accessible name, such as the company name. Leave it out when the name is already visible. */
  title?: string;
}

export function ProviderLogo({ provider, variant = "glyph", title, className, ...props }: ProviderLogoProps) {
  const logo = LOGOS[provider];
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true };

  if (variant === "tile") {
    const size = 32 - logo.tile.inset * 2;
    return (
      <span
        {...a11y}
        className={cn(
          "relative inline-flex size-32 shrink-0 items-center justify-center overflow-hidden rounded-8 inset-ring inset-ring-border",
          className,
        )}
        style={{ backgroundColor: logo.tile.background }}
        {...props}
      >
        <svg viewBox={logo.viewBox} width={size} height={size} aria-hidden>
          {logo.art(logo.tile.mark)}
        </svg>
      </span>
    );
  }

  return (
    <span {...a11y} className={cn("inline-flex size-16 shrink-0 text-text-primary", className)} {...props}>
      <svg viewBox={logo.viewBox} width={16} height={16} aria-hidden>
        {logo.art("currentColor")}
      </svg>
    </span>
  );
}
