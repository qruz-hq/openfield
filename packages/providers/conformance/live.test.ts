import { describe, expect, test } from "bun:test";
import { isTerminalState, newId } from "@openfield/core";
import { normalize } from "../src/normalize";
import { createTestContext } from "../src/testing/context";
import type { ProviderError } from "../src/types";
import { kits, request } from "./harness";

// OPENFIELD_CONFORMANCE=live runs a short check against the real APIs with keys from the
// environment. It makes one image on each provider's cheapest model, so it costs a few cents.
// Run it before a release and when recording fixtures.

const live = process.env.OPENFIELD_CONFORMANCE === "live";

describe
  .skipIf(!live)
  .each(kits.filter((kit) => kit.live).map((kit) => [kit.provider.meta.id, kit] as const))(
  "live: %s",
  (_id, kit) => {
    const credentials = Object.fromEntries(
      kit.provider.credentials.fields.map((f) => [
        f.name,
        f.envVars.map((v) => process.env[v]).find(Boolean) ?? "",
      ]),
    );
    const ctx = () => createTestContext({ fetch: (input, init) => fetch(input, init), credentials });

    test("the key works", async () => {
      const result = await kit.provider.verifyCredentials(ctx());
      expect(result.ok).toBe(true);
    });

    test("a bad key is rejected as auth_invalid", async () => {
      const bad = createTestContext({
        fetch: (input, init) => fetch(input, init),
        credentials: Object.fromEntries(
          Object.keys(credentials).map((k) => [k, "definitely-not-a-real-key"]),
        ),
      });
      const err = await kit.provider.verifyCredentials(bad).catch((e: unknown) => e);
      expect((err as ProviderError).code).toBe("auth_invalid");
    });

    test("one image on the cheapest model", async () => {
      const cheapest = [...kit.provider.catalog()].sort((a, b) => priceOf(a.price) - priceOf(b.price))[0]!;
      const normalized = await normalize(
        cheapest,
        request(cheapest, { prompt: "A small blue teapot on a white table" }),
        {
          jobSetId: newId(),
        },
      );
      expect(normalized.error).toBeUndefined();
      const context = ctx();
      const model = kit.provider.model(cheapest.key);
      const handle = await model.submit(normalized.calls[0]!, context);
      // A queue-style call answers later; a blocking one already has its image.
      let update = await model.poll(handle, context);
      while (!isTerminalState(update.state)) {
        await Bun.sleep(update.nextPollAfterMs ?? 2_000);
        update = await model.poll(handle, context);
      }
      expect(update.state).toBe("succeeded");
      expect(update.result?.images[0]?.width).toBeGreaterThan(0);
      expect(JSON.stringify(context.log.lines)).not.toContain(Object.values(credentials)[0]);
    }, 180_000);
  },
);

function priceOf(price: { kind: string; tiers?: { usd: number }[] }): number {
  return price.tiers ? Math.min(...price.tiers.map((t) => t.usd)) : Number.POSITIVE_INFINITY;
}
