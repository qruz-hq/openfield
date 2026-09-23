import { zValidator } from "@hono/zod-validator";
import {
  type CancelResponse,
  idParamSchema,
  type JobSetAccepted,
  type JobSetsListResponse,
  jobSetRetryBodySchema,
  jobSetsListQuerySchema,
  type OkResponse,
} from "@openfield/core";
import { listJobSets } from "@openfield/db";
import { Hono } from "hono";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";
import { toJobSetWithJobs } from "../mappers/job";

export const jobSetsRoutes = new Hono<Env>()
  .get("/job-sets", zValidator("query", jobSetsListQuerySchema, onInvalid), (c) => {
    const { status, cursor, limit } = c.req.valid("query");
    const page = listJobSets(c.var.svc.db, { status, cursor, limit });
    const body: JobSetsListResponse = {
      items: page.items.map(toJobSetWithJobs),
      nextCursor: page.nextCursor,
    };
    return c.json(body satisfies JobSetsListResponse, 200);
  })
  .post("/job-sets/:id/cancel", zValidator("param", idParamSchema, onInvalid), (c) => {
    const result = c.var.svc.runner.cancelJobSet(c.req.valid("param").id);
    return c.json(result satisfies CancelResponse, 200);
  })
  .post("/job-sets/:id/recreate", zValidator("param", idParamSchema, onInvalid), (c) => {
    const accepted = c.var.svc.runner.recreate(c.req.valid("param").id);
    return c.json(accepted satisfies JobSetAccepted, 202);
  })
  .post(
    "/job-sets/:id/retry",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("json", jobSetRetryBodySchema, onInvalid),
    (c) => {
      const accepted = c.var.svc.runner.retry(c.req.valid("param").id, c.req.valid("json").onlyFailed);
      return c.json(accepted satisfies JobSetAccepted, 202);
    },
  )
  .post("/jobs/:id/cancel", zValidator("param", idParamSchema, onInvalid), (c) => {
    c.var.svc.runner.cancelJob(c.req.valid("param").id);
    return c.json({ ok: true } satisfies OkResponse, 200);
  });
