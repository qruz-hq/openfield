import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Renders the desktop app's icons from the aperture mark, then lets the Tauri CLI cut the platform set.
//
//   bun run desktop:icons
//
// Writes, all committed:
//   apps/desktop/src-tauri/icons/app-icon.svg, app-icon-1024.png   the source icon
//   apps/desktop/src-tauri/icons/{32x32,128x128,...}.png, icon.icns, icon.ico   via `tauri icon`
//   apps/desktop/src-tauri/icons/generating/frame-00.png ... frame-23.png   the busy animation
//   apps/desktop/src-tauri/icons/generating-macos/frame-00.png ...   the same, as macOS 26 draws it
//
// The busy frames turn the mark a quarter turn. It has four identical petals, so a quarter turn
// lands exactly where it started and the loop is seamless. A bone glow behind the mark breathes
// once per loop and is zero on frame 0, so frame 0 is the resting icon and the app settles on it.
//
// macOS 26 doesn't show an app's icon as drawn: the Dock and Finder give it a glass rim, a squarer
// corner and shaded petals. An icon the app sets while running is shown as is, so flat frames
// would jump from the resting icon. generating-macos/ holds every frame put through that same
// treatment, by asking macOS for the icon of a throwaway app bundle per frame, so frame 0 is
// pixel for pixel the Dock's resting icon. The app uses it on macOS 26 and later (busy_icon.rs).
// It can only be made on macOS 26 or later, in the Default icon style the app animates in.
// generating-macos/source.sha256 records the app-icon.svg it was made from. Elsewhere this script
// leaves the folder as it is, and refuses to touch anything if the icon has changed since, so the
// two sets can't drift apart (desktop-icons.test.ts checks the same).

const ROOT = resolve(import.meta.dir, "..");
const ICONS = join(ROOT, "apps/desktop/src-tauri/icons");
const FRAMES_DIR = join(ICONS, "generating");

// sharp is a server dependency; resolve it from there rather than adding it to the root.
interface SharpImage {
  png: () => SharpImage;
  raw: () => SharpImage;
  composite: (layers: { input: Buffer; blend: "dest-out" | "atop" }[]) => SharpImage;
  toBuffer: () => Promise<Buffer>;
}
type SharpFn = (input: Buffer, options?: { density?: number }) => SharpImage;
const sharp = (await import(Bun.resolveSync("sharp", join(ROOT, "apps/server")))).default as SharpFn;

const BONE = "#E9E3D8";
const INK = "#0E1012";

// Logo C ("rebuilt"): four identical capsules, exact 4-fold symmetry about (28, 28) in a 56 box.
const PETALS = [
  "M9.595 28.276L16.92 17.778A3.911 3.911 0 0 1 23.334 22.254L16.009 32.751A3.911 3.911 0 0 1 9.595 28.276Z",
  "M27.724 9.595L38.222 16.92A3.911 3.911 0 0 1 33.746 23.334L23.249 16.009A3.911 3.911 0 0 1 27.724 9.595Z",
  "M46.405 27.724L39.08 38.222A3.911 3.911 0 0 1 32.666 33.746L39.991 23.249A3.911 3.911 0 0 1 46.405 27.724Z",
  "M28.276 46.405L17.778 39.08A3.911 3.911 0 0 1 22.254 32.666L32.751 39.991A3.911 3.911 0 0 1 28.276 46.405Z",
];

// Geometry in a 1024 canvas, following Apple's icon grid: an 824 rounded square, radius 185.
const CANVAS = 1024;
const SQUARE = 824;
const RADIUS = 185;
const INSET = (CANVAS - SQUARE) / 2;
// The 56-unit mark box drawn at 600px puts the petals (38.14 units across) at about 409px, half the
// square. Rotated, the farthest petal tip stays about 270px from the center, well inside the square.
const MARK_BOX = 600;

const FRAME_COUNT = 24;
const FRAME_SIZE = 256;

/**
 * The icon, or one part of it: `glow` is only the glow (transparent elsewhere), `mark` only the
 * petals. The macOS frames are put together from those parts (see the end of this file).
 */
