import { zValidator } from "@hono/zod-validator";
import {
  idParamSchema,
  type KeepRestApplyBody,
  type KeepRestApplyResponse,
  type KeepRestSaveResponse,
  type KeepRestState,
  keepRestApplyBodySchema,
  t,
} from "@openfield/core";
import { Hono } from "hono";
import type { Env } from "../context";
import { ApiFailure, onInvalid } from "../http/errors";

// Keep the rest of the image after an edit's run (§0.9), done by services/keep-rest.ts.
//   GET  /api/assets/:id/keep-rest        what can be adjusted, and the files to show it with
//   POST /api/assets/:id/keep-rest        made again with other settings, in place, for free
//   POST /api/assets/:id/keep-rest/save   the model's own result as an image of its own
// The POST takes JSON, or multipart with the settings as JSON in "settings" and a fix layer PNG in
// "fixes". The files themselves are under /files (routes/files.ts).

export const keepRestRoutes = new Hono<Env>()
  .get("/assets/:id/keep-rest", zValidator("param", idParamSchema, onInvalid), (c) => {
    const state = c.var.svc.keepRest.state(c.req.valid("param").id);
    return c.json(state satisfies KeepRestState, 200);
  })
  .post("/assets/:id/keep-rest", zValidator("param", idParamSchema, onInvalid), async (c) => {
    const { body, fixes } = await applyBodyOf(c.req.raw);
    const out = await c.var.svc.keepRest.apply(c.req.valid("param").id, body, fixes);
    return c.json(out satisfies KeepRestApplyResponse, 200);
  })
  .post("/assets/:id/keep-rest/save", zValidator("param", idParamSchema, onInvalid), async (c) => {
    const out = await c.var.svc.keepRest.save(c.req.valid("param").id);
    return c.json(out satisfies KeepRestSaveResponse, out.existing ? 200 : 201);
  });

/** The settings, and the fix layer's bytes when one came. */
async function applyBodyOf(req: Request): Promise<{ body: KeepRestApplyBody; fixes?: Uint8Array }> {
  const multipart = (req.headers.get("content-type") ?? "").startsWith("multipart/form-data");
  let raw: unknown;
  let fixes: Uint8Array | undefined;
  try {
    if (multipart) {
      const form = await req.formData();
      const settings = form.get("settings");
      raw = typeof settings === "string" && settings ? JSON.parse(settings) : {};
      const file = form.get("fixes");
      if (file instanceof File) fixes = new Uint8Array(await file.arrayBuffer());
    } else {
      const text = await req.text();
      raw = text ? JSON.parse(text) : {};
    }
  } catch {
    throw new ApiFailure(400, "bad_request", "The body isn't JSON or a form", {
      userMessage: t("keepRest.failed"),
    });
  }
  const parsed = keepRestApplyBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiFailure(400, "bad_request", issue?.message ?? "Invalid settings", {
      ...(issue?.path[0] !== undefined && { field: String(issue.path[0]) }),
    });
  }
  return { body: parsed.data, ...(fixes && { fixes }) };
}
