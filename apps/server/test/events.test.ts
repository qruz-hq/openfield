import { afterEach, describe, expect, test } from "bun:test";
import { parseSseFrame, type SseEvent } from "@openfield/core";
import { EventHub } from "../src/events/hub";
import { generate, saveKey, startTestServer, type TestServer } from "./helpers";

// §8.3.2: one stream, ids that only go up, a snapshot first, every frame a valid sseEventSchema.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

interface Frame {
  id?: number;
  event: string;
  data: string;
}

/** Reads text/event-stream frames until `until` says stop. */
async function readFrames(
  res: Response,
  until: (frames: Frame[]) => boolean,
  timeoutMs = 5_000,
): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  const timer = setTimeout(() => reader.cancel(), timeoutMs);
  try {
    while (!until(frames)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const frame: Frame = { event: "", data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) frame.id = Number(line.slice(4));
          else if (line.startsWith("event: ")) frame.event = line.slice(7);
          else if (line.startsWith("data: ")) frame.data += line.slice(6);
        }
        if (frame.event) frames.push(frame);
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return frames;
}

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
    await server.services.runner.stop(0);
    const run = await generate(server);
    const res = await server.request("/api/events");
    const [snapshot] = await readFrames(res, (frames) => frames.length > 0);
    const parsed = parseSseFrame(snapshot!.event, snapshot!.data) as Extract<SseEvent, { event: "snapshot" }>;
    expect(parsed.data.activeJobSets.map((s) => s.jobSet.id)).toEqual([run.jobSet.id]);
  });

  test("an idle stream gets a heartbeat so it isn't dropped", async () => {
    const hub = new EventHub({ snapshot: () => [], heartbeatMs: 20 });
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
