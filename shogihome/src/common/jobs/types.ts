import * as v from "@/common/analysis/validation";
import type { DecodeResult } from "@/common/engine/relay_protocol";
import { readBatchProgress, type BatchAnalysisProgress } from "@/common/analysis/batch";
import { readParallelGameProgress, type ParallelGameProgress } from "@/common/game/parallel";

export type JobBinding = {
  ownerId: string;
  epoch: number;
  recoveryId?: string;
  screenId?: string;
  generation?: number;
};
export type JobAttachRequest = JobBinding & { takeover: boolean; screenId: string };
export type JobAttachmentState = { epoch: number; attached: boolean; generation?: number };
export type JobOperationOutcome = { state: "unknown" | "pending" | "accepted" | "rejected" };

export function decodeJobOperationOutcome(value: unknown): DecodeResult<JobOperationOutcome> {
  try {
    return {
      ok: true,
      value: {
        state: v.enumeration(v.object(value).state, [
          "unknown",
          "pending",
          "accepted",
          "rejected",
        ] as const),
      },
    };
  } catch {
    return { ok: false, error: "Invalid operation outcome" };
  }
}
export type JobSummary = {
  kind: "analysis" | "game";
  id: string;
  requestId: string;
  serverInstanceId: string;
  createdAt: number;
  state:
    | "preparing"
    | "running"
    | "paused"
    | "takingBack"
    | "finishing"
    | "cancelling"
    | "completed"
    | "cancelled"
    | "failed";
  engines: string[];
  completed: number;
  total: number;
  attachment: JobAttachmentState;
  batch?: BatchAnalysisProgress;
  parallelGame?: ParallelGameProgress;
};

export function readJobBinding(value: unknown): JobBinding {
  const input = v.object(value);
  return {
    ownerId: v.identifier(input.ownerId),
    epoch: v.counter(input.epoch),
    ...(input.recoveryId === undefined ? {} : { recoveryId: v.identifier(input.recoveryId) }),
    ...(input.screenId === undefined ? {} : { screenId: v.identifier(input.screenId) }),
    ...(input.generation === undefined ? {} : { generation: v.counter(input.generation) }),
  };
}

export function readJobAttachRequest(value: unknown): JobAttachRequest {
  const input = v.object(value);
  return {
    ...readJobBinding(input),
    screenId: v.identifier(input.screenId),
    takeover: v.boolean(input.takeover),
  };
}

export function readJobAttachment(value: unknown): JobAttachmentState {
  const input = v.object(value);
  return {
    epoch: v.counter(input.epoch),
    attached: v.boolean(input.attached),
    ...(input.generation === undefined ? {} : { generation: v.counter(input.generation) }),
  };
}

export function decodeJobBinding(value: unknown): DecodeResult<JobBinding> {
  try {
    return { ok: true, value: readJobBinding(value) };
  } catch {
    return { ok: false, error: "Invalid job binding" };
  }
}

export function decodeJobList(value: unknown): DecodeResult<JobSummary[]> {
  try {
    return {
      ok: true,
      value: v.array(value, 22).map((value) => {
        const input = v.object(value);
        const kind = v.enumeration(input.kind, ["analysis", "game"] as const);
        const completed = v.counter(input.completed);
        const total = v.counter(input.total);
        const attachment = readJobAttachment(input.attachment);
        const parallelGame =
          input.parallelGame === undefined
            ? undefined
            : readParallelGameProgress(input.parallelGame);
        if (
          parallelGame &&
          (kind !== "game" ||
            input.batch !== undefined ||
            attachment.attached ||
            parallelGame.results.total !== completed ||
            completed + parallelGame.activeGames > total)
        )
          throw new Error("Invalid parallel game job");
        return {
          kind,
          id: v.identifier(input.id),
          requestId: v.identifier(input.requestId),
          serverInstanceId: v.identifier(input.serverInstanceId),
          createdAt: v.counter(input.createdAt),
          state: v.enumeration(input.state, [
            "preparing",
            "running",
            "paused",
            "takingBack",
            "finishing",
            "cancelling",
            "completed",
            "cancelled",
            "failed",
          ] as const),
          engines: v.array(input.engines, 2).map((value) => v.text(value, 1024)),
          completed,
          total,
          attachment,
          ...(input.batch === undefined ? {} : { batch: readBatchProgress(input.batch) }),
          ...(parallelGame ? { parallelGame } : {}),
        };
      }),
    };
  } catch {
    return { ok: false, error: "Invalid job list" };
  }
}
