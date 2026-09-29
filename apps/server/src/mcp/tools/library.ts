import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import { ASSET_KINDS } from "@openfield/core";
import {
  type AssetRow,
  childrenOf,
  type FeedItem,
  foldersOfAssetWithCounts,
  getAsset,
  getFolder,
  getJobSet,
  isFavourite,
  libraryPage,
  referencesOf,
} from "@openfield/db";
import { z } from "zod";
import { filterOf } from "../../routes/assets";
import { ancestorsOf } from "../../services/library";
import { imageInfo, PREVIEW_EDGE, preview } from "../images";
import { guarded, Refusal, reply, type ToolContext } from "../kit";
import { IMAGE_REF_HINT, resolveImage } from "../refs";

// The person's library: find images, look at them, file them, and bring new ones in.

const MAX_PAGE = 50;
const SMALL_PREVIEW = PREVIEW_EDGE / 2;
const MAX_SEARCH_PREVIEWS = 8;

const assetIdField = z.string().describe("An image id from the library.");

export function libraryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_assets",
    {
      title: "Search the library",
      description:
        "Finds images in the person's library, newest first: by words in their prompt, folder, favourites, model, kind or date. Can list the Trash instead.",
      inputSchema: {
        query: z.string().max(500).optional().describe("Words to look for in prompts."),
        folderId: z.string().optional().describe("Only images in this folder (from list_folders)."),
        favourites: z.boolean().optional().describe("Only favourites."),
        trash: z.boolean().optional().describe("List the Trash instead. Other filters don't apply there."),
        model: z.string().optional().describe('A model id, such as "gemini-3-pro-image".'),
        company: z.string().optional().describe('A company id, such as "google" or "openai".'),
        kind: z.enum(ASSET_KINDS).optional().describe("generated, uploaded, imported or edited."),
        from: z.iso.datetime({ offset: true }).optional().describe("Made at or after this time (ISO 8601)."),
        to: z.iso.datetime({ offset: true }).optional().describe("Made before this time (ISO 8601)."),
        limit: z.int().min(1).max(MAX_PAGE).optional().describe("How many to return. Default 20."),
        cursor: z.string().optional().describe("nextCursor from the previous page."),
        previews: z
          .boolean()
          .optional()
          .describe(`Include small previews of the first ${MAX_SEARCH_PREVIEWS}. Default false.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "search_assets", async (args) => {
      if (args.folderId && !getFolder(ctx.svc.db, args.folderId)) {
        throw new Refusal(`There's no folder with the id ${args.folderId}. Call list_folders to see them.`);
      }
      const page = libraryPage(
        ctx.svc.db,
        {
          ...filterOf({
            q: args.query,
            folder: args.folderId,
            favourite: args.favourites,
            trash: args.trash,
            model: args.model,
            provider: args.company,
            kind: args.kind,
            from: args.from,
            to: args.to,
          }),
          // These tools are about images: videos stay out of what an agent searches.
          modality: "image",
          cursor: args.cursor,
          limit: args.limit ?? 20,
        },
        { total: !args.cursor },
      );
      const blocks: ImageContent[] = [];
      if (args.previews) {
        for (const item of page.items.slice(0, MAX_SEARCH_PREVIEWS)) {
          const block = await preview(ctx, item, SMALL_PREVIEW);
          if (block) blocks.push(block);
        }
      }
      return reply(
        {
          ...(page.total !== undefined && { total: page.total }),
          images: page.items.map((item) => listed(ctx, item)),
          nextCursor: page.nextCursor,
        },
        blocks,
      );
    }),
  );

  server.registerTool(
    "get_asset",
    {
      title: "Image details",
      description:
        "Everything about one image: its prompt, model and settings, the run that made it, the images it came from and was made into, its folders, and a preview.",
      inputSchema: {
        assetId: assetIdField,
        preview: z.boolean().optional().describe("Include a preview. Default true."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "get_asset", async ({ assetId, preview: withPreview }) => {
      const { db } = ctx.svc;
      const row = getAsset(db, assetId, { includeDeleted: true });
      if (!row) throw new Refusal(`There's no image with the id ${assetId}.`);
      const brief = (a: AssetRow) => ({ assetId: a.id, prompt: a.prompt, kind: a.kind });
      const set = row.jobSetId ? getJobSet(db, row.jobSetId) : undefined;
      const block = withPreview === false ? null : await preview(ctx, row);
      return reply(
        {
          ...listed(ctx, { ...row, isFavourite: isFavourite(db, row.id) }),
          ...(row.deletedAt && { inTrash: true }),
          seed: row.seed,
          settings: row.params,
          runId: row.jobSetId,
          ...(set && { runPrompt: set.prompt, runStatus: set.status }),
          references: referencesOf(db, row.id).map(brief),
          madeFrom: ancestorsOf(db, row).map(brief),
          madeInto: childrenOf(db, row.id).map(brief),
          folders: foldersOfAssetWithCounts(db, row.id).map((f) => ({ folderId: f.id, name: f.name })),
        },
        block ? [block] : [],
      );
    }),
  );

  server.registerTool(
    "view_asset",
    {
      title: "Look at an image",
      description: "Shows an image from the library, at up to 512 or 1024 px on its long side.",
      inputSchema: {
        assetId: assetIdField,
        large: z.boolean().optional().describe("Up to 1024 px instead of 512. Uses more of your context."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "view_asset", async ({ assetId, large }) => {
      const row = getAsset(ctx.svc.db, assetId, { includeDeleted: true });
      if (!row) throw new Refusal(`There's no image with the id ${assetId}.`);
      const block = await preview(ctx, row, large ? PREVIEW_EDGE * 2 : PREVIEW_EDGE);
      const info = imageInfo(ctx, row);
      if (!block) return reply({ ...info, note: "No preview can be made here. Open the file instead." });
      return reply(info, [block]);
    }),
  );

  server.registerTool(
    "update_assets",
    {
      title: "File or tidy images",
      description:
        "Changes images in the library: favourite or unfavourite them, add them to a folder or take them out of one, move them to the Trash, or bring them back. Folders are like tags: an image can be in several.",
      inputSchema: {
        assetIds: z.array(z.string()).min(1).max(500).describe("The images to change."),
        favourite: z.boolean().optional().describe("true favourites them, false unfavourites them."),
        addToFolder: z.string().optional().describe("A folder id to add them to."),
        removeFromFolder: z.string().optional().describe("A folder id to take them out of."),
        trash: z.boolean().optional().describe("true moves them to the Trash. They can be restored."),
        restore: z.boolean().optional().describe("true brings them back from the Trash."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, "update_assets", async (args) => {
      const { library, db } = ctx.svc;
      if (args.trash && args.restore) throw new Refusal("Pass trash or restore, not both.");
      const actions = [args.favourite, args.addToFolder, args.removeFromFolder, args.trash, args.restore];
      if (actions.every((a) => a === undefined || a === false)) {
        throw new Refusal("Say what to change: favourite, addToFolder, removeFromFolder, trash or restore.");
      }
      const missing = args.assetIds.filter((id) => !getAsset(db, id, { includeDeleted: true }));
      if (missing.length) throw new Refusal(`These aren't images in the library: ${missing.join(", ")}.`);
      for (const folderId of [args.addToFolder, args.removeFromFolder]) {
        if (folderId && !getFolder(db, folderId)) {
          throw new Refusal(`There's no folder with the id ${folderId}. Call list_folders to see them.`);
        }
      }
      const changed: Record<string, number> = {};
      if (args.restore) changed.restored = library.restore(args.assetIds).length;
      if (args.favourite !== undefined) {
        changed[args.favourite ? "favourited" : "unfavourited"] = library.setFavourites(
          args.assetIds,
          args.favourite,
        ).length;
      }
      if (args.addToFolder)
        changed.addedToFolder = library.addToFolder(args.addToFolder, args.assetIds)?.length ?? 0;
      if (args.removeFromFolder) {
        changed.removedFromFolder =
          library.removeFromFolder(args.removeFromFolder, args.assetIds)?.length ?? 0;
      }
      if (args.trash) changed.trashed = library.trash(args.assetIds).length;
      return reply({ changed });
    }),
  );

  server.registerTool(
    "import_image",
    {
      title: "Bring an image in",
      description:
        "Adds an image to the library from a file on this computer or a web address, so it can be used as a reference or edited. The same image twice is kept once.",
      inputSchema: { source: z.string().describe(IMAGE_REF_HINT) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(ctx, "import_image", async ({ source }) => {
      const row = await resolveImage(ctx, source);
      const block = await preview(ctx, row);
      return reply(
        listed(ctx, { ...row, isFavourite: isFavourite(ctx.svc.db, row.id) }),
        block ? [block] : [],
      );
    }),
  );
}

/** One image in a list, as agents read it. */
function listed(ctx: ToolContext, item: FeedItem) {
  return {
    ...imageInfo(ctx, item),
    kind: item.kind,
    prompt: item.prompt,
    model: item.providerId && item.modelId ? `${item.providerId}:${item.modelId}` : null,
    favourite: item.isFavourite,
    createdAt: item.createdAt,
  };
}
