import { expect } from "bun:test";
import { crc32 } from "node:zlib";
import { type AssetRow, insertAsset } from "@openfield/db";
import { image } from "./canvas-helpers";
import type { TestServer } from "./helpers";

// Builders for the Assets library's route tests: real image files in the library, placed at
// known times so every listing's order is certain, and a small zip reader for downloads.

/** Ten o'clock on 24 September 2026 plus `n` minutes. Listings sort by these. */
export const minute = (n: number) => new Date(Date.UTC(2026, 8, 24, 10, n)).toISOString();

export interface SeedOptions {
  at?: number;
  prompt?: string;
  model?: string;
  provider?: string;
  kind?: "generated" | "uploaded" | "mask";
}

let colour = 0;

/** A real PNG in the library, made `at` minutes past ten. Each one has its own bytes and file. */
export async function seedImage(server: TestServer, o: SeedOptions = {}): Promise<AssetRow> {
  colour = (colour + 1) % 0xfff;
  const background = `#${(0x100000 + colour * 0x0111).toString(16).slice(-6)}`;
  const bytes = await image("png", { background });
  const staged = await server.services.ingest.stage(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream());
  return insertAsset(server.services.db, {
    id: staged.assetId,
    kind: o.kind ?? "generated",
    path: staged.path,
    mime: staged.mime,
    width: staged.width,
    height: staged.height,
    bytes: staged.bytes,
    sha256: staged.sha256,
    providerId: o.provider ?? "google",
    modelId: o.model ?? "gemini-3.1-flash-image",
    prompt: o.prompt ?? "",
    createdAt: minute(o.at ?? 0),
  });
}

export async function seedImages(
  server: TestServer,
  count: number,
  o: SeedOptions = {},
): Promise<AssetRow[]> {
  const out: AssetRow[] = [];
  for (let i = 0; i < count; i++) out.push(await seedImage(server, { ...o, at: (o.at ?? 0) + i }));
  return out;
}

export async function newFolder(server: TestServer, name: string, parentId?: string): Promise<string> {
  const res = await server.json<{ id: string }>("/api/folders", {
    method: "POST",
    body: { name, ...(parentId && { parentId }) },
  });
  if (res.status !== 201) throw new Error(`Creating a folder failed: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

export function bulk(server: TestServer, action: string, ids: string[], folderId?: string) {
  return server.json<{ affected: number; changed: string[] }>("/api/assets/bulk", {
    method: "POST",
    body: { ids, action, ...(folderId && { folderId }) },
  });
}

/** Events of one type published since `from`, in order. */
export function eventsOf<T = unknown>(server: TestServer, event: string, from = 0): T[] {
  return server.events
    .slice(from)
    .filter((e) => e.event === event)
    .map((e) => e.data as T);
}

export interface ZipFile {
  name: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/**
 * Reads a stored (uncompressed) zip from its central directory, ZIP64 included, and checks each
 * entry's local header and CRC along the way.
 */
export function readZip(zip: Uint8Array): ZipFile[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  let count = view.getUint16(end + 10, true);
  let centralSize = view.getUint32(end + 12, true);
  let centralOffset = view.getUint32(end + 16, true);
  if (centralOffset === 0xffffffff) {
    const locator = end - 20;
    expect(view.getUint32(locator, true)).toBe(0x07064b50);
    const record = Number(view.getBigUint64(locator + 8, true));
    expect(view.getUint32(record, true)).toBe(0x06064b50);
    count = Number(view.getBigUint64(record + 32, true));
    centralSize = Number(view.getBigUint64(record + 40, true));
    centralOffset = Number(view.getBigUint64(record + 48, true));
  }
  const decoder = new TextDecoder();
  const files: ZipFile[] = [];
  let at = centralOffset;
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let offset = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra < extraEnd) {
      const id = view.getUint16(extra, true);
      const length = view.getUint16(extra + 2, true);
      if (id === 0x0001 && offset === 0xffffffff) offset = Number(view.getBigUint64(extra + 4, true));
      extra += 4 + length;
    }
    expect(method).toBe(0);
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    expect(view.getUint32(offset + 14, true)).toBe(crc);
    const dataAt = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const data = zip.slice(dataAt, dataAt + size);
    expect(crc32(data)).toBe(crc);
    files.push({ name, data, crc, offset });
    at = extraEnd + commentLength;
  }
  expect(at).toBe(centralOffset + centralSize);
  return files;
}

/** Info-ZIP's own check, where the computer has it. Returns false when it doesn't. */
export function unzipTest(file: string): boolean {
  const which = Bun.spawnSync(["which", "unzip"]);
  if (which.exitCode !== 0) return false;
  const run = Bun.spawnSync(["unzip", "-t", file]);
  expect(run.stdout.toString()).toContain("No errors detected");
  expect(run.exitCode).toBe(0);
  return true;
}
