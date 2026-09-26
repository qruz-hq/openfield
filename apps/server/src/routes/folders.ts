import { zValidator } from "@hono/zod-validator";
import {
  type Folder,
  type FolderDeleteResponse,
  folderCreateBodySchema,
  folderPatchBodySchema,
  idParamSchema,
  newId,
  t,
} from "@openfield/core";
import { addFolder, deleteFolderTree, type FolderResult, listFolders, patchFolder } from "@openfield/db";
import { type Context, Hono } from "hono";
import type { Env } from "../context";
import { envelope, onInvalid } from "../http/errors";
import { toFolder } from "../mappers/asset";

// Folders (§0.7, §8.3, M3a-03): a tree of labels with no depth limit, sent flat. A move into the
// folder itself or anything inside it is refused in the same transaction as the update, so two
// moves racing to make a loop can't both land. Every change goes out as folder.updated.

export const foldersRoutes = new Hono<Env>()
  .get("/folders", (c) => c.json(listFolders(c.var.svc.db).map(toFolder) satisfies Folder[], 200))
  .post("/folders", zValidator("json", folderCreateBodySchema, onInvalid), (c) => {
    const { name, parentId, color } = c.req.valid("json");
    const result = addFolder(c.var.svc.db, {
      id: newId(),
      name,
      parentId: parentId ?? null,
      color: color ?? null,
    });
    if (!result.ok) return refused(c, result.reason);
    c.var.svc.events.publish("folder.updated", { folderId: result.folder.id, deleted: false });
    return c.json(toFolder(result.folder) satisfies Folder, 201);
  })
  .patch(
    "/folders/:id",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("json", folderPatchBodySchema, onInvalid),
    (c) => {
      const result = patchFolder(c.var.svc.db, c.req.valid("param").id, c.req.valid("json"));
      if (!result.ok) return refused(c, result.reason);
      c.var.svc.events.publish("folder.updated", { folderId: result.folder.id, deleted: false });
      return c.json(toFolder(result.folder) satisfies Folder, 200);
    },
  )
  // The folder and every folder inside it; the images stay in the library and their other folders.
  .delete("/folders/:id", zValidator("param", idParamSchema, onInvalid), (c) => {
    const deletedIds = deleteFolderTree(c.var.svc.db, c.req.valid("param").id);
    if (!deletedIds) return refused(c, "not_found");
    for (const folderId of deletedIds)
      c.var.svc.events.publish("folder.updated", { folderId, deleted: true });
    return c.json({ ok: true, deletedIds } satisfies FolderDeleteResponse, 200);
  });

type Refusal = Extract<FolderResult, { ok: false }>["reason"];

function refused(c: Context, reason: Refusal) {
  if (reason === "cycle") {
    return c.json(
      envelope("conflict", "A folder can't go inside itself or a folder inside it", {
        field: "parentId",
        userMessage: t("assets.folder.insideItself"),
      }),
      409,
    );
  }
  const parent = reason === "parent_not_found";
  return c.json(
    envelope("not_found", parent ? "The parent folder doesn't exist" : "That folder doesn't exist", {
      ...(parent && { field: "parentId" }),
      userMessage: t("assets.folder.gone"),
    }),
    404,
  );
}
