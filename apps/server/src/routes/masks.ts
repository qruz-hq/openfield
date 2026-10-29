import { zValidator } from "@hono/zod-validator";
import { queryFlagSchema, t, type UploadResponse, ulidSchema } from "@openfield/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../context";
import { saveMask } from "../files/mask";
import { onInvalid } from "../http/errors";

// POST /api/masks (§0.9): the area of an image an edit may change, saved once and sent by id.
// Multipart: "mask" is the file, "baseAssetId" the image it was drawn on, and "invert" swaps the
// areas to change and keep before it's saved. files/mask.ts does the checking and keeping.

// Server-only, so core stays free of the File global.
const maskFormSchema = z.object({
  mask: z.instanceof(File, { error: () => t("masks.noFile") }),
  baseAssetId: ulidSchema,
  invert: queryFlagSchema.optional(),
});

export const masksRoutes = new Hono<Env>().post(
  "/masks",
  zValidator("form", maskFormSchema, onInvalid),
  async (c) => {
    const { mask, baseAssetId, invert } = c.req.valid("form");
    const result = await saveMask(c.var.svc, mask, { baseAssetId, invert });
    if (result.duplicate) return c.json(result satisfies UploadResponse, 200);
    return c.json(result satisfies UploadResponse, 201);
  },
);
