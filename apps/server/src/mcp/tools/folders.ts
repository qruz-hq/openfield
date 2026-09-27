import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FOLDER_NAME_MAX, newId } from "@openfield/core";
import {
  addFolder,
  deleteFolderTree,
  type FolderResult,
  type FolderWithCount,
  listFolders,
  patchFolder,
} from "@openfield/db";
import { z } from "zod";
import { guarded, Refusal, reply, type ToolContext } from "../kit";

// Folders are a tree of labels with no depth limit (§0.7). Images stay in the library when a
// folder goes; changes reach open tabs as folder.updated, like the routes send.

export function folderTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description:
        "Every folder in the library, with its path, its parent and how many images are directly in it.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "list_folders", async () => {
      const folders = listFolders(ctx.svc.db);
      return reply({ folders: folders.map((f) => describe(f, folders)) });
    }),
  );

  server.registerTool(
    "create_folder",
    {
      title: "Make a folder",
      description: "Makes a folder, at the top or inside another one.",
      inputSchema: {
        name: z.string().trim().min(1).max(FOLDER_NAME_MAX).describe("The folder's name."),
        parentId: z.string().optional().describe("Put it inside this folder. Default: at the top."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(ctx, "create_folder", async ({ name, parentId }) => {
      const result = addFolder(ctx.svc.db, { id: newId(), name, parentId: parentId ?? null, color: null });
      if (!result.ok) throw refusal(result.reason);
      ctx.svc.events.publish("folder.updated", { folderId: result.folder.id, deleted: false });
      return reply(describe(result.folder, listFolders(ctx.svc.db)));
    }),
  );

  server.registerTool(
    "update_folder",
    {
      title: "Rename or move a folder",
      description: "Renames a folder, or moves it inside another one or to the top.",
      inputSchema: {
        folderId: z.string().describe("The folder to change."),
        name: z.string().trim().min(1).max(FOLDER_NAME_MAX).optional().describe("A new name."),
        parentId: z
          .string()
          .nullable()
          .optional()
          .describe("Move it inside this folder, or null to move it to the top."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(ctx, "update_folder", async ({ folderId, name, parentId }) => {
      if (name === undefined && parentId === undefined)
        throw new Refusal("Say what to change: name or parentId.");
      const result = patchFolder(ctx.svc.db, folderId, {
        ...(name !== undefined && { name }),
        ...(parentId !== undefined && { parentId }),
      });
      if (!result.ok) throw refusal(result.reason);
      ctx.svc.events.publish("folder.updated", { folderId: result.folder.id, deleted: false });
      return reply(describe(result.folder, listFolders(ctx.svc.db)));
    }),
  );

  server.registerTool(
    "delete_folder",
    {
      title: "Delete a folder",
      description:
        "Deletes a folder and every folder inside it. The images stay in the library and in their other folders.",
      inputSchema: { folderId: z.string().describe("The folder to delete.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(ctx, "delete_folder", async ({ folderId }) => {
      const deleted = deleteFolderTree(ctx.svc.db, folderId);
      if (!deleted) throw refusal("not_found");
      for (const id of deleted) ctx.svc.events.publish("folder.updated", { folderId: id, deleted: true });
      return reply({ deletedFolderIds: deleted });
    }),
  );
}

function describe(
  folder: Pick<FolderWithCount, "id" | "name" | "parentId"> & { count?: number },
  all: FolderWithCount[],
) {
  const byId = new Map(all.map((f) => [f.id, f]));
  const path: string[] = [folder.name];
  const seen = new Set([folder.id]);
  for (let at = folder.parentId; at && !seen.has(at); at = byId.get(at)?.parentId ?? null) {
    seen.add(at);
    path.unshift(byId.get(at)?.name ?? "?");
  }
  return {
    folderId: folder.id,
    name: folder.name,
    path: path.join(" / "),
    parentId: folder.parentId,
    images: byId.get(folder.id)?.count ?? folder.count ?? 0,
  };
}

function refusal(reason: Extract<FolderResult, { ok: false }>["reason"] | "not_found"): Refusal {
  if (reason === "cycle") return new Refusal("A folder can't go inside itself or a folder inside it.");
  if (reason === "parent_not_found")
    return new Refusal("That parent folder doesn't exist. Call list_folders.");
  return new Refusal("That folder doesn't exist. Call list_folders to see them.");
}
