import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  batchHandleSchema,
  credentialSchemaSchema,
  hostAllowed,
  jobHandleSchema,
  type ModelManifest,
  modalityOf,
  modelManifestSchema,
  newId,
  normalizedRequestSchema,
  providerMetaSchema,
  providerSettingsSchemaSchema,
  settingFields,
  speedSettingField,
} from "@openfield/core";
import { estimate } from "../src/manifest/estimate";
import { resolveProviderSettings } from "../src/manifest/provider-settings";
import { offeredSpeeds, resumesAfterRestart } from "../src/manifest/speed";
import { normalize } from "../src/normalize";
import { createModelRegistry } from "../src/registry";
import { ProviderError } from "../src/types";
import {
  addImage,
  findBase64,
  finish,
  generate,
  harness,
  type Kit,
  kits,
  outputsOf,
  prepare,
  request,
  run,
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
  const isVideo = (m: ModelManifest) => modalityOf(m) === "video";

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
      if (caps.video) {
        expect(caps.video.resolutions).toContain(caps.video.defaultResolution);
        expect(caps.video.durations).toContain(caps.video.defaultDuration);
        // Every resolution and ratio the model offers has an exact size to price it by.
        for (const resolution of caps.video.resolutions)
          for (const ratio of caps.size.mode === "aspect" ? caps.size.ratios : [])
            if (ratio !== "auto")
              expect(caps.video.sizes.some((s) => s.resolution === resolution && s.aspect === ratio)).toBe(
                true,
              );
      }
    }
  });

  test("2. every declared ratio, tier and quality maps to a payload the API accepts", async () => {
    for (const manifest of catalog) {
      const caps = manifest.capabilities;
      const ratios = caps.size.mode === "aspect" ? caps.size.ratios : [undefined];
      if (caps.video) {
        // A video model: every ratio at every resolution, then each end of its duration range,
        // with sound off and on where it makes sound.
        const video = caps.video;
        for (const ratio of ratios) {
          for (const resolution of video.resolutions) {
            const h = harness(kit);
            // "auto" needs a start frame on a model that takes its shape only from one.
            const frame = ratio === "auto" && video.autoAspect === "with_start_frame";
            const start = frame ? await addImage(h, 320, 480) : undefined;
            const req = request(manifest, {
              ...(ratio && { size: ratio === "auto" ? { kind: "auto" } : { kind: "aspect", ratio } }),
              video: { resolution, ...(start && { startFrame: { assetId: start } }) },
            });
            const { normalized } = await run(kit, manifest, req, h);
            expect(normalized.diagnostics).toEqual([]);
            expect(outputsOf(h, manifest)).toHaveLength(1);
          }
        }
        const ends = [video.durations[0]!, video.durations.at(-1)!];
        for (const seconds of ends) {
          for (const audio of video.audio.supported ? [false, true] : [undefined]) {
            const h = harness(kit);
            const req = request(manifest, { video: { seconds, ...(audio !== undefined && { audio }) } });
            const { normalized } = await run(kit, manifest, req, h);
            expect(normalized.diagnostics).toEqual([]);
            expect(normalized.request.video?.seconds).toBe(seconds);
          }
        }
        continue;
      }
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
            const { normalized } = await run(kit, manifest, req, h);
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
    const later = harness(kit);
    const first = await finish(restarted, stored, later);
    const second = await restarted.poll(stored, later.ctx);
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
      for (const handle of handles) images.push(...((await finish(model, handle, h)).result?.images ?? []));
      expect(images).toHaveLength(n);
      expect(new Set(images.map((i) => i.assetId)).size).toBe(n);
      expect(new Set(outputsOf(h, manifest).map((a) => a.sha256)).size).toBe(n);
      expect(images.map((i) => i.index).sort()).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  test("8. seeds: sent only when supported, echoed when declared", async () => {
    for (const manifest of catalog) {
      const caps = manifest.capabilities;
      if (!caps.seed.supported) {
        // A seed the model can't take is dropped with a warning, or refused, as the manifest says.
        const normalized = await normalize(manifest, request(manifest, { seed: 42 }), { jobSetId: newId() });
        expect(normalized.diagnostics.map((d) => d.field)).toContain("seed");
        if (caps.unsupportedParamPolicy === "reject") expect(normalized.error?.field).toBe("seed");
        else expect(normalized.calls.every((c) => c.seed === undefined)).toBe(true);
        expect(caps.unsupported?.seed?.reason).toBeTruthy();
        continue;
      }
      const h = harness(kit);
      const { handles, model } = await generate(kit, manifest, request(manifest, { seed: 42 }), h);
      if (caps.seed.echoed) {
        const result = (await finish(model, handles[0]!, h)).result;
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
      const err = await expectError(run(kit, manifest, request(manifest), h));
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
    const update = await finish(model, handles[0]!, h);
    expect(update.result?.images.length).toBeGreaterThan(0);
    for (const image of update.result?.images ?? []) {
      expect(image.assetId).toBeTruthy();
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
      expect(image.mimeType).toMatch(isVideo(manifest) ? /^video\// : /^image\//);
      expect(image.bytes).toBeGreaterThan(0);
      if (isVideo(manifest)) expect(image.durationMs).toBeGreaterThan(0);
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
        seen.push(handles, await finish(model, handles[0]!, h));
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
    const allowed = [...kit.provider.meta.networkHosts, ...kit.provider.meta.assetHosts];
    const manifest = catalog[0]!;
    const h = harness(kit);
    const { handles, model } = await generate(kit, manifest, request(manifest), h);
    await finish(model, handles[0]!, h);
    await kit.provider.verifyCredentials(h.ctx);
    for (const call of h.fetch.calls) expect(hostAllowed(call.host, allowed)).toBe(true);

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

      if (caps.video) {
        // A video model instead: words only, a start frame, and a start and end frame.
        const sent = (h: ReturnType<typeof harness>) =>
          h.sent.map((s) => ({ url: s.url, body: withoutImageBytes(s.body) }));
        const t2v = harness(kit);
        await generate(kit, manifest, request(manifest, { size: { kind: "aspect", ratio: "16:9" } }), t2v);
        golden.t2v = sent(t2v);
        const i2v = harness(kit);
        const start = await addImage(i2v, 480, 320);
        await generate(
          kit,
          manifest,
          request(manifest, {
            prompt: "The kite climbs",
            size: { kind: "aspect", ratio: "3:4" },
            video: { seconds: caps.video.durations.at(-1)!, startFrame: { assetId: start } },
          }),
          i2v,
        );
        golden.startFrame = sent(i2v);
        if (caps.video.frames.end) {
          const both = harness(kit);
          const from = await addImage(both, 480, 320);
          const to = await addImage(both, 320, 480);
          await generate(
            kit,
            manifest,
            request(manifest, {
              size: { kind: "auto" },
              video: { startFrame: { assetId: from }, endFrame: { assetId: to } },
            }),
            both,
          );
          golden.startAndEnd = sent(both);
        }
        expect(golden).toMatchSnapshot(manifest.key);
        continue;
      }

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

  const offers = (m: ModelManifest, id: string) => m.speeds?.some((o) => o.id === id) ?? false;

  test("22. settings obey §0.3's rules, and Speed is bound to the manifests' offers", () => {
    const schema = kit.provider.settings;
    const offered = new Set(catalog.flatMap((m) => m.speeds?.map((o) => o.id) ?? []));
    if (!schema) {
      expect(offered.size).toBe(0);
      return;
    }
    expect(providerSettingsSchemaSchema.safeParse(schema).error?.issues ?? []).toEqual([]);
    // Rule 1: a key is a credential field, never a setting.
    const credentialNames = kit.provider.credentials.fields.map((f) => f.name);
    for (const field of settingFields(schema)) expect(credentialNames).not.toContain(field.id);

    const speed = speedSettingField(schema);
    if (offered.size > 0) expect(speed).toBeDefined();
    const values = speed?.options.map((o) => o.value) ?? [];
    for (const id of offered) expect(values).toContain(id);
    for (const value of values) if (value !== "standard") expect(offered.has(value as never)).toBe(true);
    // Rule 3: every default is legal for every model.
    for (const manifest of catalog) expect(resolveProviderSettings(schema, {}, manifest).notes).toEqual([]);
  });

  test("23. every speed offer is priced and sourced; Batch is async and has a batch path", () => {
    for (const manifest of catalog) {
      for (const offer of manifest.speeds ?? []) {
        expect(offer.price.kind).not.toBe("unknown");
        if (offer.price.kind !== "unknown") {
          expect(offer.price.pricedAt).toBeTruthy();
          expect(offer.price.sourceUrl).toMatch(/^https:\/\//);
        }
        expect(offer.delivery).toBe(offer.id === "batch" ? "async" : "sync");
      }
      const model = kit.provider.model(manifest.key);
      expect(typeof model.batch?.submit === "function").toBe(offers(manifest, "batch"));
      if (model.batch) {
        expect(typeof model.batch.poll).toBe("function");
        expect(typeof model.batch.cancel).toBe("function");
      }
    }
  });

  test("24. speed on the wire: golden payloads per sync speed, and cost follows the speed served", async () => {
    for (const manifest of catalog) {
      const golden: Record<string, unknown> = {};
      for (const speed of offeredSpeeds(manifest).filter((s) => s !== "batch")) {
        const h = harness(kit);
        const { handles, model } = await generate(kit, manifest, request(manifest), h, { speed });
        // What was sent, before any status reads.
        golden[speed] = h.sent.map((s) => ({ url: s.url, body: s.body }));
        const result = (await finish(model, handles[0]!, h)).result;
        expect(result?.speedUsed).toBe(speed);
      }
      expect(golden).toMatchSnapshot(`${manifest.key} speeds`);

      if (offers(manifest, "priority")) {
        const h = harness(kit, { scenario: "priority_standard" });
        const { handles, model } = await generate(kit, manifest, request(manifest), h, { speed: "priority" });
        expect((await finish(model, handles[0]!, h)).result?.speedUsed).toBe("standard");
      }
    }
  });

  test("25. Flex busy: keep trying raises busy; switch to Standard sends once more without the speed", async () => {
    for (const manifest of catalog.filter((m) => offers(m, "flex"))) {
      // The busy policy is a setting named flexBusy: "wait" or "standard" (§0.4).
      const busyField = settingFields(kit.provider.settings).find((f) => f.id === "flexBusy");
      expect(busyField?.kind === "select" && busyField.options.map((o) => o.value).sort()).toEqual([
        "standard",
        "wait",
      ]);

      const waiting = harness(kit, { scenario: "flex_busy" });
      const err = await expectError(
        generate(kit, manifest, request(manifest), waiting, { speed: "flex", flexBusy: "wait" }),
      );
      expect([err.code, err.busy, err.retryable]).toEqual(["provider_unavailable", true, true]);
      expect(waiting.ctx.assets.written).toHaveLength(0);

      const switching = harness(kit, { scenario: "flex_busy" });
      const { handles, model } = await generate(kit, manifest, request(manifest), switching, {
        speed: "flex",
        flexBusy: "standard",
      });
      expect(switching.sent).toHaveLength(2);
      expect((await model.poll(handles[0]!, switching.ctx)).result?.speedUsed).toBe("standard");
    }
  });

  test("26. batch round trip: handle survives JSON, harvest writes once, items map to jobs, cancel and expiry", async () => {
    for (const manifest of catalog.filter((m) => offers(m, "batch"))) {
      let now = Date.parse("2026-09-23T12:00:00.000Z");
      const clock = () => now;
      const stored = { speed: "batch" };

      // Success, across a restart: a fresh binding and a fresh context poll the stored handle.
      const h = harness(kit, { now: clock });
      const normalized = await prepare(kit, manifest, request(manifest, { batch: 2 }), h, stored);
      expect(normalized.request.speed).toBe("batch");
      expect(normalized.calls).toHaveLength(2);
      const handle = await kit.provider.model(manifest.key).batch!.submit(normalized.calls, h.ctx);
      const saved = batchHandleSchema.parse(JSON.parse(JSON.stringify(handle)));
      const later = harness(kit, { now: clock });
      const batch = kit.provider.model(manifest.key).batch!;
      const waiting = await batch.poll(saved, later.ctx, { harvest: normalized.jobIds });
      expect(["queued", "running"]).toContain(waiting.state);
      expect(waiting.items).toBeUndefined();
      expect(later.ctx.assets.written).toHaveLength(0);

      now += 10 * 60_000;
      const done = await batch.poll(saved, later.ctx, { harvest: normalized.jobIds });
      expect(done.state).toBe("succeeded");
      expect(done.items?.map((i) => [i.jobId, i.ok])).toEqual(normalized.jobIds.map((id) => [id, true]));
      for (const item of done.items ?? []) if (item.ok) expect(item.result.speedUsed).toBe("batch");
      expect(later.ctx.assets.written).toHaveLength(2);
      const again = await batch.poll(saved, later.ctx, { harvest: [] });
      expect([again.state, again.items]).toEqual(["succeeded", []]);
      expect(later.ctx.assets.written).toHaveLength(2);
      if (batch.find) expect((await batch.find(saved.displayName, h.ctx))?.remoteId).toBe(saved.remoteId);

      // A partial batch maps each item to its own job.
      const p = harness(kit, { now: clock, scenario: "batch_partial" });
      const partial = await prepare(kit, manifest, request(manifest, { batch: 4 }), p, stored);
      const ph = await batch.submit(partial.calls, p.ctx);
      now += 10 * 60_000;
      const mixed = await batch.poll(ph, p.ctx, { harvest: partial.jobIds });
      expect(mixed.items?.map((i) => [i.jobId, i.ok])).toEqual(
        partial.jobIds.map((id, i) => [id, i % 2 === 0]),
      );

      // Cancel, then poll: what finished first is harvested, the rest is canceled.
      const c = harness(kit, { now: clock, scenario: "batch_slow" });
      const slow = await prepare(kit, manifest, request(manifest, { batch: 4 }), c, stored);
      const ch = await batch.submit(slow.calls, c.ctx);
      now += 18_000;
      await batch.cancel(ch, c.ctx);
      now += 60_000;
      const stopped = await batch.poll(ch, c.ctx, { harvest: slow.jobIds });
      expect(stopped.state).toBe("canceled");
      const kept = stopped.items?.filter((i) => i.ok).length ?? 0;
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(4);
      for (const item of stopped.items ?? []) if (!item.ok) expect(item.error.code).toBe("canceled");
      expect(c.ctx.assets.written).toHaveLength(kept);

      // Expiry maps every unfinished image to timeout.
      const e = harness(kit, { now: clock, scenario: "batch_expired" });
      const exp = await prepare(kit, manifest, request(manifest, { batch: 2 }), e, stored);
      const eh = await batch.submit(exp.calls, e.ctx);
      now += 10 * 60_000;
      const expired = await batch.poll(eh, e.ctx, { harvest: exp.jobIds });
      expect(expired.state).toBe("expired");
      expect(expired.items?.map((i) => (i.ok ? "ok" : i.error.code))).toEqual(["timeout", "timeout"]);

      // No key anywhere in what the batch path logged or returned.
      const urls = h.sent.map((sent) => [sent.url, sent.body]);
      const text = JSON.stringify([h.ctx.log.lines, later.ctx.log.lines, saved, done, urls]);
      for (const secret of kit.secrets) expect(text).not.toContain(secret);
    }
  });

  test("27. resumable calls pick up by id in a fresh context; the rest end before submit returns", async () => {
    for (const manifest of catalog) {
      expect(manifest.resumableSpeeds ?? []).not.toContain("batch" as never);
      for (const speed of offeredSpeeds(manifest).filter((s) => s !== "batch")) {
        const h = harness(kit);
        const { handles, model, normalized } = await generate(kit, manifest, request(manifest), h, { speed });
        const handle = handles[0]!;

        if (!resumesAfterRestart(manifest, speed)) {
          // A blocking call holds on until the image is in hand, so nothing it sent keeps running
          // at the company once submit() returns, and a restart has nothing to pick up.
          expect(h.ctx.assets.written).toHaveLength(1);
          expect((await model.poll(handle, h.ctx)).state).toBe("succeeded");
          continue;
        }

        // Accepted, not finished: the company's id is there, the image isn't.
        expect(handle.providerRef).toBeTruthy();
        expect(outputsOf(h, manifest)).toHaveLength(0);
        expect(["queued", "running"]).toContain((await model.poll(handle, h.ctx)).state);

        // Only the stored handle carries over: a fresh binding, context and fake API stand in for a
        // restarted server, and time moves on.
        const stored = jobHandleSchema.parse(JSON.parse(JSON.stringify(handle)));
        const restarted = kit.provider.model(manifest.key);
        const later = harness(kit);
        const done = await finish(restarted, stored, later);
        expect(done.state).toBe("succeeded");
        expect(done.result?.images).toHaveLength(1);
        expect(done.result?.speedUsed ?? speed).toBe(speed);
        expect(outputsOf(later, manifest)).toHaveLength(1);
        // Read again, it writes nothing more.
        const writes = later.ctx.assets.written.length;
        expect(await restarted.poll(stored, later.ctx)).toEqual(done);
        expect(later.ctx.assets.written).toHaveLength(writes);
        // One create call in all, and none after the restart.
        const creates = (calls: { method: string }[]) => calls.filter((c) => c.method === "POST").length;
        expect([creates(h.fetch.calls), creates(later.fetch.calls)]).toEqual([1, 0]);
        // The handle is saved to the library as it is, so it carries no key, token or signed URL:
        // poll() and cancel() build their auth from ctx.credentials.
        for (const secret of kit.secrets) expect(JSON.stringify(stored)).not.toContain(secret);
        // Declared idempotent: the same create sent again, as after an answer that was lost, hands
        // back the first call instead of starting a second one.
        if (manifest.idempotentSubmit) {
          const again = await model.submit(normalized.calls[0]!, h.ctx);
          expect(again.providerRef).toBe(handle.providerRef);
        }

        // An id the company doesn't have is gone, not a hiccup to try again.
        const gone = await expectError(
          restarted.poll({ ...stored, providerRef: "not-a-real-id" }, harness(kit).ctx),
        );
        expect([gone.code, gone.notFound, gone.retryable]).toEqual(["provider_error", true, false]);
        expect(gone.userMessage).toContain(kit.provider.meta.displayName);
      }
    }
  });

  test("28. video: a video file with its length, sound and poster, billed from the company's tokens", async () => {
    for (const manifest of catalog.filter(isVideo)) {
      const video = manifest.capabilities.video!;
      const h = harness(kit);
      const req = request(manifest, { video: { seconds: video.defaultDuration } });
      const { updates, normalized } = await run(kit, manifest, req, h);
      const result = updates[0]!.result!;
      const [clip] = result.images;
      expect(clip?.mimeType).toMatch(/^video\//);
      expect(clip?.durationMs).toBeGreaterThan(0);
      expect(clip?.hasAudio).toBe(normalized.request.video?.audio ?? false);
      // The poster is a still, written through the same sink, never the video itself.
      if (clip?.poster) {
        expect(clip.poster.mimeType).toMatch(/^image\//);
        expect(h.ctx.assets.written.find((a) => a.assetId === clip.poster!.assetId)?.mimeType).toMatch(
          /^image\//,
        );
      }
      // Only a finished video is billed, from the tokens the company reported.
      if (manifest.price.kind === "video_tokens") {
        expect(result.usage?.outputVideoTokens).toBeGreaterThan(0);
        expect(result.cost?.confidence).toBe("reconciled");
        expect(result.cost?.amount).toBeGreaterThan(0);
      }
      expect(normalized.calls).toHaveLength(1);

      // A failed task writes nothing and bills nothing.
      for (const scenario of ["failed", "expired"] as const) {
        if (!kit.fake.fixtures[scenario]) continue;
        const f = harness(kit, { scenario });
        const err = await expectError(run(kit, manifest, request(manifest), f));
        expect(err.code).toBe(scenario === "expired" ? "timeout" : "provider_unavailable");
        expect(f.ctx.assets.written).toHaveLength(0);
      }
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
