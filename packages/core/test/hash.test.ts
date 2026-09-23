// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { describe, expect, test } from "bun:test";
import { canonicalJson, HASH_RE, hashCanonical, sha256Hex } from "../src/hash";

describe("sha256Hex", () => {
  test("matches the standard test vectors", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("hashes text as UTF-8", async () => {
    expect(await sha256Hex("é")).toBe(await sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });
});

describe("canonicalJson", () => {
  test("sorts keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: true } })).toBe(
      '{"a":{"c":true,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  test("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("sorts unicode keys by code unit and leaves strings as written", () => {
    expect(canonicalJson({ "😀": 1, z: 2, é: 3, Z: 4 })).toBe('{"Z":4,"z":2,"é":3,"😀":1}');
    // Composed and decomposed é are different text, so they hash differently.
    expect(canonicalJson("é")).not.toBe(canonicalJson("é"));
    expect(canonicalJson("日本語 · \n")).toBe('"日本語 · \\n"');
  });

  test("writes numbers the way JSON does", () => {
    expect(canonicalJson({ a: 1.0, b: -0, c: 0.1 + 0.2, d: 1e21, e: 1e-7, f: 100 })).toBe(
      '{"a":1,"b":0,"c":0.30000000000000004,"d":1e+21,"e":1e-7,"f":100}',
    );
  });

  test("drops undefined in objects and nulls it in arrays", () => {
    expect(canonicalJson({ a: undefined, b: null, c: [undefined, 1] })).toBe('{"b":null,"c":[null,1]}');
  });

  test("uses toJSON, like JSON.stringify", () => {
    expect(canonicalJson({ at: new Date(Date.UTC(2026, 8, 23)) })).toBe('{"at":"2026-09-23T00:00:00.000Z"}');
  });

  test("allows shared references but refuses cycles", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(TypeError);
  });

  test("refuses values that have no stable JSON form", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});

describe("hashCanonical", () => {
  test("is stable across key order", async () => {
    const a = await hashCanonical({
      model: "google:gemini-3-pro-image",
      batch: 2,
      size: { kind: "aspect", ratio: "3:4" },
    });
    const b = await hashCanonical({
      size: { ratio: "3:4", kind: "aspect" },
      batch: 2,
      model: "google:gemini-3-pro-image",
    });
    expect(a).toBe(b);
    expect(a).toMatch(HASH_RE);
  });

  test("changes when any value changes", async () => {
    const base = { prompt: "a teapot", batch: 1 };
    expect(await hashCanonical(base)).not.toBe(await hashCanonical({ ...base, batch: 2 }));
    expect(await hashCanonical(base)).not.toBe(await hashCanonical({ ...base, prompt: "a teapot " }));
  });

  test("is pinned, so a change to the encoding can't slip through", async () => {
    expect(await hashCanonical({ b: [1, "two", null], a: true })).toBe(
      `sha256:${await sha256Hex('{"a":true,"b":[1,"two",null]}')}`,
    );
    expect(await hashCanonical({})).toBe(
      "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
  });
});
