// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { expect, test } from "bun:test";
import { cn } from "../src/lib/cn";

test("type roles and text colors live side by side", () => {
  expect(cn("text-body text-text-primary")).toBe("text-body text-text-primary");
  expect(cn("text-mono-12 text-text-tertiary")).toBe("text-mono-12 text-text-tertiary");
  expect(cn("text-caps text-accent")).toBe("text-caps text-accent");
});

test("later values win within a group", () => {
  expect(cn("text-body", "text-small")).toBe("text-small");
  expect(cn("text-micro", "text-caps")).toBe("text-caps");
  expect(cn("rounded-10", "rounded-12")).toBe("rounded-12");
  expect(cn("inset-ring-border", "inset-ring-danger")).toBe("inset-ring-danger");
  expect(cn("h-40 px-16", "h-32 px-12")).toBe("h-32 px-12");
});
