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

/**
 * Calls `onChange` whenever the colours on screen may have changed: the Appearance setting, or the
 * OS switching between light and dark. For drawings that read the theme's tokens once (canvases).
 */
export function onThemeChange(onChange: () => void): () => void {
  const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  scheme?.addEventListener("change", onChange);
  const mutations = new MutationObserver(onChange);
  mutations.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  return () => {
    scheme?.removeEventListener("change", onChange);
    mutations.disconnect();
  };
}

/**
 * Colour tokens ("--of-accent") as colours a canvas can paint with. Tokens use light-dark(), which a
 * canvas can't read, so each is resolved through `el`'s own colour.
 */
export function resolveColors<K extends string>(
  el: HTMLElement,
  tokens: Readonly<Record<K, string>>,
): Record<K, string> {
  const before = el.style.color;
  const out = {} as Record<K, string>;
  for (const key of Object.keys(tokens) as K[]) {
    el.style.color = `var(${tokens[key]})`;
    out[key] = getComputedStyle(el).color;
  }
  el.style.color = before;
  return out;
}
