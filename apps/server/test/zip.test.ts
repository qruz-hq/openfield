import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorEnvelopeSchema } from "@openfield/core";
import { planZip, zipStream } from "../src/files/zip";
import { startTestServer, type TestServer } from "./helpers";
import { bulk, readZip, seedImage, unzipTest } from "./library-helpers";

// Download as a zip (§2.5): stored originals, streamed one at a time, with an exact length up
// front, and ZIP64 once the archive passes 4 GB.

let server: TestServer | undefined;
const scratch: string[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

async function pack(files: Uint8Array[], zip64From?: number) {
  const plan = planZip(
    files.map((data, i) => ({
      name: `image-${i}.png`,
      size: data.byteLength,
      modifiedAt: new Date(2026, 8, 24, 10, i, 30),
    })),
    zip64From === undefined ? {} : { zip64From },
  );
  const body = new Uint8Array(await new Response(zipStream(plan, async (i) => files[i]!)).arrayBuffer());
  return { plan, body };
}

function onDisk(body: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "openfield-zip-"));
  scratch.push(dir);
  const file = join(dir, "test.zip");
  writeFileSync(file, body);
  return file;
}

describe("the zip writer", () => {
  test("the archive is exactly as long as planned, and every entry reads back intact", async () => {
    const files = [bytes(1000, 1), bytes(0, 2), bytes(70_000, 3)];
    const { plan, body } = await pack(files);
    expect(body.byteLength).toBe(plan.length);
    expect(plan.zip64).toBe(false);
    const read = readZip(body);
    expect(read.map((f) => f.name)).toEqual(["image-0.png", "image-1.png", "image-2.png"]);
    expect(read.map((f) => f.data)).toEqual(files);
    unzipTest(onDisk(body));
  });

  test("ZIP64 records take over past the limit, and still read back", async () => {
    const files = [bytes(500, 4), bytes(600, 5), bytes(700, 6)];
    // Moved down to 500 bytes, so the second and third entries start past it.
    const { plan, body } = await pack(files, 500);
    expect(plan.zip64).toBe(true);
    expect(plan.entries.map((e) => e.zip64)).toEqual([false, true, true]);
    expect(body.byteLength).toBe(plan.length);
    const read = readZip(body);
    expect(read.map((f) => f.data)).toEqual(files);
    expect(read.map((f) => f.offset)).toEqual(plan.entries.map((e) => e.offset));
    unzipTest(onDisk(body));
  });

  test("a file that changed size stops the stream instead of writing a broken archive", async () => {
    const plan = planZip([{ name: "a.png", size: 10, modifiedAt: new Date() }]);
    const errors: unknown[] = [];
    const stream = zipStream(
      plan,
      async () => bytes(9, 1),
      (e) => errors.push(e),
    );
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow("changed size");
    expect(errors).toHaveLength(1);
  });

  test("files are read only as the reader asks for more", async () => {
    const files = Array.from({ length: 5 }, (_, i) => bytes(2000, i));
    const plan = planZip(
      files.map((f, i) => ({ name: `${i}.png`, size: f.byteLength, modifiedAt: new Date() })),
    );
    const asked: number[] = [];
    const reader = zipStream(plan, async (i) => {
      asked.push(i);
      return files[i]!;
    }).getReader();
    await reader.read();
    expect(asked.length).toBeLessThanOrEqual(2);
    await reader.cancel();
  });
});

describe("POST /api/assets/bulk download", () => {
  test("streams the originals as a zip named for the day and the count", async () => {
    server = await startTestServer();
    const a = await seedImage(server, { at: 1 });
    const b = await seedImage(server, { at: 2 });
    const missing = await seedImage(server, { at: 3 });
    unlinkSync(join(server.home, missing.path));
    // An image in the Trash still downloads; unknown ids and missing files are left out.
    await bulk(server, "delete", [b.id]);

    const res = await server.request("/api/assets/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [a.id, b.id, missing.id, "01K6BQ8A1C4D7E9F0000000000"],
        action: "download",
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="openfield-\d{4}-\d{2}-\d{2}-2\.zip"/,
    );
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get("content-length"))).toBe(body.byteLength);
    expect(Number(res.headers.get("x-openfield-zip-bytes"))).toBe(body.byteLength);
    expect(res.headers.get("x-openfield-zip-count")).toBe("2");

    const files = readZip(body);
    const name = (id: string) => new RegExp(`^\\d{8}-\\d{6}-${id.slice(-6).toLowerCase()}\\.png$`);
    expect(files).toHaveLength(2);
    expect(files[0]!.name).toMatch(name(a.id));
    expect(files[1]!.name).toMatch(name(b.id));
    expect(files[0]!.data).toEqual(await Bun.file(join(server.home, a.path)).bytes());
    expect(files[1]!.data).toEqual(await Bun.file(join(server.home, b.path)).bytes());
    unzipTest(onDisk(body));
  });

  test("nothing to pack is a 404", async () => {
    server = await startTestServer();
    const res = await bulk(server, "download", ["01K6BQ8A1C4D7E9F0000000000"]);
    expect(res.status).toBe(404);
    expect(errorEnvelopeSchema.parse(res.body).error.code).toBe("not_found");
  });
});
