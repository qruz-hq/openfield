// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CanvasArchiveJob, SseEvent } from "@openfield/core";
import { followArchiveJob, piecesOf, sendImportFile } from "../src/api/hooks/canvas-archives";
import { ApiError } from "../src/api/raw";
import { readStream } from "../src/canvas/archive-flow";
import {
  baseName,
  CanvasFileError,
  canvasNameOf,
  folderOf,
  importFraction,
  importSelection,
  jobFraction,
} from "../src/canvas/index/file";
import { openDialog, saveDialog } from "../src/lib/desktop";

// Whole-canvas export and import (§7.8), the page's side: what a pick sends, in what order and in
// what pieces, how far along the toast says it is, and following a job to its end.

const JOB_ID = "01K6BQ8000000000000000J0B1";

const job = (extra: Partial<CanvasArchiveJob> = {}): CanvasArchiveJob => ({
  jobId: JOB_ID,
  kind: "import",
  state: "running",
  canvasId: null,
  name: null,
  done: 0,
  total: 0,
  files: { done: 0, total: 0 },
  startedAt: "2026-10-26T10:00:00.000Z",
  finishedAt: null,
  result: null,
  error: null,
  ...extra,
});

/** What an <input type=file> hands over; webkitRelativePath is set inside a folder. */
const picked = (path: string, body = "x") =>
  Object.assign(new Blob([body]), {
    name: baseName(path),
    webkitRelativePath: path.includes("/") ? path : "",
  });

describe("choosing what to import", () => {
  test("one .zip or .json goes up under its own name", () => {
    const zip = importSelection([picked("Lighthouse series.ofcanvas.zip")]);
    expect(zip.name).toBe("Lighthouse series");
    expect(zip.files.map((f) => f.path)).toEqual(["Lighthouse series.ofcanvas.zip"]);
    expect(zip.lead).toBe(0);
    expect(importSelection([picked("Old.OFCANVAS.JSON")]).name).toBe("Old");
  });

  test("anything else isn't a canvas", () => {
    expect(() => importSelection([picked("photo.png")])).toThrow(CanvasFileError);
    expect(() => importSelection([picked("photo.png")])).toThrow("This isn't a canvas or a canvas export.");
    expect(() => importSelection([])).toThrow(CanvasFileError);
  });

  test("a folder sends canvas.json and manifest.json first, and leaves Finder's files out", () => {
    const selection = importSelection([
      picked("Lighthouse.ofcanvas/assets/01K6BQ8000000000000000AAAA.png"),
      picked("Lighthouse.ofcanvas/.DS_Store"),
      picked("Lighthouse.ofcanvas/__MACOSX/._canvas.json"),
      picked("Lighthouse.ofcanvas/assets/._01K6BQ8000000000000000AAAA.png"),
      picked("Lighthouse.ofcanvas/manifest.json"),
      picked("Lighthouse.ofcanvas/canvas.json"),
    ]);
    expect(selection.name).toBe("Lighthouse");
    expect(selection.lead).toBe(2);
    expect(selection.files.map((f) => f.path)).toEqual([
      "Lighthouse.ofcanvas/canvas.json",
      "Lighthouse.ofcanvas/manifest.json",
      "Lighthouse.ofcanvas/assets/01K6BQ8000000000000000AAAA.png",
    ]);
  });

  test("a folder holding the canvas one level down sends only that canvas", () => {
    const selection = importSelection([
      picked("Exports/notes.txt"),
      picked("Exports/Lighthouse/canvas.json"),
      picked("Exports/Lighthouse/assets/01K6BQ8000000000000000AAAA.png"),
    ]);
    expect(selection.name).toBe("Lighthouse");
    expect(selection.lead).toBe(1);
    expect(selection.files.map((f) => f.path)).toEqual([
      "Exports/Lighthouse/canvas.json",
      "Exports/Lighthouse/assets/01K6BQ8000000000000000AAAA.png",
    ]);
  });

  test("a folder without one canvas.json isn't a canvas", () => {
    expect(() => importSelection([picked("Photos/a.png"), picked("Photos/b.png")])).toThrow(CanvasFileError);
    expect(() => importSelection([picked("Exports/A/canvas.json"), picked("Exports/B/canvas.json")])).toThrow(
      CanvasFileError,
    );
  });

  test("names and folders from paths on either system", () => {
    expect(canvasNameOf("Moodboard.ofcanvas")).toBe("Moodboard");
    expect(canvasNameOf("Moodboard.zip")).toBe("Moodboard");
    expect(baseName("/Users/me/Downloads/Moodboard.ofcanvas.zip")).toBe("Moodboard.ofcanvas.zip");
    expect(baseName("C:\\Users\\me\\Moodboard\\")).toBe("Moodboard");
    expect(folderOf("/Users/me/Downloads/Moodboard.ofcanvas.zip")).toBe("/Users/me/Downloads");
    expect(folderOf("C:\\Users\\me\\Moodboard.ofcanvas.zip")).toBe("C:\\Users\\me");
  });
});

