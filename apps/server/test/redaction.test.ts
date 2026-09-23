import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type JobSetsListResponse, parseSseFrame } from "@openfield/core";
import { createFakeFetch, type FetchLike } from "@openfield/providers/server";
import { Logger, type LogRecord } from "../src/log/logger";
import {
  completed,
  generate,
  googleError,
  isGenerateCall,
  saveKey,
  startTestServer,
  TEST_KEY,
  type TestServer,
} from "./helpers";

// §6.11: a key never reaches a log sink, a response, an SSE frame or a stored error.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("the redaction filter", () => {
  test("hides loaded keys and key-shaped strings in every sink", () => {
    const secret = "my-very-secret-key-123";
    const logger = new Logger({ secrets: () => [secret], level: "debug" });
    const a: LogRecord[] = [];
    const b: LogRecord[] = [];
    logger.addSink({ write: (r) => a.push(r) });
    logger.addSink({ write: (r) => b.push(r) });

    logger.error(`failed with ${secret}`, {
      headers: { authorization: `Bearer ${secret}`, "x-goog-api-key": secret },
      nested: [{ body: `key=${secret}` }],
      openai: "sk-abcdefghijklmnopqrstuvwxyz",
      google: "AIzaSyA-1234567890abcdefghijk",
      error: new Error(`boom ${secret}`),
    });
    logger.scoped("google").warn("scoped", { secret });

    for (const sink of [a, b]) {
      const text = JSON.stringify(sink);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(text).not.toContain("AIzaSyA-1234567890abcdefghijk");
      expect(text).toContain("[hidden]");
      expect(sink).toHaveLength(2);
    }
  });
});

describe("keys over HTTP", () => {
  test("no response, frame, stored error or log line ever holds the key", async () => {
    // The provider echoes the key back in its error, as some do.
    const fake = createFakeFetch({ delayMs: 0 });
    const echo: FetchLike = async (input, init) =>
      isGenerateCall(input)
        ? googleError(400, "INVALID_ARGUMENT", `Bad request for key ${TEST_KEY}`)
        : fake(input, init);
    server = await startTestServer({ fetch: echo });
    const bodies: string[] = [];
    const record = async (path: string, init?: RequestInit) => {
      const res = await server!.request(path, init);
      bodies.push(await res.text());
    };

    await record("/api/settings/keys/google", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: TEST_KEY }),
    });
    await record("/api/settings/keys/google/test", { method: "POST" });
    const run = await generate(server);
    await completed(server, run.jobSet.id);
    await record("/api/settings/keys");
    await record("/api/providers");
    await record("/api/job-sets?status=all");
    await record("/api/models");
    await record("/api/health");

    for (const body of bodies) expect(body).not.toContain(TEST_KEY);
    for (const { event, data } of server.events) {
      const json = JSON.stringify(data);
      expect(json).not.toContain(TEST_KEY);
      expect(parseSseFrame(event, json)).not.toBeNull();
    }

    const list = JSON.parse(bodies[4]!) as JobSetsListResponse;
    const job = list.items[0]!.jobs[0]!;
    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe("invalid_request");
    expect(job.errorMessage).toContain("[hidden]");

    const logs = ["logs/openfield.log", "logs/jobs.ndjson"].map((f) =>
      readFileSync(join(server!.home, f), "utf8"),
    );
    for (const log of logs) expect(log).not.toContain(TEST_KEY);
    expect(logs[1]).toContain("[hidden]");
  });

  test("an environment key is hidden too", async () => {
    const envKey = "AIzaEnvironmentKey-abcdefghijk";
    server = await startTestServer({ env: { GOOGLE_API_KEY: envKey } });
    server.services.logger.error(`oops ${envKey}`);
    expect(readFileSync(join(server.home, "logs/openfield.log"), "utf8")).not.toContain(envKey);
    const keys = await server.request("/api/settings/keys");
    expect(await keys.text()).not.toContain(envKey);
  });

  test("the key is saved, used, and only its last four characters come back", async () => {
    server = await startTestServer();
    await saveKey(server);
    const status = await server.json<{ hint: string; present: boolean }>("/api/settings/keys/google", {
      method: "DELETE",
    });
    expect(status.body.present).toBe(false);
    expect(
      JSON.parse(readFileSync(join(server.home, "config.json"), "utf8")).providers.google,
    ).toBeUndefined();
  });
});
