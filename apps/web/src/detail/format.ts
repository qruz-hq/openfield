import {
  ASPECT_RATIOS,
  type AspectRatio,
  type AssetListItem,
  aspectRatioSchema,
  DETAIL_PREVIEW_EDGE,
  formatDate,
  formatLocale,
  localDayKey,
  type ModelKey,
  modelKeySchema,
  type PixelSize,
  type ResolutionTier,
  resolutionTierSchema,
  type SpeedId,
  speedIdSchema,
  t,
} from "@openfield/core";
import { nearestRatio } from "@openfield/providers/manifest";

// The words and names the detail view derives from an image (§4.0). Pure, so they're unit tested.

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** "2 hours ago", "Yesterday", "A moment ago", then the date once it's more than a week old. */
export function relativeTime(value: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1000));
  if (seconds < 45) return t("assets.detail.momentAgo");
  if (seconds >= 7 * DAY) return formatDate(value);
  const format = new Intl.RelativeTimeFormat(formatLocale(), { numeric: "auto" });
  const text =
    seconds < HOUR
      ? format.format(-Math.max(1, Math.round(seconds / MINUTE)), "minute")
      : seconds < DAY
        ? format.format(-Math.round(seconds / HOUR), "hour")
        : format.format(-Math.round(seconds / DAY), "day");
  // It opens the caption, so it reads in sentence case ("Yesterday", not "yesterday").
  return text.charAt(0).toLocaleUpperCase(formatLocale()) + text.slice(1);
}

/** "In the trash since today" (design JSKpv), by the day it was deleted. */
export function inTrashCaption(deletedAt: string, now: Date = new Date()): string {
  const day = localDayKey(deletedAt);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const when = day === localDayKey(now) ? "today" : day === localDayKey(yesterday) ? "yesterday" : "other";
  return t("assets.detail.inTrash", { when, date: formatDate(deletedAt) });
}

/** The rung the backdrop blurs, and the first thing the media area paints (§4.0). */
export const BACKDROP_RUNG = 360;

/**
 * One size of an image's thumbnail, built on the URL the server sent so its own flags stay on (an
 * image in the Trash is only served with `trash=1`). "preview" is the 1440 detail rung.
 */
export function thumbAt(
  item: Pick<AssetListItem, "id" | "thumbUrl">,
  size: { h: number } | "preview",
): string {
  const url = new URL(item.thumbUrl || `/files/thumb/${item.id}`, "http://openfield.local");
  for (const key of ["h", "p", "dpr"]) url.searchParams.delete(key);
  if (size === "preview") url.searchParams.set("p", String(DETAIL_PREVIEW_EDGE));
  else url.searchParams.set("h", String(size.h));
  return `${url.pathname}${url.search}`;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};

/**
 * `openfield_{yyyymmdd-hhmm}_{model}_{shortid}.{ext}` in local time (§4.4). The short id is the
 * last 8 characters, as the library's cards use, so one image saves under one name everywhere.
 */
export function downloadName(asset: {
  id: string;
  createdAt: string;
  modelId: string | null;
  mime: string;
}): string {
  const at = new Date(asset.createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  const model =
    (asset.modelId ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^-+|-+$/g, "") || "image";
  const ext = EXTENSIONS[asset.mime] ?? asset.mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "png";
  return `openfield_${stamp}_${model}_${asset.id.slice(-8).toLowerCase()}.${ext || "png"}`;
}

/** The frozen request, as far as the detail view needs it. Every field is optional: old runs lack some. */
export interface FrozenSettings {
  prompt?: string;
  model?: ModelKey;
  /** What Reuse puts in the composer's aspect chip. */
  aspect?: AspectRatio;
  resolution?: ResolutionTier;
  quality?: string;
  /** What the estimate prices: the size that was asked for. */
  size?: PixelSize | { aspect: AspectRatio };
  /** The speed it ran at, and the one the company's settings asked for. */
  speed?: SpeedId;
  speedRequested?: SpeedId;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Reads assets.params (the NormalizedRequest without its ids). Anything malformed is left out, so
 * an old or hand-edited row still opens; a pixel size becomes the nearest ratio the composer knows.
 */
export function frozenSettings(params: Record<string, unknown> | null | undefined): FrozenSettings {
  if (!params) return {};
  const out: FrozenSettings = {};
  if (typeof params.prompt === "string") out.prompt = params.prompt;
  const model = modelKeySchema.safeParse(params.model);
  if (model.success) out.model = model.data;
  const resolution = resolutionTierSchema.safeParse(params.resolution);
  if (resolution.success) out.resolution = resolution.data;
  if (typeof params.quality === "string" && params.quality) out.quality = params.quality;
  const speed = speedIdSchema.safeParse(params.speed);
  if (speed.success) out.speed = speed.data;
  const requested = speedIdSchema.safeParse(params.speedRequested);
  if (requested.success) out.speedRequested = requested.data;

  const size = params.size;
  if (isRecord(size)) {
    const aspect = aspectRatioSchema.safeParse(size.aspect);
    if (aspect.success) {
      out.aspect = aspect.data;
      out.size = { aspect: aspect.data };
    } else if (positive(size.width) && positive(size.height)) {
      out.size = { width: size.width, height: size.height };
      const ratio = nearestRatio(size.width, size.height, ASPECT_RATIOS);
      if (ratio) out.aspect = ratio;
    }
  }
  return out;
}