describe("progress", () => {
  test("a job's own progress, unknown until it has a size", () => {
    expect(jobFraction(job())).toBeUndefined();
    expect(jobFraction(job({ done: 25, total: 100 }))).toBe(0.25);
    expect(jobFraction(job({ done: 120, total: 100 }))).toBe(1);
  });

  test("a browser import: sending is the first half, taking in the second", () => {
    expect(importFraction({ sent: 0, toSend: 0 })).toBe(0);
    expect(importFraction({ sent: 50, toSend: 100 })).toBe(0.25);
    expect(importFraction({ job: job(), uploaded: true })).toBe(0.5);
    expect(importFraction({ job: job({ done: 50, total: 100 }), uploaded: true })).toBe(0.75);
    // The desktop app hands over a path: the job is the whole line.
    expect(importFraction({ job: job(), uploaded: false })).toBeUndefined();
    expect(importFraction({ job: job({ done: 50, total: 100 }), uploaded: false })).toBe(0.5);
  });
});

describe("sending files up", () => {
  test("pieces cover the file end to end; an empty file is one empty piece", () => {
    expect(piecesOf(0, 10)).toEqual([{ start: 0, end: 0 }]);
    expect(piecesOf(10, 10)).toEqual([{ start: 0, end: 10 }]);
    expect(piecesOf(25, 10)).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 25 },
    ]);
  });

  const realFetch = globalThis.fetch;
  const hadDocument = "document" in globalThis;
  let sent: { url: string; method?: string; size: number }[] = [];
  beforeEach(() => {
    sent = [];
    // The session header reads the token from the page; this one has none.
    if (!hadDocument) globalThis.document = { querySelector: () => null } as unknown as Document;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const size = init?.body instanceof Blob ? init.body.size : 0;
      sent.push({ url: String(input), method: init?.method, size });
      if (String(input).includes("gone")) {
        return Response.json(
          { error: { code: "not_found", message: "Unknown upload", retryable: false } },
          { status: 404 },
        );
      }
      return Response.json({ path: "x", size });
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    if (!hadDocument) Reflect.deleteProperty(globalThis, "document");
  });

  test("a file goes up at its path from offset 0, and each piece is counted", async () => {
    const counted: number[] = [];
    await sendImportFile("01K6BQ8000000000000000UPLD", "Lighthouse/assets/a b.png", new Blob(["12345"]), {
      onBytes: (bytes) => counted.push(bytes),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("PUT");
    expect(sent[0]!.url).toBe(
      "/api/canvas-imports/uploads/01K6BQ8000000000000000UPLD/files?path=Lighthouse%2Fassets%2Fa+b.png&offset=0",
    );
    expect(sent[0]!.size).toBe(5);
    expect(counted).toEqual([5]);
  });

  test("a refused piece throws the server's error", async () => {
    const error = await sendImportFile("gone", "canvas.json", new Blob(["{}"])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});

describe("following a job", () => {
  const stream = () => {
    const listeners = new Set<(event: SseEvent) => void>();
    return {
      subscribe: (listener: (event: SseEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send: (data: CanvasArchiveJob) => {
        for (const listener of listeners) listener({ event: "canvas_archive.updated", data });
      },
      get size() {
        return listeners.size;
      },
    };
  };

  test("reports each frame for its job and ends on the last", async () => {
    const events = stream();
    const seen: number[] = [];
    const following = followArchiveJob(job(), {
      subscribe: events.subscribe,
      fetchJob: () => new Promise(() => {}),
      onUpdate: (next) => seen.push(next.done),
    });
    events.send(job({ done: 10, total: 100 }));
    events.send(job({ jobId: "01K6BQ8000000000000000OTHR", done: 99, total: 100 }));
    events.send(job({ state: "done", done: 100, total: 100 }));
    events.send(job({ state: "running", done: 50, total: 100 }));
    const final = await following;
    expect(final.state).toBe("done");
    expect(seen).toEqual([0, 10, 100]);
    expect(events.size).toBe(0);
  });

  test("an answer to the poll ends it too, when the stream missed the end", async () => {
    const events = stream();
    const final = await followArchiveJob(job(), {
      subscribe: events.subscribe,
      fetchJob: async () => job({ state: "canceled" }),
    });
    expect(final.state).toBe("canceled");
    expect(events.size).toBe(0);
  });

  test("a job the server forgot fails; a dropped connection doesn't", async () => {
    let calls = 0;
    const events = stream();
    const following = followArchiveJob(job(), {
      subscribe: events.subscribe,
      pollMs: 1,
      fetchJob: async () => {
        calls++;
        if (calls === 1) throw new ApiError(0, "network", "offline", true);
        throw new ApiError(404, "not_found", "That export or import");
      },
    });
    const error = await following.catch((e: unknown) => e);
    expect(calls).toBe(2);
    expect((error as ApiError).status).toBe(404);
    expect(events.size).toBe(0);
  });
});

test("reading a download counts every byte", async () => {
  const chunks: number[] = [];
  const counts: number[] = [];
  const total = await readStream(new Response(new Blob(["abc", "defgh"])), {
    write: (chunk) => void chunks.push(chunk.byteLength),
    onBytes: (done) => counts.push(done),
  });
  expect(total).toBe(8);
  expect(chunks.reduce((a, b) => a + b, 0)).toBe(8);
  expect(counts.at(-1)).toBe(8);
});

describe("the desktop app's dialogs", () => {
  const g = globalThis as { __TAURI_INTERNALS__?: unknown };
  let calls: unknown[][];
  let answer: unknown;

  beforeEach(() => {
    calls = [];
    answer = "/Users/me/Downloads/Lighthouse.ofcanvas.zip";
    g.__TAURI_INTERNALS__ = {
      invoke: mock((...args: unknown[]) => {
        calls.push(args);
        return answer instanceof Error ? Promise.reject(answer.message) : Promise.resolve(answer);
      }),
    };
  });
  afterEach(() => {
    delete g.__TAURI_INTERNALS__;
  });

  test("save asks the dialog plugin and answers with the path", async () => {
    const filters = [{ name: "Openfield canvas", extensions: ["zip"] }];
    expect(await saveDialog({ defaultPath: "Lighthouse.ofcanvas.zip", filters })).toBe(
      "/Users/me/Downloads/Lighthouse.ofcanvas.zip",
    );
    expect(calls).toEqual([
      ["plugin:dialog|save", { options: { defaultPath: "Lighthouse.ofcanvas.zip", filters } }],
    ]);
  });

  test("open picks one file or one folder; closing it is null", async () => {
    answer = null;
    expect(await openDialog({ directory: true })).toBeNull();
    expect(calls).toEqual([["plugin:dialog|open", { options: { directory: true, multiple: false } }]]);
  });

  test("a refusal reads as the app's words", async () => {
    answer = new Error("dialog.open not allowed");
    await expect(openDialog({})).rejects.toThrow("dialog.open not allowed");
  });

  test("outside the app there is no dialog", async () => {
    delete g.__TAURI_INTERNALS__;
    await expect(saveDialog({})).rejects.toThrow();
  });
});
