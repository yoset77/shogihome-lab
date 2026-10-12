import type { JobAttachRequest, JobAttachmentState, JobBinding } from "@/common/jobs/types";
import { t } from "@/common/i18n";
import { HttpError } from "@/server/errors";
import { randomUUID } from "node:crypto";
import {
  claimJobControl,
  isCurrentJobBinding,
  authorizeJobOperation,
  type JobControl,
} from "./control";

export class JobAttachment {
  private epoch = 0;
  private ownerId?: string;
  private lastSeen = 0;
  private acquisitionEpoch = 0;
  private recoveryId?: string;
  private screenId?: string;
  private generation = 0;

  private control(): JobControl {
    return {
      ownerId: this.ownerId,
      epoch: this.epoch,
      acquisitionEpoch: this.acquisitionEpoch,
      recoveryId: this.recoveryId,
      screenId: this.screenId,
      attached: this.status().attached,
    };
  }

  status(): JobAttachmentState {
    return {
      epoch: this.epoch,
      attached: !!this.ownerId && Date.now() - this.lastSeen < 30_000,
      generation: this.generation,
    };
  }

  claim(request: JobAttachRequest): JobBinding & { screenId: string } {
    const transition = claimJobControl(this.control(), request);
    if (transition !== "acquire") {
      if (transition === "recover") {
        this.acquisitionEpoch = request.epoch;
        ++this.epoch;
        this.screenId = request.screenId;
      }
      this.lastSeen = Date.now();
      return {
        ownerId: request.ownerId,
        epoch: this.epoch,
        recoveryId: this.recoveryId,
        screenId: this.screenId!,
        generation: this.generation,
      };
    }
    this.ownerId = request.ownerId;
    this.acquisitionEpoch = request.epoch;
    this.recoveryId = randomUUID();
    this.screenId = request.screenId;
    this.lastSeen = Date.now();
    ++this.generation;
    return {
      ownerId: request.ownerId,
      epoch: ++this.epoch,
      recoveryId: this.recoveryId,
      screenId: this.screenId,
      generation: this.generation,
    };
  }

  touch(binding: JobBinding): void {
    if (!isCurrentJobBinding(this.control(), binding)) throw new HttpError(409, t.jobsTransferred);
    this.lastSeen = Date.now();
  }
  authorizeOperation(binding: JobBinding, authorization?: JobBinding): void {
    authorizeJobOperation(this.control(), binding, authorization);
  }

  release(binding: JobBinding): void {
    if (isCurrentJobBinding(this.control(), binding)) {
      this.ownerId = undefined;
      ++this.epoch;
      ++this.generation;
    }
  }
  suspend(binding: JobBinding): void {
    if (isCurrentJobBinding(this.control(), binding)) this.lastSeen = -Infinity;
  }
}
