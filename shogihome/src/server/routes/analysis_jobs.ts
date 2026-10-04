import { Hono } from "hono";
import { validator } from "hono/validator";
import { decodeAnalysisJobRequest } from "@/common/analysis/types";
import { identifier, counter } from "@/common/analysis/validation";
import { analysisTexts } from "@/common/i18n/analysis";
import { AnalysisJobManager, analysisJobManager } from "@/server/analysis/jobManager";
import { HttpError } from "@/server/errors";
import { createBodyLimit, LARGE_BODY_LIMIT, type AppEnv } from "@/server/hono";
import { parseJsonObject } from "./body";

function id(value: string): string {
  try {
    return identifier(value);
  } catch {
    throw new HttpError(400, analysisTexts().invalid);
  }
}

export const createAnalysisJobRoutes = (manager: AnalysisJobManager = analysisJobManager) =>
  new Hono<AppEnv>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get("/capabilities", (c) => c.json(manager.capabilities()))
    .post(
      "/",
      createBodyLimit(LARGE_BODY_LIMIT),
      validator("json", (value) => {
        const decoded = decodeAnalysisJobRequest(parseJsonObject(value));
        if (!decoded.ok) throw new HttpError(400, analysisTexts().invalid);
        return decoded.value;
      }),
      (c) => c.json(manager.create(c.req.valid("json")).status(), 202),
    )
    .get("/by-request/:requestId", (c) =>
      c.json(manager.byRequest(id(c.req.param("requestId"))).status()),
    )
    .get("/:jobId/source", (c) => c.json(manager.get(id(c.req.param("jobId"))).request.source))
    .get(
      "/:jobId/result",
      validator("query", (value) => {
        const raw = value.afterRevision;
        if (raw === undefined) return { afterRevision: 0 };
        if (typeof raw !== "string" || !/^\d+$/.test(raw))
          throw new HttpError(400, analysisTexts().invalid);
        try {
          return { afterRevision: counter(Number(raw)) };
        } catch {
          throw new HttpError(400, analysisTexts().invalid);
        }
      }),
      (c) => {
        const job = manager.get(id(c.req.param("jobId")));
        const after = c.req.valid("query").afterRevision;
        if (after > job.status().resultRevision) throw new HttpError(409, analysisTexts().invalid);
        return c.json(job.result(after));
      },
    )
    .post("/:jobId/cancel", (c) => {
      const job = manager.get(id(c.req.param("jobId")));
      job.cancel();
      return c.json(job.status(), 202);
    })
    .get("/:jobId", (c) => c.json(manager.get(id(c.req.param("jobId"))).status()));

export const analysisJobRoutes = createAnalysisJobRoutes();
