// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { parseSseFrame } from "@openfield/core";
import { ApiError, createSseParser, errorMessage, type SseFrame } from "../src/api/raw";

function parse(chunks: string[]): SseFrame[] {
  const frames: SseFrame[] = [];
  const parser = createSseParser((frame) => frames.push(frame));
  for (const chunk of chunks) parser.feed(chunk);
  return frames;
}

describe("event stream parser", () => {
  test("reads event, id and data, and skips comments", () => {
    const frames = parse([
      ": openfield stream\n",
      'event: job.progress\nid: 1044\ndata: {"progress":0.4}\n\n',
    ]);
    expect(frames).toEqual([{ event: "job.progress", id: "1044", data: '{"progress":0.4}' }]);
  });

  test("joins multi-line data and survives frames split across chunks", () => {
    const frames = parse(["event: a\nda", "ta: one\ndata: two\n", "\nevent: b\r\ndata: x\r", "\n\r\n"]);
    expect(frames).toEqual([
      { event: "a", data: "one\ntwo", id: undefined },
      { event: "b", data: "x", id: undefined },
    ]);
  });

  test("frames with no data are dropped", () => {
    expect(parse(["event: ping\n\n"])).toEqual([]);
  });

  test("frames parse into typed events, and unknown ones are ignored", () => {
    const [frame] = parse([
      'event: job.progress\ndata: {"jobSetId":"01K6BQ8000000000000000AAAA","jobId":"01K6BQ8000000000000000BBBB","idx":0,"progress":0.5}\n\n',
    ]);
    const event = parseSseFrame(frame!.event, frame!.data);
    expect(event?.event).toBe("job.progress");
    expect(parseSseFrame("job.nope", "{}")).toBeNull();
    expect(parseSseFrame("job.progress", "not json")).toBeNull();
  });
});

describe("error copy", () => {
  test("our own copy from the server shows; the server's detail never does", () => {
    const withCopy = new ApiError(
      500,
      "internal",
      "EISDIR: rename",
      false,
      undefined,
      "Couldn't save your key.",
    );
    expect(errorMessage(withCopy)).toBe("Couldn't save your key.");
    const detailOnly = new ApiError(400, "invalid_request", "Request contains an invalid argument.");
    expect(errorMessage(detailOnly)).toBe("These settings didn't work.");
  });
});
