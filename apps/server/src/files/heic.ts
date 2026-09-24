import { rmSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@openfield/core";
import type SharpModule from "sharp";

// HEIC to PNG for uploads (§8.5.1). The sharp that ships reads AVIF but not HEVC, which is what
// every iPhone photo is, so the operating system's own converter does it where there is one: sips
// on macOS, libheif's heif-dec or heif-convert where installed. Nothing is downloaded or bundled.

const SIPS = "/usr/bin/sips";
/** A converter that hasn't finished by then is stuck on the file; the upload shouldn't hang with it. */
const CONVERT_TIMEOUT_MS = 30_000;

type Converter = (input: string, output: string) => string[];

/** Command lines that turn a HEIC file into a PNG file, in the order they're tried. */
function converters(): Converter[] {
  const out: Converter[] = [];
  if (process.platform === "darwin" && Bun.file(SIPS).size > 0) {
    out.push((input, output) => [SIPS, "-s", "format", "png", input, "--out", output]);
  }
  for (const name of ["heif-dec", "heif-convert"]) {
    const found = Bun.which(name);
    if (found) out.push((input, output) => [found, input, output]);
  }
  return out;
}

async function viaSharp(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const sharp = (await import("sharp")).default;
    return new Uint8Array(await sharp(bytes).rotate().png().toBuffer());
  } catch {
    return null;
  }
}

async function viaCommand(
  bytes: Uint8Array,
  tmpDir: string,
  command: Converter,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  const id = newId();
  const input = join(tmpDir, `${id}.heic`);
  const output = join(tmpDir, `${id}.png`);
  try {
    await Bun.write(input, bytes);
    const proc = Bun.spawn(command(input, output), { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const code = await proc.exited.finally(() => clearTimeout(timer));
    const file = Bun.file(output);
    if (code !== 0 || !(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  } finally {
    rmSync(input, { force: true });
    rmSync(output, { force: true });
  }
}

export type HeicResult =
  | { ok: true; png: Uint8Array }
  /** Nothing on this computer reads HEIC. */
  | { ok: false; reason: "no_converter" }
  /** Something does, and it couldn't read this file: it's damaged, or not really a photo. */
  | { ok: false; reason: "unreadable" };

/** The photo as PNG bytes, or why not. */
export async function heicToPng(
  bytes: Uint8Array,
  tmpDir: string,
  timeoutMs = CONVERT_TIMEOUT_MS,
): Promise<HeicResult> {
  const png = await viaSharp(bytes);
  if (png) return { ok: true, png };
  const commands = converters();
  if (!commands.length) return { ok: false, reason: "no_converter" };
  for (const command of commands) {
    const converted = await viaCommand(bytes, tmpDir, command, timeoutMs);
    if (converted) return { ok: true, png: converted };
  }
  return { ok: false, reason: "unreadable" };
}

/** True when this computer has something that reads HEIC beyond sharp. */
export const canConvertHeic = (): boolean => converters().length > 0;

/**
 * A PNG made smaller until it's at most `maxBytes`, or null when it can't be (no sharp, or still
 * too big after a few tries). A 48 MP phone photo is well over any model's limit as PNG.
 */
export async function shrinkPng(png: Uint8Array, maxBytes: number): Promise<Uint8Array | null> {
  if (png.byteLength <= maxBytes) return png;
  let sharp: typeof SharpModule;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return null;
  }
  const meta = await sharp(png).metadata();
  let width = meta.width;
  let out = png;
  for (let tries = 0; tries < 4 && out.byteLength > maxBytes && width; tries++) {
    // Bytes grow with area, so the side shrinks by the square root, with room to spare.
    width = Math.max(1, Math.floor(width * Math.sqrt(maxBytes / out.byteLength) * 0.9));
    out = new Uint8Array(await sharp(png).resize({ width }).png({ compressionLevel: 9 }).toBuffer());
  }
  return out.byteLength <= maxBytes ? out : null;
}
