import { zValidator } from "@hono/zod-validator";
import { t, type UploadResponse } from "@openfield/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../context";
import { saveUpload } from "../files/upload";
import { onInvalid } from "../http/errors";

// POST /api/uploads (M1-07, §8.3): one reference image per request, multipart field "file".
// files/upload.ts does the checking and keeping.

// Server-only, so core stays free of the File global.
const uploadFormSchema = z.object({
  file: z.instanceof(File, { error: () => t("uploads.noFile") }),
});

export const uploadsRoutes = new Hono<Env>().post(
  "/uploads",
  zValidator("form", uploadFormSchema, onInvalid),
  async (c) => {
    const result = await saveUpload(c.var.svc, c.req.valid("form").file);
    if (result.duplicate) return c.json(result satisfies UploadResponse, 200);
    return c.json(result satisfies UploadResponse, 201);
  },
);
