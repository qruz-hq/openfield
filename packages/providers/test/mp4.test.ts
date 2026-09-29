import { describe, expect, test } from "bun:test";
import { VIDEO_SILENT, VIDEO_WITH_SOUND } from "../src/byteplus/__fixtures__/media";
import { childBoxes, looksLikeVideo, probeMp4 } from "../src/mp4";

// The MP4 and QuickTime probe: size, length and sound from the headers, never the media.

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const u32 = (...values: number[]) => {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (const [i, v] of values.entries()) view.setUint32(i * 4, v);
  return out;
};
const text = (s: string) => new TextEncoder().encode(s);

/** A version 1 mvhd (64-bit times), a video trak and a sound trak, in a QuickTime file. */
function syntheticMov(): Uint8Array {
  const mvhd = new Uint8Array(4 + 8 + 8 + 4 + 8 + 80);
  const v = new DataView(mvhd.buffer);
  mvhd[0] = 1;
  v.setUint32(20, 600); // timescale
  v.setBigUint64(24, 3000n); // 5 s
  const tkhd = (w: number, h: number) => {
    const b = new Uint8Array(84);
    new DataView(b.buffer).setUint32(76, w * 65536);
    new DataView(b.buffer).setUint32(80, h * 65536);
    return box("tkhd", b);
  };
  const hdlr = (kind: string) => box("hdlr", u32(0, 0), text(kind), new Uint8Array(12));
  const trak = (kind: string, w: number, h: number) => box("trak", tkhd(w, h), box("mdia", hdlr(kind)));
  return new Uint8Array([
    ...box("ftyp", text("qt  "), u32(0), text("qt  ")),
    ...box("moov", box("mvhd", mvhd), trak("soun", 0, 0), trak("vide", 1920, 1080)),
  ]);
}

describe("probeMp4", () => {
  test("reads the fixtures: 64×36, one second, with and without sound", () => {
    expect(probeMp4(bytes(VIDEO_WITH_SOUND))).toEqual({
      mime: "video/mp4",
      width: 64,
      height: 36,
      durationMs: 1000,
      hasAudio: true,
    });
    expect(probeMp4(bytes(VIDEO_SILENT))?.hasAudio).toBe(false);
  });

  test("QuickTime, 64-bit times, and a sound track listed before the picture", () => {
    expect(probeMp4(syntheticMov())).toEqual({
      mime: "video/quicktime",
      width: 1920,
      height: 1080,
      durationMs: 5000,
      hasAudio: true,
    });
  });

  test("a moov after the media is still found when the bytes hold it", () => {
    const file = bytes(VIDEO_WITH_SOUND);
    const boxes = childBoxes(file);
    const moov = boxes.find((b) => b.type === "moov")!;
    const rest = boxes.filter((b) => b.type !== "moov");
    const moved = new Uint8Array([
      ...rest.flatMap((b) => [...file.subarray(b.start, b.start + b.size)]),
      ...file.subarray(moov.start, moov.start + moov.size),
    ]);
    expect(childBoxes(moved).at(-1)?.type).toBe("moov");
    expect(probeMp4(moved)?.durationMs).toBe(1000);
    // Cut before it: not enough to say.
    expect(probeMp4(moved.subarray(0, moved.length - 10))).toBeNull();
  });

  test("a still image in an ftyp box, and anything else, isn't a video", () => {
    const heic = box("ftyp", text("heic"), u32(0), text("mif1"));
    expect(looksLikeVideo(heic)).toBe(false);
    expect(probeMp4(heic)).toBeNull();
    expect(looksLikeVideo(bytes(VIDEO_SILENT))).toBe(true);
    expect(probeMp4(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(probeMp4(new Uint8Array())).toBeNull();
  });
});
