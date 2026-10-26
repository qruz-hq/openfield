import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { crc32, createInflateRaw } from "node:zlib";

// Reads a zip from disk without unpacking it (§7.8 canvas archives): the central directory says
// where each entry is, and an entry is streamed straight out of the file, inflated on the way when
// it was deflated. Sizes and checksums come from the central directory, so zips that put them in a
// data descriptor after the data (Finder's Compress, anything written to a pipe) read the same.
// ZIP64 for archives past 4 GB. Entry names never become paths on disk: callers look files up by
// name, so a hostile name can't escape anywhere, but one that tries refuses the whole archive.

export interface ZipFileEntry {
  /** Forward slashes, as written. */
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  /** Bytes once unpacked. */
  size: number;
  localHeaderOffset: number;
}

/** Not a zip this can read, or a damaged entry. The message is detail for the log. */
export class ZipError extends Error {
  override readonly name = "ZipError";
}

const END = 0x06054b50;
const END_SIZE = 22;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const ENCRYPTED = 0x1;
const UTF8_NAMES = 0x800;
/** A comment can push the end record up to 64 KB back from the end. */
const END_SEARCH = END_SIZE + MAX16;
/** A directory this long would list millions of files: not a canvas. */
const CENTRAL_MAX_BYTES = 64 * 1024 * 1024;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

export class ZipArchive {
  private constructor(
    readonly path: string,
    /** Files only, in the order the archive lists them. Folders and Finder's extras are left out. */
    readonly entries: readonly ZipFileEntry[],
  ) {}

  static async open(path: string): Promise<ZipArchive> {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      const read = async (at: number, length: number): Promise<DataView> => {
        if (at < 0 || at + length > size) throw new ZipError("The zip ends too soon");
        const bytes = new Uint8Array(length);
        const { bytesRead } = await file.read(bytes, 0, length, at);
        if (bytesRead !== length) throw new ZipError("The zip ends too soon");
        return new DataView(bytes.buffer);
      };

      const tailLength = Math.min(size, END_SEARCH);
      const tail = await read(size - tailLength, tailLength);
      let end = -1;
      for (let at = tailLength - END_SIZE; at >= 0; at--) {
        if (tail.getUint32(at, true) === END) {
          end = at;
          break;
        }
      }
      if (end < 0) throw new ZipError("No end of central directory record");
      let count = tail.getUint16(end + 10, true);
      let centralSize = tail.getUint32(end + 12, true);
      let centralOffset = tail.getUint32(end + 16, true);

      if (count === MAX16 || centralSize === MAX32 || centralOffset === MAX32) {
        const locatorAt = size - tailLength + end - 20;
        const locator = await read(locatorAt, 20);
        if (locator.getUint32(0, true) !== ZIP64_LOCATOR) throw new ZipError("No ZIP64 locator");
        const recordAt = Number(locator.getBigUint64(8, true));
        const record = await read(recordAt, 56);
        if (record.getUint32(0, true) !== ZIP64_END) throw new ZipError("No ZIP64 end record");
        count = Number(record.getBigUint64(32, true));
        centralSize = Number(record.getBigUint64(40, true));
        centralOffset = Number(record.getBigUint64(48, true));
      }
      if (centralSize > CENTRAL_MAX_BYTES) throw new ZipError("The zip lists too many files");

      const central = await read(centralOffset, centralSize);
      const entries: ZipFileEntry[] = [];
      const names = new Set<string>();
      let at = 0;
      for (let i = 0; i < count; i++) {
        if (at + 46 > centralSize || central.getUint32(at, true) !== CENTRAL) {
          throw new ZipError("The central directory is damaged");
        }
        const flags = central.getUint16(at + 8, true);
        const method = central.getUint16(at + 10, true);
        const crc = central.getUint32(at + 16, true);
        let compressedSize = central.getUint32(at + 20, true);
        let entrySize = central.getUint32(at + 24, true);
        const nameLength = central.getUint16(at + 28, true);
        const extraLength = central.getUint16(at + 30, true);
        const commentLength = central.getUint16(at + 32, true);
        let localHeaderOffset = central.getUint32(at + 42, true);
        const nameStart = at + 46;
        const next = nameStart + nameLength + extraLength + commentLength;
        if (next > centralSize) throw new ZipError("The central directory is damaged");
        const raw = new Uint8Array(central.buffer, nameStart, nameLength);

        // ZIP64 extra: only the fields whose 32-bit slot overflowed are there, in this order.
        let extra = nameStart + nameLength;
        const extraEnd = extra + extraLength;
        while (extra + 4 <= extraEnd) {
          const id = central.getUint16(extra, true);
          const length = central.getUint16(extra + 2, true);
          if (id === 0x0001) {
            let field = extra + 4;
            const take = () => {
              const value = Number(central.getBigUint64(field, true));
              field += 8;
              return value;
            };
            if (entrySize === MAX32) entrySize = take();
            if (compressedSize === MAX32) compressedSize = take();
            if (localHeaderOffset === MAX32) localHeaderOffset = take();
          }
          extra += 4 + length;
        }
        at = next;

        const name = normalName(decodeName(raw, flags));
        if (name === null) continue;
        if (names.has(name)) continue;
        names.add(name);
        entries.push({ name, method, flags, crc32: crc, compressedSize, size: entrySize, localHeaderOffset });
      }
      return new ZipArchive(path, entries);
    } finally {
      await file.close();
    }
  }

  /**
   * One entry's bytes, unpacked. The stream errors with a ZipError when the data doesn't match
   * the checksum and size the archive lists for it, so a damaged entry never lands as an image.
   */
  async open(entry: ZipFileEntry): Promise<ReadableStream<Uint8Array>> {
    if (entry.flags & ENCRYPTED) throw new ZipError(`${entry.name} is encrypted`);
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipError(`${entry.name} is packed in a way this can't read (method ${entry.method})`);
    }
    // The local header's own extra field can differ from the central one, so its length is read here.
    const file = await open(this.path, "r");
    let dataStart: number;
    try {
      const header = new Uint8Array(30);
      const { bytesRead } = await file.read(header, 0, 30, entry.localHeaderOffset);
      const view = new DataView(header.buffer);
      if (bytesRead !== 30 || view.getUint32(0, true) !== LOCAL) {
        throw new ZipError(`${entry.name} has no local header`);
      }
      dataStart = entry.localHeaderOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
    } finally {
      await file.close();
    }
    const packed = Bun.file(this.path).slice(dataStart, dataStart + entry.compressedSize);
    if (packed.size !== entry.compressedSize) throw new ZipError(`${entry.name} ends too soon`);
    const raw = packed.stream();
    const chunks: AsyncIterable<Uint8Array> =
      entry.method === 0 ? raw : Readable.fromWeb(raw as never).pipe(createInflateRaw());
    return toStream(checked(entry, chunks));
  }

  find(name: string): ZipFileEntry | undefined {
    return this.entries.find((entry) => entry.name === name);
  }
}

