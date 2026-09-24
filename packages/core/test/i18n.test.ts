// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { beforeAll, describe, expect, test } from "bun:test";
import { ERROR_CODES } from "../src/constants";
import {
  allMessages,
  errorCopy,
  formatBytes,
  formatCost,
  formatCostWithCount,
  formatDate,
  formatMoney,
  formatPrice,
  hasMessage,
  parseMessage,
  setFormatLocale,
  t,
  tParts,
} from "../src/i18n";

beforeAll(() => setFormatLocale("en-US"));

describe("t()", () => {
  test("fills in named values", () => {
    expect(t("firstRun.connected", { company: "Google" })).toBe("Connected to Google.");
    expect(t("composer.generate.forModel", { model: "GPT Image 2.5 Flare" })).toBe(
      "To use GPT Image 2.5 Flare",
    );
  });

  test("picks plural forms, exact matches first", () => {
    expect(t("feed.tile.images", { count: 1 })).toBe("1 image");
    expect(t("feed.tile.images", { count: 4 })).toBe("4 images");
    expect(t("settings.apiKeys.works", { count: 0 })).toBe("This key works.");
    expect(t("settings.apiKeys.works", { count: 1 })).toBe("This key works. 1 model is ready.");
    expect(t("settings.apiKeys.works", { count: 3 })).toBe("This key works. 3 models are ready.");
  });

  test("restart lines name the company and count images", () => {
    expect(t("settings.spending.reruns", { count: 1 })).toBe(
      "Ran 1 image again after a restart. You may be charged twice.",
    );
    expect(t("settings.spending.reruns", { count: 3 })).toBe(
      "Ran 3 images again after a restart. You may be charged twice.",
    );
    expect(t("errors.resumeGone", { company: "OpenAI" })).toBe("OpenAI no longer has this image.");
  });

  test("handles ordinals", () => {
    expect(t("feed.tile.queuedPosition", { position: 1 })).toBe("Queued · 1st in line");
    expect(t("feed.tile.queuedPosition", { position: 2 })).toBe("Queued · 2nd in line");
    expect(t("feed.tile.queuedPosition", { position: 3 })).toBe("Queued · 3rd in line");
    expect(t("feed.tile.queuedPosition", { position: 11 })).toBe("Queued · 11th in line");
  });

  test("shows gaps instead of hiding them", () => {
    expect(t("firstRun.connected")).toBe("Connected to {company}.");
    // @ts-expect-error: unknown keys don't compile.
    expect(t("no.such.key")).toBe("no.such.key");
    expect(hasMessage("actions.tryAgain")).toBe(true);
    expect(hasMessage("actions")).toBe(false);
  });

  test("keeps rich values in place", () => {
    const link = { tag: "a" };
    expect(tParts("firstRun.body", { first: link, second: "Google" })).toEqual([
      "Add a key from ",
      link,
      " or Google. It takes a minute.",
    ]);
  });
});

describe("message syntax", () => {
  test("parses select and nested plurals", () => {
    expect(() =>
      parseMessage("{kind, select, a {A {n, plural, one {# x} other {# xs}}} other {O}}"),
    ).not.toThrow();
  });

  test("quotes braces and keeps ordinary apostrophes", () => {
    expect(parseMessage("Can't '{'literal'}' ok")).toEqual([{ kind: "text", text: "Can't {literal} ok" }]);
    expect(parseMessage("It''s")).toEqual([{ kind: "text", text: "It's" }]);
  });

  test("rejects broken messages", () => {
    expect(() => parseMessage("{n, plural, one {x}}")).toThrow(SyntaxError);
    expect(() => parseMessage("stray }")).toThrow(SyntaxError);
    expect(() => parseMessage("{n, number}")).toThrow(SyntaxError);
  });
});

