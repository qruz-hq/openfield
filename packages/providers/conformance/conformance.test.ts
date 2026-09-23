import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  credentialSchemaSchema,
  jobHandleSchema,
  modelManifestSchema,
  newId,
  normalizedRequestSchema,
  providerMetaSchema,
} from "@openfield/core";
import { estimate } from "../src/manifest/estimate";
import { normalize } from "../src/normalize";
import { createModelRegistry } from "../src/registry";
import { ProviderError } from "../src/types";
import {
  addImage,
  findBase64,
  generate,
  harness,
  type Kit,
  kits,
  request,
  withoutImageBytes,
} from "./harness";

// The §6.12 conformance suite, offline: every built-in adapter against its own fake API and
// fixtures. Numbers in test names are the PRD's. OPENFIELD_CONFORMANCE=live runs live.test.ts.

// Adapters must only ever use ctx.fetch. If one reaches for the global, every test here fails.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = Object.assign(
    () => {
      throw new Error("An adapter called the global fetch instead of ctx.fetch");
    },
    { preconnect: () => {} },
  ) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const expectError = async (promise: Promise<unknown>): Promise<ProviderError> => {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
};

describe.each(kits.map((kit) => [kit.provider.meta.id, kit] as const))("%s", (_id, kit: Kit) => {
  const catalog = kit.provider.catalog();

  test("1. meta, credentials and every manifest parse strictly", () => {
    expect(() => providerMetaSchema.parse(kit.provider.meta)).not.toThrow();
    expect(() => credentialSchemaSchema.parse(kit.provider.credentials)).not.toThrow();
    expect(catalog.length).toBeGreaterThan(0);
    for (const manifest of catalog) {
      const parsed = modelManifestSchema.safeParse(manifest);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(manifest.providerId).toBe(kit.provider.meta.id);
      expect(manifest.source).toBe("static");
      expect(kit.provider.recognise(manifest.modelId)).toBe(true);
    }
  });

  test("3. defaults are members of their own option lists", () => {
    for (const { capabilities: caps } of catalog) {
      if (caps.size.mode === "aspect") expect(caps.size.ratios).toContain(caps.size.default);
      if (caps.resolution) expect(caps.resolution.tiers).toContain(caps.resolution.default);
      if (caps.quality) expect(caps.quality.levels.map((l) => l.id)).toContain(caps.quality.default);
      expect(caps.output.formats).toContain(caps.output.default);
      // An off-by-one here would ship a control that sends the wrong tier (§6.12 rule 3).
      if (caps.quality)
        expect(new Set(caps.quality.levels.map((l) => l.id)).size).toBe(caps.quality.levels.length);
    }
  });

  test("2. every declared ratio, tier and quality maps to a payload the API accepts", async () => {
    for (const manifest of catalog) {
      const caps = manifest.capabilities;
      const ratios = caps.size.mode === "aspect" ? caps.size.ratios : [undefined];
      const tiers = caps.resolution?.tiers ?? [undefined];
      const qualities = caps.quality?.levels.map((l) => l.id) ?? [undefined];
      for (const ratio of ratios) {
        for (const resolution of tiers) {
          for (const quality of qualities) {
            const h = harness(kit);
            const req = request(manifest, {
              ...(ratio && { size: ratio === "auto" ? { kind: "auto" } : { kind: "aspect", ratio } }),
              ...(resolution && { resolution }),
              ...(quality && { quality }),
            });
            const { normalized } = await generate(kit, manifest, req, h);
            expect(normalized.diagnostics).toEqual([]);
            expect(h.ctx.assets.written).toHaveLength(1);
          }
        }
      }
    }
  });

  test("4. estimate() is pure: no network, no clock, same answer twice, in USD", () => {
    const realNow = Date.now;
    Date.now = () => {
      throw new Error("estimate() read the clock");
    };
    try {
      for (const manifest of catalog) {
        const tiers = manifest.capabilities.resolution?.tiers ?? [undefined];
        for (const resolution of tiers) {
          const req = { batch: 3, ...(resolution && { resolution }) };
          const first = estimate(manifest, req);
          expect(estimate(manifest, req)).toEqual(first);
          expect(first.currency).toBe("USD");
          expect(first.min).toBeLessThanOrEqual(first.max);
          if (manifest.price.kind === "per_image") {
            const row = manifest.price.tiers.find((p) => p.tier === resolution);
            if (row) expect(first.min).toBeCloseTo(row.usd * 3, 6);
            expect(first.pricedAt).toBe(manifest.price.pricedAt);
          }
          if (manifest.price.kind !== "unknown") expect(manifest.price.sourceUrl).toMatch(/^https:\/\//);
        }
      }
    } finally {
      Date.now = realNow;
    }
  });

  test("5, 6. handles survive JSON and a restart; poll is idempotent after the end", async () => {
    const manifest = catalog[0]!;
    const h = harness(kit);
    const { handles } = await generate(kit, manifest, request(manifest), h);
    const stored = JSON.parse(JSON.stringify(handles[0]));
    expect(() => jobHandleSchema.parse(stored)).not.toThrow();

    // A fresh binding and a fresh context stand in for a restarted server.
    const restarted = kit.provider.model(manifest.key);
    const ctx = harness(kit).ctx;
    const first = await restarted.poll(stored, ctx);
    const second = await restarted.poll(stored, ctx);
    expect(first.state).toBe("succeeded");
    expect(second).toEqual(first);
  });

  test("7. batch: fan-out gives exactly n distinct images; native returns n", async () => {
    for (const manifest of catalog) {
      const n = Math.min(3, manifest.capabilities.batch.max);
      const h = harness(kit);
      const { normalized, handles, model } = await generate(
        kit,
        manifest,
        request(manifest, { batch: n }),
        h,
      );
      expect(normalized.jobIds).toHaveLength(n);
      expect(normalized.calls).toHaveLength(manifest.capabilities.batch.native ? 1 : n);
      const images = [];
      for (const handle of handles) images.push(...((await model.poll(handle, h.ctx)).result?.images ?? []));
      expect(images).toHaveLength(n);
      expect(new Set(images.map((i) => i.assetId)).size).toBe(n);
      expect(new Set(h.ctx.assets.written.map((a) => a.sha256)).size).toBe(n);
      expect(images.map((i) => i.index).sort()).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  test("8. seeds: sent only when supported, echoed when declared", async () => {
    for (const manifest of catalog) {
      const caps = manifest.capabilities;
      const h = harness(kit);
      const { normalized, handles, model } = await generate(
        kit,
        manifest,
        request(manifest, { seed: 42 }),
        h,
      );
      if (!caps.seed.supported) {
        expect(normalized.calls.every((c) => c.seed === undefined)).toBe(true);
        expect(normalized.diagnostics.map((d) => d.field)).toContain("seed");
        expect(caps.unsupported?.seed?.reason).toBeTruthy();
        continue;
      }
      if (caps.seed.echoed) {
        const result = (await model.poll(handles[0]!, h.ctx)).result;
        expect(result?.images[0]?.seed).toBe(42);
      }
    }
  });

  test("9. cancel: aborting mid-call ends as canceled within 2 s and writes nothing", async () => {
    const manifest = catalog[0]!;
    const controller = new AbortController();
    const h = harness(kit, { delayMs: 5000, signal: controller.signal });
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    const err = await expectError(generate(kit, manifest, request(manifest), h));
    expect(err.code).toBe("canceled");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(h.ctx.assets.written).toHaveLength(0);
  });

  test("10. a rejected key maps to auth_invalid", async () => {
    const manifest = catalog[0]!;
    const err = await expectError(
      generate(kit, manifest, request(manifest), harness(kit, { scenario: "bad_key" })),
    );
    expect(err.code).toBe("auth_invalid");
    expect(err.retryable).toBe(false);
    expect(err.userMessage.length).toBeGreaterThan(0);
  });

  test("11. 429 maps to rate_limited with the provider's retry delay", async () => {
    const manifest = catalog[0]!;
    const h = harness(kit, { scenario: "rate_limited" });
    const err = await expectError(generate(kit, manifest, request(manifest), h));
    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(12_000);
  });

  test("12. 500 and 503 map to provider_unavailable, retryable", async () => {
    const manifest = catalog[0]!;
    for (const scenario of ["server_error", "unavailable"] as const) {
      const err = await expectError(generate(kit, manifest, request(manifest), harness(kit, { scenario })));
      expect(err.code).toBe("provider_unavailable");
      expect(err.retryable).toBe(true);
    }
  });

  test("13. refusals map to content_refused and are never retried", async () => {
    const manifest = catalog[0]!;
    for (const scenario of ["refused", "blocked", "no_image"] as const) {
      if (!kit.fake.fixtures[scenario]) continue;
      const h = harness(kit, { scenario });
      const err = await expectError(generate(kit, manifest, request(manifest), h));
      expect(err.code).toBe("content_refused");
      expect(err.retryable).toBe(false);
      expect(h.ctx.assets.written).toHaveLength(0);
    }
  });

  test("14. a timed-out fetch surfaces timeout, not unknown", async () => {
    const manifest = catalog[0]!;
    const h = harness(kit, { delayMs: 5000, signal: AbortSignal.timeout(10) });
    const err = await expectError(generate(kit, manifest, request(manifest), h));
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
  });

  test("15. an unsupported setting follows unsupportedParamPolicy", async () => {
    for (const manifest of catalog) {
      const h = harness(kit);
      const req = request(manifest, { quality: "not-a-real-quality", background: "transparent" });
      const normalized = await normalize(manifest, req, { jobSetId: newId() });
      const flagged = normalized.diagnostics.filter((d) => d.code === "unsupported_param");
      if (manifest.capabilities.unsupportedParamPolicy === "reject") {
        expect(normalized.error?.code).toBe("unsupported_param");
        expect(h.sent).toHaveLength(0);
      } else {
        expect(normalized.error).toBeUndefined();
        expect(flagged.length).toBeGreaterThan(0);
        expect(flagged.every((d) => d.level === "warning")).toBe(true);
        expect(normalized.request.quality).not.toBe("not-a-real-quality");
      }
    }
  });

  test("16. results carry asset ids and sizes; no base64 crosses the interface", async () => {
    const manifest = catalog[0]!;
    const h = harness(kit);
    const { handles, model } = await generate(kit, manifest, request(manifest), h);
    const update = await model.poll(handles[0]!, h.ctx);
    for (const image of update.result?.images ?? []) {
      expect(image.assetId).toBeTruthy();
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
      expect(image.mimeType).toMatch(/^image\//);
      expect(image.bytes).toBeGreaterThan(0);
    }
    expect(findBase64(handles)).toBeUndefined();
    expect(findBase64(update)).toBeUndefined();
    expect(findBase64(h.ctx.log.lines)).toBeUndefined();
  });

  test("17. no key in logs, errors, handles, stored payloads or URLs", async () => {
    const manifest = catalog[0]!;
    const seen: unknown[] = [];
    const scenarios = ["success", ...Object.keys(kit.fake.fixtures)] as const;
    for (const scenario of scenarios) {
      const h = harness(kit, { scenario: scenario as never });
      try {
        const { handles, model } = await generate(kit, manifest, request(manifest), h);
        seen.push(handles, await model.poll(handles[0]!, h.ctx));
      } catch (err) {
        seen.push(
          err instanceof ProviderError ? { ...err.toJSON(), message: err.message, stack: err.stack } : err,
        );
      }
      seen.push(
        h.ctx.log.lines,
        h.sent.map((s) => s.url),
      );
    }
    const text = JSON.stringify(seen);
    for (const secret of kit.secrets) expect(text).not.toContain(secret);
  });

  test("18. discovery: a bad key raises auth_invalid and the catalog survives; strangers are listed, not added", async () => {
    const bad = harness(kit, { scenario: "bad_key" });
    const err = await expectError(kit.provider.listModels(bad.ctx));
    expect(err.code).toBe("auth_invalid");

    const registry = createModelRegistry({
      providers: [kit.provider],
      hasCredentials: () => true,
      context: () => bad.ctx,
    });
    const [failed] = await registry.refresh(kit.provider.meta.id);
    expect(failed?.error?.code).toBe("auth_invalid");
    expect(registry.models().map((m) => m.key)).toEqual(catalog.map((m) => m.key));

    if (!kit.provider.discoverIds) return;
    const good = harness(kit);
    const ok = createModelRegistry({
      providers: [kit.provider],
      hasCredentials: () => true,
      context: () => good.ctx,
    });
    const [report] = await ok.refresh();
    const listed = new Set(ok.models().map((m) => m.modelId));
    for (const { modelId } of report?.unrecognised ?? []) {
      expect(kit.provider.recognise(modelId)).toBe(false);
      expect(listed.has(modelId)).toBe(false);
    }
    for (const manifest of catalog) expect(listed.has(manifest.modelId)).toBe(true);
  });

  test("19. only declared hosts are contacted; an image from anywhere else is refused", async () => {
    const allowed = new Set([...kit.provider.meta.networkHosts, ...kit.provider.meta.assetHosts]);
    const manifest = catalog[0]!;
    const h = harness(kit);
    await generate(kit, manifest, request(manifest), h);
    await kit.provider.verifyCredentials(h.ctx);
    for (const call of h.fetch.calls) expect(allowed.has(call.host)).toBe(true);

    if (kit.fake.fixtures.foreign_asset) {
      const blocked = harness(kit, { scenario: "foreign_asset" });
      const err = await expectError(generate(kit, manifest, request(manifest), blocked));
      expect(err.code).toBe("provider_error");
      expect(blocked.ctx.assets.written).toHaveLength(0);
    }
  });

  test("20. golden payloads: t2i 3:4 at 1K ×2, edit with 2 references, inpaint with a mask", async () => {
    for (const manifest of catalog) {
      const caps = manifest.capabilities;
      const golden: Record<string, unknown> = {};

      const t2i = harness(kit);
      const ratio = caps.size.mode === "aspect" && caps.size.ratios.includes("3:4") ? "3:4" : undefined;
      await generate(
        kit,
        manifest,
        request(manifest, {
          ...(ratio && { size: { kind: "aspect", ratio } }),
          ...(caps.resolution?.tiers.includes("1K") && { resolution: "1K" }),
          batch: 2,
        }),
        t2i,
      );
      golden.t2i = t2i.sent.map((s) => ({ url: s.url, body: s.body }));

      const edit = harness(kit);
      const base = await addImage(edit);
      const refs = [await addImage(edit, 16, 16), await addImage(edit, 32, 16)];
      if (caps.ops.imageEdit) {
        await generate(
          kit,
          manifest,
          request(manifest, {
            op: "edit",
            prompt: "Make the sky stormy",
            base: { assetId: base, role: "base" },
            references: refs.map((assetId) => ({ assetId, role: "style" as const })),
          }),
          edit,
        );
        golden.edit = edit.sent.map((s) => ({ url: s.url, body: withoutImageBytes(s.body) }));
      }

      const inpaintReq = request(manifest, {
        op: "inpaint",
        prompt: "Add a red door",
        base: { assetId: newId(), role: "base" },
        mask: { assetId: newId() },
      });
      const inpaint = await normalize(manifest, inpaintReq, { jobSetId: newId() });
      golden.inpaint = caps.ops.inpaint ? { op: inpaint.request.op } : { error: inpaint.error?.code };

      expect(golden).toMatchSnapshot(manifest.key);
    }
  });

  test("21. mask polarity: alpha 0 means edit, converted for the provider", () => {
    for (const manifest of catalog) {
      // Only adapters that take a mask have something to convert. The fixture pair test lives
      // with an adapter that declares ops.inpaint.
      if (!manifest.capabilities.ops.inpaint) expect(manifest.capabilities.ops.inpaint).toBe(false);
    }
  });

  test("normalized requests match the core schema", async () => {
    for (const manifest of catalog) {
      const normalized = await normalize(manifest, request(manifest, { batch: 2 }), { jobSetId: newId() });
      expect(() => normalizedRequestSchema.parse(normalized.request)).not.toThrow();
      for (const call of normalized.calls) expect(() => normalizedRequestSchema.parse(call)).not.toThrow();
    }
  });
});
