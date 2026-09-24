import { afterEach, describe, expect, test } from "bun:test";
import { parseSseFrame, type SseEvent } from "@openfield/core";
import { EventHub } from "../src/events/hub";
import { generate, readFrames, saveKey, startTestServer, type TestServer } from "./helpers";

// §8.3.2: one stream, ids that only go up, a snapshot first, every frame a valid sseEventSchema.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("GET /api/events", () => {
  test("opens with a snapshot, then streams a run to completion; every frame parses", async () => {
    server = await startTestServer();
    await saveKey(server);
    const res = await server.request("/api/events", { headers: { "last-event-id": "12" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");

    const reading = readFrames(res, (frames) => frames.some((f) => f.event === "job_set.completed"));
    await Bun.sleep(20);
    const run = await generate(server, { batch: 2 });
    const frames = await reading;

    const parsed = frames.map((f) => parseSseFrame(f.event, f.data));
    expect(parsed.every((p) => p !== null)).toBe(true);
    expect(frames[0]!.event).toBe("snapshot");
    const ids = frames.map((f) => f.id!);
    expect(ids.every((id, i) => i === 0 || id > ids[i - 1]!)).toBe(true);

    const names = frames.map((f) => f.event);
    for (const name of ["job_set.created", "job.started", "job.output", "job_set.completed"]) {
      expect(names).toContain(name);
    }
    const done = parsed.find((p) => p?.event === "job_set.completed") as Extract<
      SseEvent,
      { event: "job_set.completed" }
    >;
    expect(done.data).toMatchObject({ jobSetId: run.jobSet.id, status: "succeeded" });
    const outputs = parsed.filter((p) => p?.event === "job.output");
    expect(outputs).toHaveLength(2);
    expect(server.services.events.connections).toBe(0);
  });

  test("a snapshot lists runs still in progress", async () => {
    server = await startTestServer();
    // With the runner stopped, the run stays pending.
    await server.services.runner.stop({ drainMs: 0 });
    const run = await generate(server);
    const res = await server.request("/api/events");
    const [snapshot] = await readFrames(res, (frames) => frames.length > 0);
    const parsed = parseSseFrame(snapshot!.event, snapshot!.data) as Extract<SseEvent, { event: "snapshot" }>;
    expect(parsed.data.activeJobSets.map((s) => s.jobSet.id)).toEqual([run.jobSet.id]);
  });

  test("an idle stream gets a heartbeat so it isn't dropped", async () => {
    const hub = new EventHub({ snapshot: () => ({ activeJobSets: [], batches: [] }), heartbeatMs: 20 });
    try {
      const reader = hub.connect().body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const until = Date.now() + 2_000;
      while (!text.includes(": ping") && Date.now() < until) {
        text += decoder.decode((await reader.read()).value, { stream: true });
      }
      expect(text).toContain(": ping");
      await reader.cancel();
    } finally {
      hub.close();
    }
  });
});
