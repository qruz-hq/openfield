// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { describe, expect, test } from "bun:test";
import {
  ACTIVE_JOB_STATES,
  ADAPTER_OPS,
  EDIT_OPS,
  ERROR_CODES,
  ERROR_PRIMARY_ACTION,
  isRetryable,
  isTerminalState,
  JOB_SET_STATES,
  JOB_STATES,
  LOCAL_OPS,
  OPS,
  RETRYABLE_ERROR_CODES,
  TERMINAL_JOB_STATES,
  TRANSPORT_ERROR_CODES,
} from "../src/constants";
import { adapterOpFor } from "../src/schemas";

describe("enums", () => {
  test("edit ops are every op but generate", () => {
    expect([...EDIT_OPS].sort()).toEqual(OPS.filter((op) => op !== "generate").sort());
  });

  test("job set states add partial to job states", () => {
    expect(JOB_SET_STATES).toEqual([...JOB_STATES, "partial"]);
    expect([...ACTIVE_JOB_STATES, ...TERMINAL_JOB_STATES].sort()).toEqual([...JOB_STATES].sort());
    expect(isTerminalState("partial")).toBe(true);
    expect(isTerminalState("running")).toBe(false);
  });

  test("exactly four codes are retryable, and transport codes never overlap", () => {
    expect([...RETRYABLE_ERROR_CODES].sort()).toEqual([
      "network",
      "provider_unavailable",
      "rate_limited",
      "timeout",
    ]);
    expect(isRetryable("auth_invalid")).toBe(false);
    for (const code of TRANSPORT_ERROR_CODES)
      expect((ERROR_CODES as readonly string[]).includes(code)).toBe(false);
    expect(Object.keys(ERROR_PRIMARY_ACTION).sort()).toEqual([...ERROR_CODES].sort());
  });

  test("ops compile to adapter ops per §0.4", () => {
    const plain = { hasMask: false, canInpaint: false };
    for (const op of ADAPTER_OPS) expect(adapterOpFor(op, plain)).toBe(op);
    expect(adapterOpFor("variation", plain)).toBe("generate");
    expect(adapterOpFor("relight", plain)).toBe("edit");
    expect(adapterOpFor("relight", { hasMask: true, canInpaint: true })).toBe("inpaint");
    expect(adapterOpFor("decompose", plain)).toBeNull();
    for (const op of LOCAL_OPS) expect(adapterOpFor(op, plain)).toBeNull();
  });
});