function iconSvg({
  angle = 0,
  glow = 0,
  only,
}: {
  angle?: number;
  glow?: number;
  only?: "glow" | "mark";
} = {}): string {
  const c = CANVAS / 2;
  const scale = MARK_BOX / 56;
  const mark = `translate(${c} ${c}) rotate(${angle}) scale(${scale}) translate(-28 -28)`;
  const petals = PETALS.map((d) => `<path d="${d}"/>`).join("");
  // The blur sits on an unrotated wrapper: on a rotated group librsvg rotates the filter region too
  // and the blur comes out streaked.
  const glowLayer =
    glow > 0
      ? `<g clip-path="url(#sq)">
    <circle cx="${c}" cy="${c}" r="${SQUARE * 0.42}" fill="url(#halo)" opacity="${glow.toFixed(3)}"/>
    <g filter="url(#soft)" opacity="${(glow * 0.6).toFixed(3)}"><g transform="${mark}" fill="${BONE}">${petals}</g></g>
  </g>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <title>Openfield</title>
  <defs>
    <clipPath id="sq"><rect x="${INSET}" y="${INSET}" width="${SQUARE}" height="${SQUARE}" rx="${RADIUS}"/></clipPath>
    <radialGradient id="halo">
      <stop offset="0" stop-color="${BONE}" stop-opacity="0.4"/>
      <stop offset="0.55" stop-color="${BONE}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="${BONE}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="34"/></filter>
  </defs>
  ${
    only
      ? ""
      : `<rect x="${INSET}" y="${INSET}" width="${SQUARE}" height="${SQUARE}" rx="${RADIUS}" fill="${INK}"/>
  <rect x="${INSET + 2}" y="${INSET + 2}" width="${SQUARE - 4}" height="${SQUARE - 4}" rx="${RADIUS - 2}" fill="none" stroke="${BONE}" stroke-opacity="0.08" stroke-width="4"/>`
  }
  ${only === "mark" ? "" : glowLayer}
  ${only === "glow" ? "" : `<g transform="${mark}" fill="${BONE}">${petals}</g>`}
</svg>
`;
}

// Clockwise, constant speed so the loop has no seam; the glow eases in and out with sin².
const frameAngle = (i: number) => (90 * i) / FRAME_COUNT;
const frameGlow = (i: number) => Math.sin((Math.PI * i) / FRAME_COUNT) ** 2;

/** The plate's colour just inside a frame's top-left corner, as "r,g,b". */
async function plateColour(png: Buffer): Promise<string> {
  const raw = await sharp(png).raw().toBuffer();
  const at = (FRAME_SIZE / 4) * FRAME_SIZE + FRAME_SIZE / 4;
  return [...raw.subarray(at * 4, at * 4 + 3)].join(",");
}

async function render(svg: string, size: number): Promise<Buffer> {
  // density scales the 1024 SVG so it rasterises at the target size directly, keeping edges crisp.
  const density = Math.round((72 * size) / CANVAS);
  return sharp(Buffer.from(svg), { density }).png().toBuffer();
}

const MACOS_DIR = join(ICONS, "generating-macos");
const SOURCE_HASH = join(MACOS_DIR, "source.sha256");
const appIcon = iconSvg();
const appIconHash = createHash("sha256").update(appIcon).digest("hex");

// Checked before anything is written: either generating-macos/ can be made here, or it already
// matches the icon about to be written.
const makeMacos = macosMajor() >= 26;
if (makeMacos) {
  const style = Bun.spawnSync(["defaults", "read", "-g", "AppleIconAppearanceTheme"])
    .stdout.toString()
    .trim();
  // Unset or RegularLight is Default; keep in step with is_default_icon_style in busy_icon.rs.
  if (style !== "" && style !== "RegularLight") {
    throw new Error(
      `The icon style here is ${style}. Set System Settings > Appearance > Icon & widget style to Default, then run this again.`,
    );
  }
} else {
  const made = (() => {
    try {
      return readFileSync(SOURCE_HASH, "utf8").trim();
    } catch {
      return null;
    }
  })();
  if (made !== appIconHash) {
    throw new Error(
      "The icon changed, and generating-macos/ can only be made on macOS 26 or later. Run this there so both busy sets show the new icon.",
    );
  }
}

mkdirSync(FRAMES_DIR, { recursive: true });

writeFileSync(join(ICONS, "app-icon.svg"), appIcon);
writeFileSync(join(ICONS, "app-icon-1024.png"), await render(appIcon, CANVAS));

for (const name of readdirSync(FRAMES_DIR)) {
  if (name.startsWith("frame-")) rmSync(join(FRAMES_DIR, name));
}
for (let i = 0; i < FRAME_COUNT; i++) {
  const angle = frameAngle(i);
  const glow = frameGlow(i);
  const file = join(FRAMES_DIR, `frame-${String(i).padStart(2, "0")}.png`);
  writeFileSync(file, await render(iconSvg({ angle, glow }), FRAME_SIZE));
}

