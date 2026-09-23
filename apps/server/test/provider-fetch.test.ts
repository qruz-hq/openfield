import { describe, expect, test } from "bun:test";
import { createGoogleProvider, type FetchLike, type RedactingLogger } from "@openfield/providers/server";
import { providerFetch } from "../src/runner/provider-fetch";

// §6.11 acceptance 4: only hosts in meta.networkHosts ∪ meta.assetHosts, https only, and no
// redirect to another host.

const google = createGoogleProvider();
const warnings: unknown[] = [];
const log: RedactingLogger = {
  debug: () => {},
  info: () => {},
  warn: (_msg, data) => warnings.push(data),
  error: () => {},
  scrub: (v) => v,
};

function recorder(respond: (url: string) => Response = () => new Response("ok")) {
  const calls: string[] = [];
  const base: FetchLike = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return respond(url);
  };
  return { calls, fetch: providerFetch(base, google, log) };
}

describe("the adapter's fetch", () => {
  test("reaches a declared host over https", async () => {
    const { calls, fetch } = recorder();
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("refuses a host the adapter didn't declare, before any request", async () => {
    const { calls, fetch } = recorder();
    await expect(fetch("https://evil.example/steal")).rejects.toMatchObject({
      code: "provider_error",
      userMessage: "Image blocked. It came from an unknown site.",
    });
    expect(calls).toEqual([]);
    expect(warnings).toContainEqual({ host: "evil.example" });
  });

  test("refuses plain http, even to a declared host", async () => {
    const { calls, fetch } = recorder();
    await expect(fetch("http://generativelanguage.googleapis.com/v1beta/models")).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(calls).toEqual([]);
  });

  test("follows a redirect on the same host, never to another one", async () => {
    const same = recorder((url) =>
      url.endsWith("/old")
        ? new Response(null, { status: 302, headers: { location: "/v1beta/new" } })
        : new Response("moved"),
    );
    expect(await (await same.fetch("https://generativelanguage.googleapis.com/old")).text()).toBe("moved");
    expect(same.calls).toEqual([
      "https://generativelanguage.googleapis.com/old",
      "https://generativelanguage.googleapis.com/v1beta/new",
    ]);

    const away = recorder(
      () => new Response(null, { status: 302, headers: { location: "https://cdn.evil.example/x" } }),
    );
    await expect(away.fetch("https://generativelanguage.googleapis.com/old")).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(away.calls).toHaveLength(1);
  });
});
