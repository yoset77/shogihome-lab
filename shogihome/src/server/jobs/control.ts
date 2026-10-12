import type { JobAttachRequest, JobBinding } from "@/common/jobs/types";
import { t } from "@/common/i18n";
import { HttpError } from "@/server/errors";

export type JobControl = {
  ownerId?: string;
  epoch: number;
  acquisitionEpoch?: number;
  recoveryId?: string;
  screenId?: string;
  attached: boolean;
};

// Transport owners apply the transition; authorization is shared across jobs.
export function claimJobControl(
  state: JobControl,
  request: JobAttachRequest,
): "retry" | "recover" | "acquire" {
  if (!request.screenId) throw new HttpError(400, t.jobsInvalid);
  if (request.ownerId === state.ownerId) {
    if (
      (request.epoch !== state.epoch && request.epoch !== state.acquisitionEpoch) ||
      (request.recoveryId === undefined
        ? request.epoch !== state.acquisitionEpoch || request.screenId !== state.screenId
        : request.recoveryId !== state.recoveryId)
    )
      throw new HttpError(409, t.jobsTransferred);
    if (request.screenId !== state.screenId) {
      if (request.epoch !== state.epoch) throw new HttpError(409, t.jobsTransferred);
      if (state.attached) throw new HttpError(423, t.jobsOccupied);
      return "recover";
    }
    return "retry";
  }
  if (request.epoch !== state.epoch || (state.attached && !request.takeover))
    throw new HttpError(409, t.jobsTransferred);
  return "acquire";
}

export function isCurrentJobBinding(state: JobControl, binding: JobBinding): boolean {
  return (
    !!state.screenId &&
    binding.screenId === state.screenId &&
    binding.ownerId === state.ownerId &&
    binding.epoch === state.epoch &&
    (binding.recoveryId === undefined || binding.recoveryId === state.recoveryId)
  );
}

export function authorizeJobOperation(
  state: JobControl,
  binding: JobBinding,
  authorization?: JobBinding,
): void {
  if (
    authorization &&
    (!isCurrentJobBinding(state, authorization) ||
      authorization.recoveryId === undefined ||
      authorization.recoveryId !== state.recoveryId)
  )
    throw new HttpError(409, t.jobsTransferred);
  if (
    binding.ownerId === state.ownerId &&
    binding.recoveryId !== undefined &&
    binding.recoveryId === state.recoveryId &&
    binding.epoch <= state.epoch &&
    (authorization !== undefined || (!!state.screenId && binding.screenId === state.screenId))
  )
    return;
  if (!authorization && isCurrentJobBinding(state, binding)) return;
  throw new HttpError(409, t.jobsTransferred);
}
