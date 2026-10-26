import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { normalName, ZipArchive, ZipError } from "../src/files/unzip";
import { planZip, zipStream } from "../src/files/zip";

// Reading zips (§7.8 canvas archives): our own stored ones, deflated ones from the zip tool and
// from Finder's Compress (sizes in a data descriptor after the data), ZIP64, and the names that
// must never be trusted.

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openfield-unzip-"));
  scratch.push(dir);
  return dir;
}

function onDisk(bytes: Uint8Array, name = "test.zip"): string {
  const file = join(tempDir(), name);
  writeFileSync(file, bytes);
  return file;
}

const encoder = new TextEncoder();
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
/** Compresses well, so deflate actually shrinks it. */
const text = (n: number) => encoder.encode("a lighthouse at dusk ".repeat(n));

async function ours(files: { name: string; data: Uint8Array }[], zip64From?: number): Promise<string> {
  const plan = planZip(
    files.map((f) => ({ name: f.name, size: f.data.byteLength, modifiedAt: new Date(2026, 9, 1) })),
    zip64From === undefined ? {} : { zip64From },
  );
  const body = new Uint8Array(await new Response(zipStream(plan, async (i) => files[i]!.data)).arrayBuffer());
  return onDisk(body);
}

interface Raw {
  name: string;
  data: Uint8Array;
  /** Override what the central directory says, to fake damage. */
  crc?: number;
  size?: number;
  flags?: number;
  method?: number;
}

/**
 * A zip the way Finder (and anything writing to a pipe) makes one: deflated, with the local header's
 * sizes and checksum left at zero and written after the data in a descriptor.
 */
function descriptorZip(files: Raw[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = encoder.encode(f.name);
    const method = f.method ?? 8;
    const packed = method === 8 ? new Uint8Array(deflateRawSync(f.data)) : f.data;
    const crc = f.crc ?? crc32(f.data);
    const size = f.size ?? f.data.byteLength;
    const flags = f.flags ?? 0x0808;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint16(26, name.byteLength, true);
    const descriptor = new DataView(new ArrayBuffer(16));
    descriptor.setUint32(0, 0x08074b50, true);
    descriptor.setUint32(4, crc, true);
    descriptor.setUint32(8, packed.byteLength, true);
    descriptor.setUint32(12, size, true);
    parts.push(new Uint8Array(local.buffer), name, packed, new Uint8Array(descriptor.buffer));

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, (3 << 8) | 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, flags, true);
    entry.setUint16(10, method, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, packed.byteLength, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.byteLength, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.byteLength + packed.byteLength + 16;
  }
  const centralSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function readAll(zip: ZipArchive): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const entry of zip.entries) {
    out[entry.name] = new Uint8Array(await new Response(await zip.open(entry)).arrayBuffer());
  }
  return out;
}

const hasTool = (tool: string) => Bun.spawnSync(["which", tool]).exitCode === 0;

