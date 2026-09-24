import type { Theme } from "@openfield/core";
import { useEffect } from "react";
import { useSettings } from "../api/hooks/settings";
import { writeLocal } from "./storage";

// The Appearance setting lands on <html data-theme>. The tokens in @openfield/ui do the rest:
// "system" follows the OS, dark when it has no preference (§2.2).

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  // index.html reads this before first paint.
  writeLocal("openfield.theme", theme);
}

export function useThemeSync() {
  const theme = useSettings().data?.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
}

/** The theme on screen right now: the setting, or the OS's when it's "system" (dark without one). */
export function resolvedTheme(): "light" | "dark" {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
