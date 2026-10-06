import { Hono } from "hono";
import { validator } from "hono/validator";
import { decodeAnalysisJobRequest } from "@/common/analysis/types";
import { identifier, counter } from "@/common/analysis/validation";
import { t } from "@/common/i18n";
import { AnalysisJobManager, analysisJobManager } from "@/server/analysis/jobManager";
import { HttpError } from "@/server/errors";
import {
  createBodyLimit,
  LARGE_BODY_LIMIT,
  DEFAULT_JSON_BODY_LIMIT,
  type AppEnv,
} from "@/server/hono";
import { parseJsonObject } from "./body";
import { readJobAttachRequest, readJobBinding } from "@/common/jobs/types";

const attachInput = validator("json", (value) => {
  try {
    return readJobAttachRequest(parseJsonObject(value));
  } catch {
    throw new HttpError(400, t.jobsInvalid);
  }
});
const bindingInput = validator("json", (value) => {
  try {
    return readJobBinding(parseJsonObject(value));
  } catch {
    throw new HttpError(400, t.jobsInvalid);
  }
});
const cancelInput = validator("json", (value) => {
  try {
    const input = parseJsonObject(value);
    return {
      ...readJobBinding(input),
      ...(input.requestId === undefined ? {} : { requestId: identifier(input.requestId) }),
    };
  } catch {
    throw new HttpError(400, t.jobsInvalid);
  }
});

function id(value: string): string {
  try {
    return identifier(value);
  } catch {
    throw new HttpError(400, t.analysisJobInvalid);
  }
}

export const createAnalysisJobRoutes = (manager: AnalysisJobManager = analysisJobManager) =>
  new Hono<AppEnv>()
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get("/capabilities", (c) => c.json(manager.capabilities()))
    .get("/", (c) => c.json(manager.list()))
    .get("/:jobId/cancellations/:requestId", (c) =>
      c.json(manager.get(id(c.req.param("jobId"))).cancelOutcome(id(c.req.param("requestId")))),
    )
    .post(
      "/",
      createBodyLimit(LARGE_BODY_LIMIT),
      validator("json", (value) => {
        const decoded = decodeAnalysisJobRequest(parseJsonObject(value));
        if (!decoded.ok) throw new HttpError(400, t.analysisJobInvalid);
        return decoded.value;
      }),
      (c) => c.json(manager.create(c.req.valid("json")).status(), 202),
    )
    .get("/by-request/:requestId", (c) =>
      c.json(manager.byRequest(id(c.req.param("requestId"))).status()),
    )
    .get("/:jobId/source", (c) => c.json(manager.get(id(c.req.param("jobId"))).request.source))
    .post("/:jobId/attach", createBodyLimit(DEFAULT_JSON_BODY_LIMIT), attachInput, (c) =>
      c.json(manager.get(id(c.req.param("jobId"))).attachment.claim(c.req.valid("json"))),
    )
    .post("/:jobId/detach", createBodyLimit(DEFAULT_JSON_BODY_LIMIT), bindingInput, (c) => {
      const job = manager.get(id(c.req.param("jobId")));
      job.attachment.release(c.req.valid("json"));
      return c.json(job.status());
    })
    .post("/:jobId/suspend", createBodyLimit(DEFAULT_JSON_BODY_LIMIT), bindingInput, (c) => {
      const job = manager.get(id(c.req.param("jobId")));
      job.attachment.suspend(c.req.valid("json"));
      return c.json(job.status());
    })
    .post(
      "/:jobId/attached-status",
      createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
      bindingInput,
      (c) => {
        const job = manager.get(id(c.req.param("jobId")));
        job.attachment.touch(c.req.valid("json"));
        return c.json(job.status());
      },
    )
    .post("/:jobId/attached-cancel", createBodyLimit(DEFAULT_JSON_BODY_LIMIT), cancelInput, (c) => {
      const job = manager.get(id(c.req.param("jobId")));
      job.cancelOwned(c.req.valid("json"), c.req.valid("json").requestId);
      return c.json(job.status(), 202);
    })
    .get(
      "/:jobId/result",
      validator("query", (value) => {
        const raw = value.afterRevision;
        if (raw !== undefined && (typeof raw !== "string" || !/^\d+$/.test(raw)))
          throw new HttpError(400, t.analysisJobInvalid);
        try {
          const epoch = value.epoch;
          if (epoch !== undefined && (typeof epoch !== "string" || !/^\d+$/.test(epoch)))
            throw new Error("Invalid epoch");
          const binding =
            value.ownerId === undefined && epoch === undefined
              ? undefined
              : readJobBinding({
                  ownerId: value.ownerId,
                  epoch: Number(epoch),
                  screenId: value.screenId,
                  recoveryId: value.recoveryId,
                });
          return {
            afterRevision: raw === undefined ? 0 : counter(Number(raw)),
            ...(binding
              ? {
                  ownerId: binding.ownerId,
                  epoch: String(binding.epoch),
                  screenId: binding.screenId,
                  recoveryId: binding.recoveryId,
                }
              : {}),
          };
        } catch {
          throw new HttpError(400, t.analysisJobInvalid);
        }
      }),
      (c) => {
        const job = manager.get(id(c.req.param("jobId")));
        const query = c.req.valid("query");
        if (query.ownerId)
          job.attachment.touch({
            ownerId: query.ownerId,
            epoch: Number(query.epoch),
            screenId: query.screenId,
            recoveryId: query.recoveryId,
          });
        const after = c.req.valid("query").afterRevision;
        if (after > job.status().resultRevision) throw new HttpError(409, t.analysisJobInvalid);
        return c.json(job.result(after));
      },
    )
    .post("/:jobId/cancel", (c) => {
      const job = manager.get(id(c.req.param("jobId")));
      if (job.attachment.status().epoch > 0) throw new HttpError(409, t.jobsTransferred);
      job.cancel();
      return c.json(job.status(), 202);
    })
    .get("/:jobId", (c) => c.json(manager.get(id(c.req.param("jobId"))).status()));

export const analysisJobRoutes = createAnalysisJobRoutes();
