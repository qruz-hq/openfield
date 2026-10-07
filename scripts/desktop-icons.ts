import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Renders the desktop app's icons from the aperture mark, then lets the Tauri CLI cut the platform set.
//
//   bun run desktop:icons
//
// Writes, all committed:
//   apps/desktop/src-tauri/icons/app-icon.svg, app-icon-1024.png   the source icon
//   apps/desktop/src-tauri/icons/{32x32,128x128,...}.png, icon.icns, icon.ico   via `tauri icon`
//   apps/desktop/src-tauri/icons/generating/frame-00.png ... frame-23.png   the busy animation
//
// The busy frames turn the mark a quarter turn. It has four identical petals, so a quarter turn
// lands exactly where it started and the loop is seamless. A bone glow behind the mark breathes
// once per loop and is zero on frame 0, so frame 0 is the resting icon and the app settles on it.

const ROOT = resolve(import.meta.dir, "..");
const ICONS = join(ROOT, "apps/desktop/src-tauri/icons");
const FRAMES_DIR = join(ICONS, "generating");

// sharp is a server dependency; resolve it from there rather than adding it to the root.
type SharpFn = (
  input: Buffer,
  options?: { density?: number },
) => { png: () => { toBuffer: () => Promise<Buffer> } };
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

function iconSvg({ angle = 0, glow = 0 }: { angle?: number; glow?: number } = {}): string {
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
  <rect x="${INSET}" y="${INSET}" width="${SQUARE}" height="${SQUARE}" rx="${RADIUS}" fill="${INK}"/>
  <rect x="${INSET + 2}" y="${INSET + 2}" width="${SQUARE - 4}" height="${SQUARE - 4}" rx="${RADIUS - 2}" fill="none" stroke="${BONE}" stroke-opacity="0.08" stroke-width="4"/>
  ${glowLayer}
  <g transform="${mark}" fill="${BONE}">${petals}</g>
</svg>
`;
}

async function render(svg: string, size: number): Promise<Buffer> {
  // density scales the 1024 SVG so it rasterises at the target size directly, keeping edges crisp.
  const density = Math.round((72 * size) / CANVAS);
  return sharp(Buffer.from(svg), { density }).png().toBuffer();
}

mkdirSync(FRAMES_DIR, { recursive: true });

const appIcon = iconSvg();
writeFileSync(join(ICONS, "app-icon.svg"), appIcon);
writeFileSync(join(ICONS, "app-icon-1024.png"), await render(appIcon, CANVAS));

for (const name of readdirSync(FRAMES_DIR)) {
  if (name.startsWith("frame-")) rmSync(join(FRAMES_DIR, name));
}
for (let i = 0; i < FRAME_COUNT; i++) {
  const t = i / FRAME_COUNT;
  // Clockwise, constant speed so the loop has no seam; the glow eases in and out with sin².
  const angle = 90 * t;
  const glow = Math.sin(Math.PI * t) ** 2;
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
