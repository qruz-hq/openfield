import { statSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AssetListItem } from "@openfield/core";
import {
  type AssetRow,
  addAssetsToFolder,
  type Db,
  emptyTrash,
  type FeedItem,
  folderMemberships,
  getAsset,
  getAssets,
  isFavourite,
  type PurgeResult,
  purgeAssets,
  removeAssetsFromFolder,
  rerunJobIds,
  restoreAssets,
  setFavourites,
  softDeleteAssets,
  trashedBefore,
} from "@openfield/db";
import { absolutePath, type HomePaths } from "../config/home";
import type { EventHub } from "../events/hub";
import { zipEntryName, zipName } from "../files/names";
import { planZip, type ZipOptions, zipStream } from "../files/zip";
import type { Logger } from "../log/logger";
import { images } from "../log/plural";
import { toAssetListItem } from "../mappers/asset";
import type { SettingsService } from "./settings";

// Everything the Assets library changes that other tabs and the disk must hear about (§2.8,
// §8.6): the Trash, favourites, filing, deletes for good with their file cleanup, the optional
// retention purge, and zips of originals. Routes stay thin; the events go out from here.

export interface LibraryServiceDeps {
  db: Db;
  paths: HomePaths;
  events: EventHub;
  logger: Logger;
  settings: SettingsService;
}

export interface PurgeOutcome {
  /** The images deleted for good. */
  changed: string[];
  /** Bytes of the files removed from disk. Files another image still uses are kept. */
  reclaimedBytes: number;
}

export interface AssetZip {
  name: string;
  count: number;
  /** Exact, so the reply can carry a Content-Length. */
  length: number;
  stream: ReadableStream<Uint8Array>;
}

const DAY_MS = 86_400_000;
/** Keeps each asset.deleted frame small, even when a big trash is emptied. */
const IDS_PER_FRAME = 1000;
/** Deletes on disk run this many at a time. */
const DISK_BATCH = 64;

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Wire items for rows from a listing, with their rerun notes looked up in one query. */
export function toListItems(db: Db, rows: readonly FeedItem[]): AssetListItem[] {
  const reruns = rerunJobIds(
    db,
    rows.map((r) => r.jobId),
  );
  return rows.map((r) => toAssetListItem(r, r.isFavourite, reruns.has(r.jobId ?? "")));
}

export class LibraryService {
  constructor(private readonly deps: LibraryServiceDeps) {}

  /** Delete: to the Trash, keeping folders and favourite (§0.7). Returns the ids it moved. */
  trash(ids: readonly string[]): string[] {
    const changed = softDeleteAssets(this.deps.db, [...new Set(ids)]);
    this.#announceDeleted(changed, false);
    return changed;
  }

  /** Back out of the Trash, into every folder they were in. Returns the ids it restored. */
  restore(ids: readonly string[]): string[] {
    const { db } = this.deps;
    const changed = db.transaction((tx) => restoreAssets(tx, ids));
    this.#announceUpdated(changed);
    // Their folders' counts went up again.
    for (const { folderId } of folderMemberships(db, changed)) {
      this.deps.events.publish("folder.updated", { folderId, deleted: false });
    }
    return changed;
  }

  /**
   * Delete for good, in one transaction, then the files and thumbnails nothing else uses (§8.6).
   * Only images in the Trash unless `includeLive` (DELETE /api/assets/:id?hard=1).
   */
  async purge(ids: readonly string[], opts: { includeLive?: boolean } = {}): Promise<PurgeOutcome> {
    return this.#afterPurge(purgeAssets(this.deps.db, ids, opts));
  }

  /** Empty trash: every image in it, deleted for good. */
  async emptyTrash(): Promise<PurgeOutcome> {
    return this.#afterPurge(emptyTrash(this.deps.db));
  }

  /**
   * The optional retention purge (§8.6): only when trashRetentionDays is set, images that have
   * been in the Trash longer than that are deleted for good. Returns how many went.
   */
  async purgeExpired(now = new Date()): Promise<number> {
    const days = this.deps.settings.get().trashRetentionDays;
    if (days === null) return 0;
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
    const expired = trashedBefore(this.deps.db, cutoff).map((row) => row.id);
    if (expired.length === 0) return 0;
    const { changed } = await this.purge(expired);
    if (changed.length) {
      this.deps.logger.info(
        `Deleted ${images(changed.length)} for good after ${days} ${days === 1 ? "day" : "days"} in the trash`,
      );
    }
    return changed.length;
  }