/** Passes the bytes on, and fails at the end (or as soon as it's too long) when they're not right. */
async function* checked(entry: ZipFileEntry, chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let crc = 0;
  let bytes = 0;
  try {
    for await (const chunk of chunks) {
      bytes += chunk.byteLength;
      // A deflated entry that unpacks past its listed size is damaged, or a zip bomb.
      if (bytes > entry.size) throw new ZipError(`${entry.name} is longer than the archive says`);
      crc = crc32(chunk, crc);
      yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError(`${entry.name} is damaged: ${error instanceof Error ? error.message : error}`);
  }
  if (bytes !== entry.size || crc >>> 0 !== entry.crc32) throw new ZipError(`${entry.name} is damaged`);
}

/** Pulled one chunk at a time, so nothing is read ahead of the reader. */
function toStream(chunks: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

/** Names are UTF-8 when the flag says so; older tools wrote the DOS code page, read here as Latin-1. */
function decodeName(raw: Uint8Array, flags: number): string {
  if (flags & UTF8_NAMES) return new TextDecoder().decode(raw);
  try {
    return utf8.decode(raw);
  } catch {
    return latin1.decode(raw);
  }
}

/**
 * The name to look the entry up by, or null for what isn't a file of the archive's: folders, and
 * the resource forks and Finder files macOS adds. A name that climbs out (`..`) or starts at the
 * root refuses the archive.
 */
export function normalName(name: string): string | null {
  const slashed = name.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed) || slashed.includes("\0")) {
    throw new ZipError(`The zip names a file outside itself: ${name}`);
  }
  const parts = slashed.split("/");
  if (parts.includes("..")) throw new ZipError(`The zip names a file outside itself: ${name}`);
  if (slashed.endsWith("/")) return null;
  if (parts[0] === "__MACOSX") return null;
  const last = parts.at(-1)!;
  if (last === ".DS_Store" || last.startsWith("._")) return null;
  const clean = parts.filter((part) => part !== "" && part !== ".");
  return clean.length ? clean.join("/") : null;
}
