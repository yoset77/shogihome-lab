import { Hono } from "hono";
import { validator } from "hono/validator";
import { decodeAnalysisJobRequest, decodeBatchJobRequest } from "@/common/analysis/types";
import { readBatchSource, MAX_BATCH_FILES } from "@/common/analysis/batch";
import { BatchAnalysisJob } from "@/server/analysis/batch";
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
      ...(input.authorization === undefined
        ? {}
        : { authorization: readJobBinding(input.authorization) }),
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
    .post(
      "/batch/prepare",
      createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
      validator("json", (value) => {
        try {
          return readBatchSource(parseJsonObject(value));
        } catch {
          throw new HttpError(400, t.batchAnalysisInvalid);
        }
      }),
      async (c) => c.json(await manager.prepareBatch(c.req.valid("json"))),
    )
    .post(
      "/batch",
      createBodyLimit(DEFAULT_JSON_BODY_LIMIT),
      validator("json", (value) => {
        const decoded = decodeBatchJobRequest(parseJsonObject(value));
        if (!decoded.ok) throw new HttpError(400, t.batchAnalysisInvalid);
        return decoded.value;
      }),
      (c) => c.json(manager.createBatch(c.req.valid("json")).status(), 202),
    )
    .get("/:jobId/files", (c) => {
      const job = manager.get(id(c.req.param("jobId")));
      if (!(job instanceof BatchAnalysisJob)) throw new HttpError(400, t.batchAnalysisInvalid);
      return c.json(job.fileResults());
    })
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
    .get(
      "/:jobId/source",
      validator("query", (value) => {
        const index = value.recordIndex;
        try {
          if (index !== undefined && (typeof index !== "string" || !/^\d+$/.test(index)))
            throw new Error("Invalid record index");
          return index === undefined
            ? {}
            : { recordIndex: String(counter(Number(index), MAX_BATCH_FILES)) };
        } catch {
          throw new HttpError(400, t.analysisJobInvalid);
        }
      }),
      (c) => {
        const job = manager.get(id(c.req.param("jobId")));
        const index = c.req.valid("query").recordIndex;
        return c.json(
          job instanceof BatchAnalysisJob
            ? job.source(index === undefined ? undefined : counter(Number(index)))
            : job.source(),
        );
      },
    )
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
      job.cancelOwned(
        c.req.valid("json"),
        c.req.valid("json").requestId,
        c.req.valid("json").authorization,
      );
      return c.json(job.status(), 202);
    })
    .get(
      "/:jobId/result",
      validator("query", (value) => {
        const raw = value.afterRevision;
        if (raw !== undefined && (typeof raw !== "string" || !/^\d+$/.test(raw)))
          throw new HttpError(400, t.analysisJobInvalid);
        try {
          const recordIndex = value.recordIndex;
          if (
            recordIndex !== undefined &&
            (typeof recordIndex !== "string" || !/^\d+$/.test(recordIndex))
          )
            throw new Error("Invalid record index");
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
            ...(recordIndex === undefined
              ? {}
              : { recordIndex: String(counter(Number(recordIndex), MAX_BATCH_FILES)) }),
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
        const result =
          job instanceof BatchAnalysisJob
            ? job.result(
                after,
                query.recordIndex === undefined ? undefined : Number(query.recordIndex),
              )
            : job.result(after);
        if (after > result.revision) throw new HttpError(409, t.analysisJobInvalid);
        return c.json(result);
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
