import { z } from "zod";
import {
  ASSET_KINDS,
  BULK_ACTIONS,
  BULK_MAX_IDS,
  DETAIL_PREVIEW_EDGE,
  EDGE_RELATIONS,
  FILE_STATES,
  FOLDER_NAME_MAX,
  THUMB_RUNGS,
} from "../constants";
import {
  cursorSchema,
  hexColorSchema,
  modalitySchema,
  modelIdSchema,
  opSchema,
  outputFormatSchema,
  providerIdSchema,
  queryFlagSchema,
  queryLimitSchema,
  sha256Schema,
  timestampSchema,
  ulidSchema,
  usdSchema,
} from "./common";
import { jobSetSchema } from "./job";

// Assets on the wire (§0.7, §8.3). Paths never leave the server; URLs do.

export const assetKindSchema = z.enum(ASSET_KINDS);

/** One feed or library tile. */
export const assetListItemSchema = z.object({
  id: ulidSchema,
  kind: assetKindSchema,
  jobSetId: ulidSchema.nullable(),
  jobId: ulidSchema.nullable(),
  width: z.int().positive(),
  height: z.int().positive(),
  mime: z.string(),
  sha256: sha256Schema,
  /** "local" for crop, grade and overlay. */
  providerId: z.string().nullable(),
  modelId: modelIdSchema.nullable(),
  prompt: z.string(),
  approximate: z.boolean(),
  isFavourite: z.boolean(),
  /**
   * Made by a run that went again after a restart (jobs.rerun_at), so the company may have billed
   * the call it replaced too (§0.4). The tile's note stays as long as the image is in the feed.
   */
  rerun: z.boolean(),
  createdAt: timestampSchema,
  /** Only in Trash listings (`trash=1`), which group and page by the day it was deleted. */
  deletedAt: timestampSchema.optional(),
  thumbUrl: z.string(),
  fileUrl: z.string(),
});

export const assetSchema = assetListItemSchema.extend({
  modality: modalitySchema,
  bytes: z.int().nonnegative(),
  seed: z.int().nullable(),
  /** The exact settings that made it. */
  params: z.record(z.string(), z.unknown()).nullable(),
  /** Space-separated. */
  tags: z.string(),
  costUsd: usdSchema.nullable(),
  parentAssetId: ulidSchema.nullable(),
  rootAssetId: ulidSchema,
  op: opSchema.nullable(),
  opParams: z.record(z.string(), z.unknown()).nullable(),
  maskAssetId: ulidSchema.nullable(),
  generative: z.boolean(),
  approximateReason: z.string().nullable(),
  fileState: z.enum(FILE_STATES),
  updatedAt: timestampSchema,
  deletedAt: timestampSchema.nullable(),
});

/**
 * One folder, flat. Folders nest through parentId with no depth limit (§0.7); the client builds
 * the tree (buildFolderTree) and derives subfolder counts from the same list.
 */
export const folderSchema = z.object({
  id: ulidSchema,
  name: z.string().min(1).max(FOLDER_NAME_MAX),
  color: hexColorSchema.nullable(),
  /** null at the top level. */
  parentId: ulidSchema.nullable(),
  sortOrder: z.int(),
  /** Live images filed directly in this folder, not in its subfolders. */
  count: z.int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * GET /api/assets. `folder` lists images filed directly in it; `q` is the prompt search and
 * combines with every other filter on the same cursor. `trash=1` lists deleted images instead,
 * newest deletion first, and ignores q, folder, favourite and the filters. Masks are never listed.
 */
export const assetsListQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: queryLimitSchema.optional(),
  folder: ulidSchema.optional(),
  favourite: queryFlagSchema.optional(),
  trash: queryFlagSchema.optional(),
  q: z.string().max(500).optional(),
  model: modelIdSchema.optional(),
  provider: providerIdSchema.optional(),
  kind: assetKindSchema.optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  modality: modalitySchema.optional(),
});
export const assetsListResponseSchema = z.object({
  items: z.array(assetListItemSchema),
  /** How many images match, for the header. First page only (no cursor). */
  total: z.int().nonnegative().optional(),
  nextCursor: cursorSchema.nullable(),
});