// The platform set (icns, ico, the PNG sizes). Mobile folders are not used by a desktop-only app.
const cli = Bun.spawnSync(
  ["bun", "run", "--cwd", "apps/desktop", "tauri", "icon", join(ICONS, "app-icon-1024.png"), "-o", ICONS],
  { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
);
if (cli.exitCode !== 0) throw new Error("`tauri icon` failed, see the output above.");
for (const dir of ["android", "ios"]) rmSync(join(ICONS, dir), { recursive: true, force: true });

console.log(`Wrote the app icon and ${FRAME_COUNT} busy frames to ${ICONS}`);

// Draws the icon of each app bundle given as macOS shows it, `size` pixels square:
//   treat <size> <app> <out.png> [<app> <out.png> ...]
const TREAT_SWIFT = `import AppKit
let args = Array(CommandLine.arguments.dropFirst())
let size = Int(args[0])!
for pair in stride(from: 1, to: args.count, by: 2) {
  let icon = NSWorkspace.shared.icon(forFile: args[pair])
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = NSSize(width: size, height: size)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  icon.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[pair + 1]))
}
`;

function macosMajor(): number {
  if (process.platform !== "darwin") return 0;
  const out = Bun.spawnSync(["sw_vers", "-productVersion"]).stdout.toString();
  return Number.parseInt(out, 10) || 0;
}

function must(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${cmd[0]} failed, see the output above.`);
}

/** A bare app bundle with this icon. It needs an executable, or macOS badges the icon as broken. */
function bundleWith(icns: string, dir: string, name: string): string {
  const app = join(dir, `${name}.app`);
  mkdirSync(join(app, "Contents/Resources"), { recursive: true });
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  copyFileSync(icns, join(app, "Contents/Resources/icon.icns"));
  copyFileSync("/usr/bin/true", join(app, "Contents/MacOS/probe"));
  writeFileSync(
    join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIdentifier</key><string>dev.openfield.icon-probe.${name}</string>
</dict></plist>
`,
  );
  return app;
}

if (!makeMacos) {
  console.log("Left generating-macos/ as it is: macOS 26 or later makes it.");
} else {
  // Fresh paths every run, so macOS's icon cache can't hand back an older frame.
  const work = mkdtempSync(join(tmpdir(), "openfield-icons-"));
  try {
    const treat = join(work, "treat");
    writeFileSync(join(work, "treat.swift"), TREAT_SWIFT);
    must(["swiftc", "-O", join(work, "treat.swift"), "-o", treat]);

    const pairs: string[] = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const name = `frame-${String(i).padStart(2, "0")}`;
      // Frame 0 is the resting icon: the very icns the app ships.
      let icns = join(ICONS, "icon.icns");
      if (i > 0) {
        // Without the glow: it's added afterwards, see below.
        const svg = iconSvg({ angle: frameAngle(i) });
        const set = join(work, `${name}.iconset`);
        mkdirSync(set);
        for (const [file, size] of [
          ["icon_256x256.png", 256],
          ["icon_256x256@2x.png", 512],
          ["icon_512x512.png", 512],
          ["icon_512x512@2x.png", 1024],
        ] as const) {
          writeFileSync(join(set, file), await render(svg, size));
        }
        icns = join(work, `${name}.icns`);
        must(["iconutil", "-c", "icns", set, "-o", icns]);
      }
      pairs.push(bundleWith(icns, work, name), join(work, `${name}.png`));
    }
    must([treat, String(FRAME_SIZE), ...pairs]);

    // macOS puts some icons on a lighter grey plate instead of their own: here, any frame whose glow
    // is between about 0.1 and 0.43, which made the Dock flash grey twice per turn. So macOS only
    // ever sees the glow-free icon, which always keeps its plate, and the glow goes on afterwards
    // behind the petals, as in the flat frames. macOS keeps the icon's geometry (same square, same
    // petals), so the flat glow lines up. Checked here so a future macOS can't bring the flash back.
    const plate = await plateColour(readFileSync(join(work, "frame-00.png")));
    const frames: Buffer[] = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const name = `frame-${String(i).padStart(2, "0")}`;
      const treated = readFileSync(join(work, `${name}.png`));
      const got = await plateColour(treated);
      if (got !== plate) throw new Error(`macOS drew ${name} on a different plate (${got}, not ${plate}).`);
      const glow = frameGlow(i);
      if (glow === 0) {
        // Through sharp, so the files are compressed like the flat ones.
        frames.push(await sharp(treated).png().toBuffer());
        continue;
      }
      const angle = frameAngle(i);
      const behindPetals = await sharp(await render(iconSvg({ angle, glow, only: "glow" }), FRAME_SIZE))
        .composite([{ input: await render(iconSvg({ angle, only: "mark" }), FRAME_SIZE), blend: "dest-out" }])
        .png()
        .toBuffer();
      frames.push(
        await sharp(treated)
          .composite([{ input: behindPetals, blend: "atop" }])
          .png()
          .toBuffer(),
      );
    }

    rmSync(MACOS_DIR, { recursive: true, force: true });
    mkdirSync(MACOS_DIR, { recursive: true });
    for (const [i, frame] of frames.entries()) {
      writeFileSync(join(MACOS_DIR, `frame-${String(i).padStart(2, "0")}.png`), frame);
    }
    writeFileSync(SOURCE_HASH, `${appIconHash}\n`);
    console.log(`Wrote ${FRAME_COUNT} busy frames as macOS draws them to ${MACOS_DIR}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
