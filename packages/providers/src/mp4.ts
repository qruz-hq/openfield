// What an MP4 or QuickTime file holds, from its boxes: the container type, the picture's size, how
// long it runs and whether it has sound. Pure, so the server's ingest path and the test asset store
// read videos the same way. It reads the headers only (ftyp, moov/mvhd, trak/tkhd, mdia/hdlr),
// never the media itself.

export interface ProbedVideo {
  mime: "video/mp4" | "video/quicktime";
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
}

export interface Mp4Box {
  type: string;
  /** Where the box starts, from the start of the bytes it was read from. */
  start: number;
  /** The whole box, header included. Runs to the end of the file when the header says 0. */
  size: number;
  headerSize: number;
}

// Brands a HEIF still image uses: an ftyp box alone doesn't make a file a video.
const IMAGE_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
  "avif",
  "avis",
]);

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

/**
 * The box header at `at`, or null when there isn't a whole one. `end` is where the parent ends,
 * for a box whose size is 0 ("to the end").
 */
export function readBoxHeader(bytes: Uint8Array, at: number, end = bytes.length): Mp4Box | null {
  if (at + 8 > end) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(at);
  const type = ascii(bytes, at + 4, 4);
  let headerSize = 8;
  if (size === 1) {
    if (at + 16 > end) return null;
    size = Number(view.getBigUint64(at + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = end - at;
  }
  if (size < headerSize) return null;
  return { type, start: at, size, headerSize };
}

/** The boxes directly inside [from, to), in order. Stops at the first header that doesn't fit. */
export function childBoxes(bytes: Uint8Array, from = 0, to = bytes.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let at = from;
  while (at < to) {
    const box = readBoxHeader(bytes, at, to);
    if (!box) break;
    boxes.push(box);
    at += box.size;
  }
  return boxes;
}

/**
 * The container type from an ftyp box's payload, or null for a still image (HEIF, AVIF) or a file
 * whose major brand says neither.
 */
export function videoMimeOfBrand(ftypPayload: Uint8Array): ProbedVideo["mime"] | null {
  if (ftypPayload.length < 4) return null;
  const major = ascii(ftypPayload, 0, 4);
  if (IMAGE_BRANDS.has(major)) return null;
  return major === "qt  " ? "video/quicktime" : "video/mp4";
}

/** Reads a moov box's payload: the picture's size from its video track, duration and sound. */
export function probeMoov(moov: Uint8Array, mime: ProbedVideo["mime"]): ProbedVideo | null {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  let durationMs = 0;
  let width = 0;
  let height = 0;
  let hasAudio = false;

  for (const box of childBoxes(moov)) {
    const body = box.start + box.headerSize;
    if (box.type === "mvhd") {
      // version 0: 32-bit times; version 1: 64-bit.
      const version = moov[body]!;
      const timescale = view.getUint32(body + (version === 1 ? 20 : 12));
      const duration = version === 1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16);
      if (timescale > 0) durationMs = Math.round((duration / timescale) * 1000);
    }
    if (box.type !== "trak") continue;
    let handler = "";
    let trackWidth = 0;
    let trackHeight = 0;
    for (const part of childBoxes(moov, body, box.start + box.size)) {
      const partBody = part.start + part.headerSize;
      if (part.type === "tkhd") {
        // Width and height are the last 8 bytes, 16.16 fixed point.
        const end = part.start + part.size;
        trackWidth = Math.round(view.getUint32(end - 8) / 65536);
        trackHeight = Math.round(view.getUint32(end - 4) / 65536);
      }
      if (part.type === "mdia") {
        const hdlr = childBoxes(moov, partBody, part.start + part.size).find((b) => b.type === "hdlr");
        if (hdlr) handler = ascii(moov, hdlr.start + hdlr.headerSize + 8, 4);
      }
    }
    if (handler === "soun") hasAudio = true;
    if (handler === "vide" && trackWidth > 0 && trackHeight > 0 && width === 0) {
      width = trackWidth;
      height = trackHeight;
    }
  }
  if (!width || !height) return null;
  return { mime, width, height, durationMs, hasAudio };
}

/**
 * A whole file, or enough of it to hold ftyp and moov. Null when it isn't a video, or its moov
 * isn't in these bytes (a file that keeps it at the end needs probing from disk: see the server's
 * probeVideoFile).
 */
export function probeMp4(bytes: Uint8Array): ProbedVideo | null {
  const boxes = childBoxes(bytes);
  const ftyp = boxes[0];
  if (ftyp?.type !== "ftyp") return null;
  const mime = videoMimeOfBrand(bytes.subarray(ftyp.start + ftyp.headerSize, ftyp.start + ftyp.size));
  if (!mime) return null;
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov || moov.start + moov.size > bytes.length) return null;
  return probeMoov(bytes.subarray(moov.start + moov.headerSize, moov.start + moov.size), mime);
}

/** Starts like an MP4 or QuickTime video: an ftyp box whose brand isn't a still image's. */
export function looksLikeVideo(head: Uint8Array): boolean {
  if (head.length < 12 || ascii(head, 4, 4) !== "ftyp") return false;
  return videoMimeOfBrand(head.subarray(8, 12)) !== null;
}
