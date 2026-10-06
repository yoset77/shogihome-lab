import type { JobAttachRequest, JobAttachmentState, JobBinding } from "@/common/jobs/types";
import { jobTexts } from "@/common/i18n/jobs";
import { HttpError } from "@/server/errors";
import { randomUUID } from "node:crypto";

export class JobAttachment {
  private epoch = 0;
  private ownerId?: string;
  private lastSeen = 0;
  private acquisitionEpoch = 0;
  private recoveryId?: string;
  private screenId?: string;

  status(): JobAttachmentState {
    return {
      epoch: this.epoch,
      attached: !!this.ownerId && Date.now() - this.lastSeen < 30_000,
      ...(this.ownerId ? { ownerId: this.ownerId } : {}),
    };
  }

  claim(request: JobAttachRequest): JobBinding {
    const current = this.status();
    if (
      current.ownerId === request.ownerId &&
      (request.epoch === this.epoch || request.epoch === this.acquisitionEpoch) &&
      (request.recoveryId === undefined || request.recoveryId === this.recoveryId)
    ) {
      if (this.screenId !== undefined && request.screenId !== this.screenId) {
        if (current.attached) throw new HttpError(423, jobTexts().occupied);
        this.acquisitionEpoch = request.epoch;
        ++this.epoch;
        this.screenId = request.screenId;
      }
      this.lastSeen = Date.now();
      return {
        ownerId: request.ownerId,
        epoch: this.epoch,
        recoveryId: this.recoveryId,
        screenId: this.screenId,
      };
    }
    if (request.epoch !== this.epoch || (current.attached && !request.takeover))
      throw new HttpError(409, jobTexts().transferred);
    this.ownerId = request.ownerId;
    this.acquisitionEpoch = request.epoch;
    this.recoveryId = randomUUID();
    this.screenId = request.screenId;
    this.lastSeen = Date.now();
    return {
      ownerId: request.ownerId,
      epoch: ++this.epoch,
      recoveryId: this.recoveryId,
      screenId: this.screenId,
    };
  }

  touch(binding: JobBinding): void {
    const current = this.status();
    if (
      binding.ownerId !== current.ownerId ||
      binding.epoch !== this.epoch ||
      binding.screenId !== this.screenId ||
      (binding.recoveryId !== undefined && binding.recoveryId !== this.recoveryId)
    )
      throw new HttpError(409, jobTexts().transferred);
    this.lastSeen = Date.now();
  }
  authorizeOperation(binding: JobBinding): void {
    if (
      binding.recoveryId !== undefined &&
      binding.recoveryId === this.recoveryId &&
      binding.ownerId === this.ownerId &&
      binding.epoch <= this.epoch
    )
      return;
    this.touch(binding);
  }

  release(binding: JobBinding): void {
    if (
      binding.ownerId === this.ownerId &&
      binding.epoch === this.epoch &&
      binding.screenId === this.screenId
    ) {
      this.ownerId = undefined;
      ++this.epoch;
    }
  }
  suspend(binding: JobBinding): void {
    if (
      binding.ownerId === this.ownerId &&
      binding.epoch === this.epoch &&
      binding.screenId === this.screenId
    )
      this.lastSeen = -Infinity;
  }
}