/** GET /api/assets/:id */
export const assetDetailResponseSchema = z.object({
  asset: assetSchema,
  jobSet: jobSetSchema.nullable(),
  params: z.record(z.string(), z.unknown()).nullable(),
  references: z.array(assetSchema),
  lineage: z.object({ ancestors: z.array(assetSchema), children: z.array(assetSchema) }),
  folders: z.array(folderSchema),
  isFavourite: z.boolean(),
});

/**
 * GET /api/assets/:id/neighbours: the images either side of this one in a listing, for the detail
 * view's arrows after a reload. Takes the listing's own filters; cursor and limit don't apply.
 */
export const assetNeighboursQuerySchema = assetsListQuerySchema.omit({ cursor: true, limit: true });
export const assetNeighboursResponseSchema = z.object({
  /** Newer, shown before it. */
  previous: assetListItemSchema.nullable(),
  /** Older, shown after it. */
  next: assetListItemSchema.nullable(),
});

const libraryCountSchema = z.int().nonnegative();
/** GET /api/library/summary: the sidebar counts and the filter choices. Masks never count. */
export const librarySummaryResponseSchema = z.object({
  counts: z.object({
    /** Live images. */
    all: libraryCountSchema,
    /** Live favourites. */
    favourites: libraryCountSchema,
    /** Images in the Trash. */
    trash: libraryCountSchema,
  }),
  /** Models that made a live image, for the Model filter. */
  models: z.array(z.object({ providerId: z.string(), modelId: z.string(), count: libraryCountSchema })),
  /** Companies with a live image, for the Company filter. "local" is crop, grade and overlay. */
  providers: z.array(z.object({ providerId: z.string(), count: libraryCountSchema })),
});

/** PATCH /api/assets/:id */
export const assetPatchBodySchema = z.strictObject({ tags: z.string().max(2000).optional() });

/** DELETE /api/assets/:id */
export const assetDeleteQuerySchema = z.object({ hard: queryFlagSchema.optional() });

/** PUT/DELETE /api/assets/:id/favourite */
export const favouriteResponseSchema = z.object({ isFavourite: z.boolean() });

/**
 * PUT/DELETE /api/assets/:id/folders/:folderId. PUT keeps every other folder; DELETE removes only
 * this one. Answers with every folder the image is in afterwards.
 */
export const assetFolderParamSchema = z.object({
  id: z.string().min(1).max(128),
  folderId: z.string().min(1).max(128),
});
export const assetFoldersResponseSchema = z.object({ folders: z.array(folderSchema) });

const bulkIdsSchema = z.array(ulidSchema).min(1).max(BULK_MAX_IDS);

/**
 * POST /api/assets/bulk: one transaction per call. `addFolder` skips images already in the
 * folder; `removeFolder` touches only that folder; `restore` and `purge` act on the Trash only.
 * `download` answers with a zip instead of JSON.
 */
export const assetBulkBodySchema = z
  .object({
    ids: bulkIdsSchema,
    action: z.enum(BULK_ACTIONS),
    folderId: ulidSchema.optional(),
  })
  .refine(
    (b) => (b.action === "addFolder" || b.action === "removeFolder" ? b.folderId !== undefined : true),
    {
      message: "folderId is required for folder actions",
      path: ["folderId"],
    },
  );
export const assetBulkResponseSchema = z.object({
  affected: z.int().nonnegative(),
  /**
   * The images this call changed, so Undo reverses exactly that: an add skips images already in
   * the folder, a favourite skips ones already favourited, a delete skips ones already in the Trash.
   */
  changed: z.array(ulidSchema),
});

/**
 * POST /api/assets/memberships: which folders a selection is in, for the Add to folder picker.
 * A folder is on when its count equals the number of ids, mixed when lower, off when absent.
 */
export const assetMembershipsBodySchema = z.object({ ids: bulkIdsSchema });
export const assetMembershipsResponseSchema = z.object({
  folders: z.array(z.object({ folderId: ulidSchema, count: z.int().positive() })),
});

/** POST /api/assets/:id/restore answers with the asset (assetSchema). */

