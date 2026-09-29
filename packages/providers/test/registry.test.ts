import { describe, expect, test } from "bun:test";
import type { ModelManifest } from "@openfield/core";
import { createGoogleProvider } from "../src/google";
import { GOOGLE_MODELS } from "../src/google/models";
import { builtinProviders, createModelRegistry } from "../src/registry";
import { createTestContext } from "../src/testing/context";
import { createFakeFetch } from "../src/testing/fake-fetch";

// The key sees Nano Banana Pro only as a preview, so discovery has something to add.
const context = () =>
  createTestContext({
    fetch: createFakeFetch({ delayMs: 0, hiddenModels: ["gemini-3-pro-image"] }),
    credentials: { apiKey: "registry-test-key" },
  });

/** Every built-in company's static catalog, in registration order. */
const catalogKeys = () => builtinProviders.flatMap((p) => p.catalog().map((m) => m.key));

describe("registry", () => {
  test("boots from static catalogs with no key and no network", () => {
    const registry = createModelRegistry({ hasCredentials: () => false, context: () => null });
    expect(registry.models().map((m) => m.key)).toEqual(catalogKeys());
    expect(registry.models({ ready: true })).toEqual([]);
    expect(registry.providers().map((p) => p.meta.id)).toEqual(builtinProviders.map((p) => p.meta.id));
  });

  test("builtinProviders ships Google, OpenAI, Higgsfield, then BytePlus", () => {
    expect(builtinProviders.map((p) => p.meta.id)).toEqual(["google", "openai", "higgsfield", "byteplus"]);
  });

  test("refresh adds recognised models and lists the rest as not supported", async () => {
    const registry = createModelRegistry({ hasCredentials: () => true, context });
    const [report] = await registry.refresh("google");
    expect(report?.added).toEqual(["google:gemini-3-pro-image-preview"]);
    expect(report?.unrecognised.map((u) => u.modelId)).toEqual([
      "gemini-3.8-flash",
      "gemini-2.5-flash-image",
      "gemini-embedding-001",
    ]);
    expect(registry.models().map((m) => m.modelId)).toContain("gemini-3-pro-image-preview");
    expect(registry.get("google:gemini-3-pro-image-preview").source).toBe("discovered");
    // Manifests are data: no behaviour, the batch path included, leaks into the list.
    const preview = registry.models().find((m) => m.modelId === "gemini-3-pro-image-preview");
    expect(preview && "batch" in preview).toBe(false);
    expect(preview?.speeds?.map((o) => o.id)).toEqual(["batch", "flex", "priority"]);
    expect(typeof registry.get("google:gemini-3-pro-image-preview").batch?.submit).toBe("function");

    const [again] = await registry.refresh();
    expect([again?.added, again?.removed, again?.updated]).toEqual([[], [], []]);
  });

  test("a preview of a model the key also lists isn't added", async () => {
    const both = () =>
      createTestContext({
        fetch: createFakeFetch({ delayMs: 0 }),
        credentials: { apiKey: "registry-test-key" },
      });
    const registry = createModelRegistry({ hasCredentials: () => true, context: both });
    const [report] = await registry.refresh("google");
    expect(report?.added).toEqual([]);
    expect(registry.models().map((m) => m.key)).toEqual(catalogKeys());
  });

  test("with no key, refresh does nothing and says so quietly", async () => {
    const registry = createModelRegistry({ hasCredentials: () => false, context: () => null });
    const [report] = await registry.refresh("google");
    expect(report).toMatchObject({ providerId: "google", added: [], unrecognised: [] });
    expect(report?.error).toBeUndefined();
  });

  test("the person's own list is merged last and binds to its adapter", () => {
    const custom: ModelManifest = {
      ...structuredClone(GOOGLE_MODELS[0]!),
      key: "google:gemini-3-pro-image",
      displayName: "My Pro",
      source: "user",
    };
    const stranger: ModelManifest = { ...custom, key: "acme:thing", providerId: "acme", modelId: "thing" };
    const registry = createModelRegistry({
      hasCredentials: () => true,
      context: () => null,
      overlay: [custom, stranger],
    });
    expect(registry.models().find((m) => m.key === custom.key)?.displayName).toBe("My Pro");
    expect(registry.models().some((m) => m.key === "acme:thing")).toBe(false);
    expect(registry.get(custom.key).displayName).toBe("My Pro");

    registry.setOverlay([]);
    expect(registry.get(custom.key).displayName).toBe("Nano Banana Pro");
  });

  test("get refuses keys nobody serves", () => {
    const registry = createModelRegistry({
      providers: [createGoogleProvider()],
      hasCredentials: () => true,
      context,
    });
    expect(() => registry.get("google:gemini-3.8-flash")).toThrow("Unknown model");
    expect(() => registry.get("openai:gpt-image-2")).toThrow("Unknown model");
  });
});
