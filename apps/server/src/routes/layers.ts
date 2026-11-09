import { zValidator } from "@hono/zod-validator";
import {
  type FlattenResponse,
  type JobSetAccepted,
  type LayerStackResponse,
  layerExportBodySchema,
  layersBodySchema,
  stackBodySchema,
  ulidSchema,
} from "@openfield/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../context";
import { attachment } from "../files/names";
import { onInvalid } from "../http/errors";
import { layersRequest } from "../services/layers";

// Layer separation. POST /api/layers runs a separation like any edit (op "decompose") and answers
// the same 202. The stack it makes is read, flattened or exported by the run's id.

const runParamSchema = z.object({ runId: ulidSchema });

export const layersRoutes = new Hono<Env>()
  .post("/layers", zValidator("json", layersBodySchema, onInvalid), async (c) => {
    const accepted = await c.var.svc.runner.createJobSet(layersRequest(c.req.valid("json")));
    return c.json(accepted satisfies JobSetAccepted, 202);
  })
  .get("/layers/:runId", zValidator("param", runParamSchema, onInvalid), (c) => {
    const { layers } = c.var.svc;
    const stack = layers.stack(c.req.valid("param").runId);
    return c.json(layers.response(stack) satisfies LayerStackResponse, 200);
  })
  .post(
    "/layers/:runId/flatten",
    zValidator("param", runParamSchema, onInvalid),
    zValidator("json", stackBodySchema, onInvalid),
    async (c) => {
      const { layers } = c.var.svc;
      const stack = layers.stack(c.req.valid("param").runId);
      const asset = await layers.flatten(stack, c.req.valid("json").layers);
      return c.json({ asset } satisfies FlattenResponse, 201);
    },
  )
  .post(
    "/layers/:runId/export",
    zValidator("param", runParamSchema, onInvalid),
    zValidator("json", layerExportBodySchema, onInvalid),
    async (c) => {
      const { layers } = c.var.svc;
      const body = c.req.valid("json");
      const file = await layers.export(layers.stack(c.req.valid("param").runId), body.layers, body.format);
      return new Response(file.stream, {
        status: 200,
        headers: {
          "content-type": file.mime,
          "content-length": String(file.length),
          "content-disposition": attachment(file.name),
          "cache-control": "no-store",
        },
      });
    },
  );