describe("catalogue", () => {
  const entries = [...allMessages()];

  test("every message parses", () => {
    for (const [key, message] of entries) {
      expect(() => parseMessage(message), key).not.toThrow();
    }
  });

  test("every error code has a reason and a button", () => {
    for (const code of ERROR_CODES) {
      const copy = errorCopy(code);
      expect(copy.reason).not.toContain("errors.");
      expect(copy.action).not.toContain("errors.");
      expect(copy.reason.length).toBeGreaterThan(0);
    }
    expect(errorCopy("network")).toEqual({ reason: "Couldn't connect.", action: "Try again" });
    expect(errorCopy("canceled").reason).toBe(
      "Canceled. You may still be charged for work that already started.",
    );
  });

  test("has no em dashes", () => {
    for (const [key, message] of entries) expect(message.includes("—"), key).toBe(false);
  });

  test("says Try again, never Retry", () => {
    for (const [key, message] of entries) expect(/\bretr(y|ying|ies|ied)\b/i.test(message), key).toBe(false);
  });

  test("keeps internal words out of the UI", () => {
    const banned =
      /\b(adapters?|manifests?|capabilit(y|ies)|job sets?|model ?keys?|endpoints?|params|parameters|credentials?|providers?|payloads?|idempotency|fingerprints?|normali[sz]e)\b/i;
    for (const [key, message] of entries) expect(banned.test(message), `${key}: ${message}`).toBe(false);
  });

  test("has no filler or roadmap talk", () => {
    const filler = /\b(simply|just|coming soon|v1\.1)\b/i;
    for (const [key, message] of entries) expect(filler.test(message), `${key}: ${message}`).toBe(false);
  });
});

describe("cost wording", () => {
  const usd = (min: number, max: number, confidence: "exact" | "estimated" | "unknown" = "estimated") => ({
    currency: "USD",
    min,
    max,
    confidence,
  });

  test("reads like §0.15", () => {
    expect(formatCost(usd(0.134, 0.134))).toBe("About $0.13");
    expect(formatCost(usd(0.12, 0.19))).toBe("About $0.12–0.19");
    expect(formatCost(usd(0.16, 0.16), { tight: true })).toBe("~$0.16");
    expect(formatCost(usd(0, 0, "unknown"))).toBe("Cost unknown");
    expect(formatCost(usd(0, 0, "exact"))).toBe("Free");
    expect(formatCostWithCount(usd(0.27, 0.27), 2)).toBe("About $0.27 · 2 images");
    expect(formatMoney(0.134, "USD", true)).toBe("$0.134");
  });

  test("prices under a dime keep two significant digits, so half price reads as half", () => {
    expect(formatCost(usd(0.0336, 0.0336))).toBe("About $0.034");
    expect(formatCost(usd(0.0168, 0.0168))).toBe("About $0.017");
    expect(formatCost(usd(0.067, 0.067), { tight: true })).toBe("~$0.067");
    expect(formatCost(usd(0.0168, 0.12))).toBe("About $0.017–0.12");
    expect(formatPrice(0.24192)).toBe("$0.24");
  });

  test("never uses the words we avoid", () => {
    for (const text of [formatCost(usd(0.1, 0.3)), formatCost(usd(0.1, 0.1), { tight: true })]) {
      expect(text).not.toMatch(/est\.|≈|estimate/i);
    }
  });

  test("dollars read as $ in every English locale, never US$", () => {
    setFormatLocale("en-GB");
    try {
      expect(formatMoney(0.13)).toBe("$0.13");
      expect(formatCost(usd(0.13, 0.13), { tight: true })).toBe("~$0.13");
    } finally {
      setFormatLocale("en-US");
    }
  });

  test("dates follow the locale, never ISO", () => {
    expect(formatDate("2026-09-23T12:00:00Z")).toBe("Sep 23, 2026");
    setFormatLocale("en-GB");
    expect(formatDate("2026-09-23T12:00:00Z")).toMatch(/^23 Sept? 2026$/);
    setFormatLocale("en-US");
  });

  test("sizes read like the operating system", () => {
    expect(formatBytes(4_200_000_000)).toBe("4.2 GB");
    expect(formatBytes(512)).toBe("0.5 kB");
    expect(formatBytes(186_000_000_000)).toBe("186 GB");
  });
});
