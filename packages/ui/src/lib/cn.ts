import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the theme in styles.css, or it reads `text-body` as a color
// and drops it next to `text-text-primary`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "display",
        "sheet-title",
        "page-title",
        "group-title",
        "button-l",
        "body-strong",
        "body-medium",
        "body",
        "small",
        "caption",
        "micro",
      ],
      radius: ["2", "4", "5", "6", "7", "8", "10", "12", "14", "16", "20", "24", "26", "30"],
      shadow: ["popover", "check"],
      blur: ["chip", "panel"],
    },
    classGroups: {
      "font-size": [{ text: ["caps", "mono-11", "mono-12", "mono-13"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