/** POST /api/maintenance/empty-trash: every image in the Trash, deleted for good. */
export const emptyTrashBodySchema = z.strictObject({});
export const emptyTrashResponseSchema = z.object({
  affected: z.int().nonnegative(),
  /** Bytes of the files removed from disk. Files another image still uses are kept. */
  reclaimedBytes: z.int().nonnegative(),
});

/** GET /api/assets/:id/lineage: the multi-parent reference graph. */
export const lineageResponseSchema = z.object({
  nodes: z.array(assetSchema.extend({ depth: z.int().nonnegative() })),
  edges: z.array(
    z.object({
      parentAssetId: ulidSchema,
      childAssetId: ulidSchema,
      relation: z.enum(EDGE_RELATIONS),
      ordinal: z.int().nonnegative(),
    }),
  ),
});

/** POST /api/uploads and POST /api/masks */
export const uploadResponseSchema = z.object({
  asset: assetSchema,
  /** The same bytes were already in the library. */
  duplicate: z.boolean(),
});

/** GET /api/assets/:id/export */
export const assetExportQuerySchema = z.object({
  format: outputFormatSchema.optional(),
  metadata: queryFlagSchema.optional(),
  sidecar: queryFlagSchema.optional(),
});

/** GET /files/thumb/:id. The server rounds h up to the nearest rung. */
export const thumbQuerySchema = z.object({
  h: z.coerce
    .number()
    .int()
    .min(1)
    .max(THUMB_RUNGS[THUMB_RUNGS.length - 1]!)
    .optional(),
  dpr: z.enum(["1", "2"]).optional(),
  p: z.literal(String(DETAIL_PREVIEW_EDGE)).optional(),
});

const folderNameSchema = z.string().trim().min(1).max(FOLDER_NAME_MAX);

/**
 * POST /api/folders: at the top level, or inside `parentId` (404 when it names no folder).
 * Names are trimmed and need not be unique. Answers with the folder.
 */
export const folderCreateBodySchema = z.object({
  name: folderNameSchema,
  parentId: ulidSchema.optional(),
  color: hexColorSchema.optional(),
});
/**
 * PATCH /api/folders/:id: rename and move. `parentId: null` moves it to the top level; the folder
 * itself or one of its subfolders is refused with 409 conflict and nothing changes.
 */
export const folderPatchBodySchema = z.strictObject({
  name: folderNameSchema.optional(),
  parentId: ulidSchema.nullable().optional(),
  color: hexColorSchema.nullable().optional(),
  sortOrder: z.int().optional(),
});
/** GET /api/folders: every folder, flat. */
export const foldersListResponseSchema = z.array(folderSchema);
/** DELETE /api/folders/:id: the folder and every folder inside it, never an image. */
export const folderDeleteResponseSchema = z.object({
  ok: z.literal(true),
  /** The folder and all its descendants, parents before children. */
  deletedIds: z.array(ulidSchema),
});

export type AssetListItem = z.infer<typeof assetListItemSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Folder = z.infer<typeof folderSchema>;
export type AssetsListQuery = z.infer<typeof assetsListQuerySchema>;
export type AssetsListResponse = z.infer<typeof assetsListResponseSchema>;
export type AssetNeighboursResponse = z.infer<typeof assetNeighboursResponseSchema>;
export type LibrarySummary = z.infer<typeof librarySummaryResponseSchema>;
export type AssetDetailResponse = z.infer<typeof assetDetailResponseSchema>;
export type AssetBulkBody = z.infer<typeof assetBulkBodySchema>;
export type AssetBulkResponse = z.infer<typeof assetBulkResponseSchema>;
export type AssetMembershipsResponse = z.infer<typeof assetMembershipsResponseSchema>;
export type EmptyTrashResponse = z.infer<typeof emptyTrashResponseSchema>;
export type FolderCreateBody = z.infer<typeof folderCreateBodySchema>;
export type FolderPatchBody = z.infer<typeof folderPatchBodySchema>;
export type FolderDeleteResponse = z.infer<typeof folderDeleteResponseSchema>;
export type LineageResponse = z.infer<typeof lineageResponseSchema>;
export type UploadResponse = z.infer<typeof uploadResponseSchema>;
