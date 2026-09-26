import { crc32 } from "node:zlib";

// A streamed zip of stored originals (§2.5 Download). Images are already compressed, so entries
// are stored as they are (method 0), which also means every size and offset is known before the
// first byte goes out: the reply carries a Content-Length and the browser can show progress.
// ZIP64 records are added only when the archive passes 4 GB.

export interface ZipEntry {
  /** The name inside the archive. */
  name: string;
  /** Bytes, as the file on disk has them. */
  size: number;
  /** Shown as the file's date when it's unpacked. */
  modifiedAt: Date;
}

export interface ZipOptions {
  /** Where ZIP64 takes over. Only tests move it, so the ZIP64 path runs without writing 4 GB. */
  zip64From?: number;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const ZIP64_EXTRA = 12;
const END = 22;
const ZIP64_END = 56;
const ZIP64_LOCATOR = 20;
const UTF8_NAMES = 0x0800;
/** Unix, spec 4.5: permissions ride in the high half of the external attributes. */
const MADE_BY = (3 << 8) | 45;
const FILE_MODE = (0o100644 << 16) >>> 0;

const encoder = new TextEncoder();

interface Placed extends ZipEntry {
  nameBytes: Uint8Array;
  offset: number;
  zip64: boolean;
}

export interface ZipPlan {
  entries: Placed[];
  centralOffset: number;
  centralSize: number;
  zip64: boolean;
  /** The whole archive, in bytes. */
  length: number;
}

/** Lays the archive out: where each entry starts, and how long the whole thing is. */
export function planZip(entries: readonly ZipEntry[], opts: ZipOptions = {}): ZipPlan {
  const limit = opts.zip64From ?? MAX32;
  let offset = 0;
  const placed: Placed[] = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const at = { ...entry, nameBytes, offset, zip64: offset >= limit };
    offset += LOCAL_HEADER + nameBytes.length + entry.size;
    return at;
  });
  const centralOffset = offset;
  const centralSize = placed.reduce(
    (sum, e) => sum + CENTRAL_HEADER + e.nameBytes.length + (e.zip64 ? ZIP64_EXTRA : 0),
    0,
  );
  const zip64 = centralOffset >= limit || centralSize >= limit || placed.length >= MAX16;
  return {
    entries: placed,
    centralOffset,
    centralSize,
    zip64,
    length: centralOffset + centralSize + (zip64 ? ZIP64_END + ZIP64_LOCATOR : 0) + END,
  };
}

/**
 * The archive as a stream. `read` is asked for one entry's bytes at a time, only when the reader
 * wants more, so a big download holds about one image in memory.
 */
export function zipStream(
  plan: ZipPlan,
  read: (index: number) => Promise<Uint8Array>,
  onError?: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const crcs: number[] = [];
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (next < plan.entries.length) {
          const entry = plan.entries[next]!;
          const data = await read(next);
          if (data.byteLength !== entry.size) {
            throw new Error(`${entry.name} changed size while it was being packed`);
          }
          const crc = crc32(data);
          crcs.push(crc);
          controller.enqueue(localHeader(entry, crc));
          controller.enqueue(data);
          next++;
          return;
        }
        controller.enqueue(centralDirectory(plan, crcs));
        controller.close();
      } catch (error) {
        onError?.(error);
        controller.error(error);
      }
    },
  });
}

function dosTime(at: Date): { time: number; date: number } {
  // DOS dates start in 1980 and carry local time, which is what an unzip tool shows.
  const year = Math.min(2107, Math.max(1980, at.getFullYear()));
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

const versionNeeded = (entry: Placed) => (entry.zip64 ? 45 : 20);

function localHeader(entry: Placed, crc: number): Uint8Array {
  const out = new Uint8Array(LOCAL_HEADER + entry.nameBytes.length);
  const view = new DataView(out.buffer);
  const { time, date } = dosTime(entry.modifiedAt);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, versionNeeded(entry), true);
  view.setUint16(6, UTF8_NAMES, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, entry.size, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, entry.nameBytes.length, true);
  view.setUint16(28, 0, true);
  out.set(entry.nameBytes, LOCAL_HEADER);
  return out;
}

function centralDirectory(plan: ZipPlan, crcs: readonly number[]): Uint8Array {
  const out = new Uint8Array(plan.length - plan.centralOffset);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [i, entry] of plan.entries.entries()) {
    const { time, date } = dosTime(entry.modifiedAt);
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, MADE_BY, true);
    view.setUint16(at + 6, versionNeeded(entry), true);
    view.setUint16(at + 8, UTF8_NAMES, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, time, true);
    view.setUint16(at + 14, date, true);
    view.setUint32(at + 16, crcs[i]!, true);
    view.setUint32(at + 20, entry.size, true);
    view.setUint32(at + 24, entry.size, true);
    view.setUint16(at + 28, entry.nameBytes.length, true);
    view.setUint16(at + 30, entry.zip64 ? ZIP64_EXTRA : 0, true);
    view.setUint16(at + 32, 0, true);
    view.setUint16(at + 34, 0, true);
    view.setUint16(at + 36, 0, true);
    view.setUint32(at + 38, FILE_MODE, true);
    view.setUint32(at + 42, entry.zip64 ? MAX32 : entry.offset, true);
    out.set(entry.nameBytes, at + CENTRAL_HEADER);
    at += CENTRAL_HEADER + entry.nameBytes.length;
    if (entry.zip64) {
      // Only the offset overflowed, so the extra holds only the offset (spec 4.5.3).
      view.setUint16(at, 0x0001, true);
      view.setUint16(at + 2, 8, true);
      view.setBigUint64(at + 4, BigInt(entry.offset), true);
      at += ZIP64_EXTRA;
    }
  }

  const count = plan.entries.length;
  if (plan.zip64) {
    const recordAt = plan.centralOffset + plan.centralSize;
    view.setUint32(at, 0x06064b50, true);
    view.setBigUint64(at + 4, BigInt(ZIP64_END - 12), true);
    view.setUint16(at + 12, MADE_BY, true);
    view.setUint16(at + 14, 45, true);
    view.setUint32(at + 16, 0, true);
    view.setUint32(at + 20, 0, true);
    view.setBigUint64(at + 24, BigInt(count), true);
    view.setBigUint64(at + 32, BigInt(count), true);
    view.setBigUint64(at + 40, BigInt(plan.centralSize), true);
    view.setBigUint64(at + 48, BigInt(plan.centralOffset), true);
    at += ZIP64_END;
    view.setUint32(at, 0x07064b50, true);
    view.setUint32(at + 4, 0, true);
    view.setBigUint64(at + 8, BigInt(recordAt), true);
    view.setUint32(at + 16, 1, true);
    at += ZIP64_LOCATOR;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, plan.zip64 ? MAX16 : count, true);
  view.setUint16(at + 10, plan.zip64 ? MAX16 : count, true);
  view.setUint32(at + 12, plan.zip64 ? MAX32 : plan.centralSize, true);
  view.setUint32(at + 16, plan.zip64 ? MAX32 : plan.centralOffset, true);
  view.setUint16(at + 20, 0, true);
  return out;
}