  /** Runs the retention purge now and once a day. Returns the function that stops it. */
  scheduleRetention(): () => void {
    const run = () =>
      void this.purgeExpired().catch((error) =>
        this.deps.logger.warn("Couldn't empty old images from the trash", { error }),
      );
    run();
    const timer = setInterval(run, DAY_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Favourite or unfavourite. Returns the ids that changed, for Undo. */
  setFavourites(ids: readonly string[], on: boolean): string[] {
    const changed = setFavourites(this.deps.db, ids, on);
    this.#announceUpdated(changed);
    return changed;
  }

  /** Adds images to a folder and keeps their other folders. Null for an unknown folder. */
  addToFolder(folderId: string, ids: readonly string[]): string[] | null {
    const changed = addAssetsToFolder(this.deps.db, folderId, ids);
    if (changed?.length) this.deps.events.publish("folder.updated", { folderId, deleted: false });
    return changed;
  }

  /** Takes images out of this folder only. Null for an unknown folder. */
  removeFromFolder(folderId: string, ids: readonly string[]): string[] | null {
    const changed = removeAssetsFromFolder(this.deps.db, folderId, ids);
    if (changed?.length) this.deps.events.publish("folder.updated", { folderId, deleted: false });
    return changed;
  }

  /**
   * A zip of the originals, in the order asked for (§2.5). Images in the Trash count; images whose
   * file is missing are left out. Null when none of them can be packed.
   */
  zip(ids: readonly string[], opts: ZipOptions = {}): AssetZip | null {
    const { db, paths, logger } = this.deps;
    const rows: { row: AssetRow; file: string }[] = [];
    for (const id of new Set(ids)) {
      const row = getAsset(db, id, { includeDeleted: true });
      if (!row || row.kind === "mask") continue;
      const file = this.#inside(absolutePath(paths, row.path));
      if (file && isFile(file)) rows.push({ row, file });
    }
    if (rows.length === 0) return null;
    const names = new Set<string>();
    const plan = planZip(
      rows.map(({ row, file }) => ({
        name: unique(zipEntryName(row), names),
        size: statSync(file).size,
        modifiedAt: new Date(row.createdAt),
      })),
      opts,
    );
    const stream = zipStream(
      plan,
      async (index) => new Uint8Array(await Bun.file(rows[index]!.file).arrayBuffer()),
      (error) => logger.warn("A download stopped part way", { error }),
    );
    return { name: zipName(rows.length), count: rows.length, length: plan.length, stream };
  }

  async #afterPurge(result: PurgeResult): Promise<PurgeOutcome> {
    const changed = result.deleted.map((row) => row.id);
    await this.#removeFiles(result);
    this.#announceDeleted(changed, true);
    return { changed, reclaimedBytes: result.reclaimedBytes };
  }

  /** The rows are already gone, so a file that won't delete is logged, never thrown. */
  async #removeFiles(result: PurgeResult): Promise<void> {
    const { paths, logger } = this.deps;
    const remove = async (file: string) => {
      try {
        await rm(file, { force: true });
      } catch (error) {
        logger.warn("Couldn't delete a file from the library folder", { file, error });
      }
    };
    const files = result.files.flatMap((relative) => this.#inside(absolutePath(paths, relative)) ?? []);
    for (const batch of chunks(files, DISK_BATCH)) await Promise.all(batch.map(remove));
    // Thumbnails are cached by content hash, in thumbs/<first two>/<sha>@<size>.webp (§8.5.2).
    for (const sha of result.hashes) {
      const dir = join(paths.thumbs, sha.slice(0, 2));
      const names = await readdir(dir).catch(() => [] as string[]);
      await Promise.all(names.filter((n) => n.startsWith(`${sha}@`)).map((n) => remove(join(dir, n))));
    }
  }

  /** A stored path always sits inside the library folder; anything else is never touched. */
  #inside(file: string): string | null {
    const root = resolve(this.deps.paths.root) + sep;
    const full = resolve(file);
    return full.startsWith(root) ? full : null;
  }

  #announceDeleted(ids: readonly string[], hard: boolean): void {
    for (const assetIds of chunks(ids, IDS_PER_FRAME)) {
      this.deps.events.publish("asset.deleted", { assetIds, hard });
    }
  }

  /** asset.updated for each of these that is live, as a list item, so other tabs can patch it. */
  #announceUpdated(ids: readonly string[]): void {
    const { db, events } = this.deps;
    for (const part of chunks(ids, 500)) {
      const rows = getAssets(db, part);
      const reruns = rerunJobIds(
        db,
        rows.map((r) => r.jobId),
      );
      for (const row of rows) {
        events.publish("asset.updated", {
          asset: toAssetListItem(row, isFavourite(db, row.id), reruns.has(row.jobId ?? "")),
        });
      }
    }
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Two images can share a name only by a one-in-millions chance; the second gets "-2". */
function unique(name: string, taken: Set<string>): string {
  let candidate = name;
  const dot = name.lastIndexOf(".");
  for (let n = 2; taken.has(candidate); n++) candidate = `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
  taken.add(candidate);
  return candidate;
}