describe("the zip reader", () => {
  test("reads back what our writer packs, including an empty file", async () => {
    const files = [
      { name: "canvas.json", data: encoder.encode('{"a":1}') },
      { name: "assets/one.png", data: bytes(70_000, 1) },
      { name: "assets/empty.png", data: new Uint8Array() },
    ];
    const zip = await ZipArchive.open(await ours(files));
    expect(zip.entries.map((e) => [e.name, e.method])).toEqual([
      ["canvas.json", 0],
      ["assets/one.png", 0],
      ["assets/empty.png", 0],
    ]);
    expect(await readAll(zip)).toEqual(Object.fromEntries(files.map((f) => [f.name, f.data])));
  });

  test("follows ZIP64 records to entries past the 32-bit limit", async () => {
    const files = [0, 1, 2].map((i) => ({ name: `f${i}.bin`, data: bytes(600, i) }));
    // Our writer moves ZIP64 down to 500 bytes for tests, so the later entries need it.
    const zip = await ZipArchive.open(await ours(files, 500));
    expect(await readAll(zip)).toEqual(Object.fromEntries(files.map((f) => [f.name, f.data])));
  });

  test("reads a deflated zip whose sizes come after the data, as Finder writes them", async () => {
    const files = [
      { name: "Lighthouse.ofcanvas/canvas.json", data: text(40) },
      { name: "Lighthouse.ofcanvas/assets/one.png", data: bytes(5_000, 3) },
      { name: "__MACOSX/Lighthouse.ofcanvas/._canvas.json", data: bytes(80, 4) },
      { name: "Lighthouse.ofcanvas/.DS_Store", data: bytes(20, 5) },
      { name: "Lighthouse.ofcanvas/assets/", data: new Uint8Array() },
    ];
    const zip = await ZipArchive.open(onDisk(descriptorZip(files)));
    // Finder's extras and folders aren't files of the archive.
    expect(zip.entries.map((e) => e.name)).toEqual([
      "Lighthouse.ofcanvas/canvas.json",
      "Lighthouse.ofcanvas/assets/one.png",
    ]);
    expect(zip.entries[0]!.method).toBe(8);
    expect(zip.entries[0]!.flags & 0x8).toBe(0x8);
    const read = await readAll(zip);
    expect(read["Lighthouse.ofcanvas/canvas.json"]).toEqual(files[0]!.data);
    expect(read["Lighthouse.ofcanvas/assets/one.png"]).toEqual(files[1]!.data);
  });

  test("reads zips made by the zip tool, deflated, to a file and through a pipe", async () => {
    if (!hasTool("zip")) return;
    const dir = tempDir();
    mkdirSync(join(dir, "Lighthouse", "assets"), { recursive: true });
    writeFileSync(join(dir, "Lighthouse", "canvas.json"), text(50));
    writeFileSync(join(dir, "Lighthouse", "assets", "one.png"), bytes(3_000, 7));
    const toFile = join(dir, "file.zip");
    expect(Bun.spawnSync(["zip", "-q", "-r", toFile, "Lighthouse"], { cwd: dir }).exitCode).toBe(0);
    // Written to a pipe, zip can't go back to fill in the sizes, so it uses data descriptors.
    const piped = Bun.spawnSync(["zip", "-q", "-r", "-", "Lighthouse"], { cwd: dir });
    expect(piped.exitCode).toBe(0);
    const toPipe = onDisk(new Uint8Array(piped.stdout), "pipe.zip");
    for (const path of [toFile, toPipe]) {
      const read = await readAll(await ZipArchive.open(path));
      expect(read["Lighthouse/canvas.json"]).toEqual(text(50));
      expect(read["Lighthouse/assets/one.png"]).toEqual(bytes(3_000, 7));
    }
    const pipeZip = await ZipArchive.open(toPipe);
    expect(pipeZip.find("Lighthouse/canvas.json")!.flags & 0x8).toBe(0x8);
  });

  test("reads what macOS's ditto makes, the way Finder's Compress does", async () => {
    if (process.platform !== "darwin" || !hasTool("ditto")) return;
    const dir = tempDir();
    mkdirSync(join(dir, "Lighthouse", "assets"), { recursive: true });
    writeFileSync(join(dir, "Lighthouse", "canvas.json"), text(50));
    writeFileSync(join(dir, "Lighthouse", "assets", "one.png"), bytes(3_000, 8));
    const out = join(dir, "finder.zip");
    const run = Bun.spawnSync([
      "ditto",
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      join(dir, "Lighthouse"),
      out,
    ]);
    expect(run.exitCode).toBe(0);
    const read = await readAll(await ZipArchive.open(out));
    expect(read["Lighthouse/canvas.json"]).toEqual(text(50));
    expect(read["Lighthouse/assets/one.png"]).toEqual(bytes(3_000, 8));
  });

  test("names in UTF-8 read as written", async () => {
    const zip = await ZipArchive.open(
      onDisk(descriptorZip([{ name: "Café ☕/canvas.json", data: text(2) }])),
    );
    expect(zip.entries.map((e) => e.name)).toEqual(["Café ☕/canvas.json"]);
  });

  test("a damaged entry fails as it's read, and never passes as good bytes", async () => {
    const data = text(30);
    const zip = await ZipArchive.open(
      onDisk(
        descriptorZip([
          { name: "bad-crc.txt", data, crc: (crc32(data) + 1) >>> 0 },
          { name: "too-long.txt", data, size: data.byteLength - 10 },
          { name: "too-short.txt", data, size: data.byteLength + 10 },
        ]),
      ),
    );
    for (const entry of zip.entries) {
      await expect(new Response(await zip.open(entry)).arrayBuffer()).rejects.toBeInstanceOf(ZipError);
    }
  });

  test("encrypted entries and unknown packing are refused", async () => {
    const zip = await ZipArchive.open(
      onDisk(
        descriptorZip([
          { name: "secret.txt", data: text(3), flags: 0x0809 },
          { name: "bzip.txt", data: text(3), method: 12 },
        ]),
      ),
    );
    for (const entry of zip.entries) await expect(zip.open(entry)).rejects.toBeInstanceOf(ZipError);
  });

  test("a name that climbs out of the archive refuses it", async () => {
    for (const name of [
      "../evil.png",
      "assets/../../evil.png",
      "/etc/evil",
      "C:\\evil.png",
      "a\\..\\..\\evil",
    ]) {
      await expect(ZipArchive.open(onDisk(descriptorZip([{ name, data: text(1) }])))).rejects.toBeInstanceOf(
        ZipError,
      );
    }
  });

  test("not a zip, or one cut short, is a ZipError", async () => {
    await expect(ZipArchive.open(onDisk(text(100)))).rejects.toBeInstanceOf(ZipError);
    const whole = descriptorZip([{ name: "a.txt", data: text(10) }]);
    await expect(ZipArchive.open(onDisk(whole.slice(0, whole.byteLength - 30)))).rejects.toBeInstanceOf(
      ZipError,
    );
  });

  test("normalName drops what isn't the archive's and tidies the rest", () => {
    expect(normalName("a/./b//c.png")).toBe("a/b/c.png");
    expect(normalName("dir/")).toBeNull();
    expect(normalName("__MACOSX/a/._b")).toBeNull();
    expect(normalName("a/._b.png")).toBeNull();
    expect(normalName("a\\b.png")).toBe("a/b.png");
    expect(() => normalName("..")).toThrow(ZipError);
  });
});
