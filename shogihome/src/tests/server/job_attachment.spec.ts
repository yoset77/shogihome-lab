import { JobAttachment } from "@/server/jobs/attachment";
import { HttpError } from "@/server/errors";
import { readJobAttachRequest } from "@/common/jobs/types";

describe("job attachment", () => {
  it("fences cancellation from a screen replaced during recovery", () => {
    const attachment = new JobAttachment();
    const first = attachment.claim({
      ownerId: "owner",
      epoch: 0,
      screenId: "first",
      takeover: false,
    });
    attachment.suspend(first);
    attachment.claim({ ...first, screenId: "second", takeover: false });
    expect(() => attachment.authorizeOperation(first)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("requires a screen and does not expose the owner in public attachment state", () => {
    expect(() => readJobAttachRequest({ ownerId: "owner", epoch: 0, takeover: false })).toThrow();
    const attachment = new JobAttachment();
    attachment.claim({ ownerId: "owner", epoch: 0, screenId: "screen", takeover: false });
    expect(attachment.status()).not.toHaveProperty("ownerId");
  });

  it("allows a missing recovery token only on the original acquisition retry", () => {
    const attachment = new JobAttachment();
    const request = { ownerId: "owner", epoch: 0, screenId: "screen", takeover: false };
    const first = attachment.claim(request);
    expect(attachment.claim(request)).toEqual(first);
    expect(() => attachment.claim({ ...request, epoch: first.epoch })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });
  it("replays an original operation only with the recovered screen's current authorization", () => {
    const attachment = new JobAttachment();
    const first = attachment.claim({
      ownerId: "owner",
      epoch: 0,
      screenId: "first",
      takeover: false,
    });
    attachment.suspend(first);
    const current = attachment.claim({ ...first, screenId: "second", takeover: false });
    expect(() => attachment.authorizeOperation(first, current)).not.toThrow();
    expect(() => attachment.authorizeOperation(first, first)).toThrow();
    expect(() =>
      attachment.authorizeOperation(first, { ...current, recoveryId: undefined }),
    ).toThrow();
    expect(() => attachment.authorizeOperation(first)).toThrow();
  });

  it("requires explicit takeover and fences the previous owner", () => {
    const attachment = new JobAttachment();
    const first = attachment.claim({
      ownerId: "first",
      epoch: 0,
      takeover: false,
      screenId: "first",
    });
    expect(() =>
      attachment.claim({
        ownerId: "second",
        epoch: first.epoch,
        takeover: false,
        screenId: "second",
      }),
    ).toThrow(HttpError);
    const second = attachment.claim({
      ownerId: "second",
      epoch: first.epoch,
      takeover: true,
      screenId: "second",
    });
    expect(() => attachment.touch(first)).toThrow(HttpError);
    expect(() => attachment.claim({ ...first, takeover: false })).toThrow(HttpError);
    attachment.release(first);
    expect(attachment.status().attached).toBe(true);
    attachment.release(second);
    expect(attachment.status().attached).toBe(false);
  });

  it("retains the epoch across disconnects and makes retries idempotent", () => {
    const attachment = new JobAttachment();
    const first = attachment.claim({
      ownerId: "first",
      epoch: 0,
      takeover: false,
      screenId: "first",
    });
    expect(
      attachment.claim({ ownerId: "first", epoch: 0, takeover: false, screenId: "first" }),
    ).toEqual(first);
    attachment.release(first);
    const second = attachment.claim({
      ownerId: "second",
      screenId: "second",
      epoch: attachment.status().epoch,
      takeover: false,
    });
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(() => attachment.claim({ ...first, takeover: false })).toThrow(HttpError);
  });

  it("allows recovery after a heartbeat timeout only while ownership has not changed", () => {
    vi.useFakeTimers();
    try {
      const attachment = new JobAttachment();
      const first = attachment.claim({
        ownerId: "first",
        epoch: 0,
        takeover: false,
        screenId: "first",
      });
      vi.advanceTimersByTime(30_001);
      expect(attachment.status().attached).toBe(false);
      attachment.touch(first);
      expect(attachment.status().attached).toBe(true);
      vi.advanceTimersByTime(30_001);
      attachment.claim({
        ownerId: "second",
        epoch: first.epoch,
        takeover: false,
        screenId: "second",
      });
      expect(() => attachment.touch(first)).toThrow(HttpError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let copied recovery information replace a live document automatically", () => {
    const attachment = new JobAttachment();
    const first = attachment.claim({
      ownerId: "tab",
      epoch: 0,
      takeover: false,
      screenId: "document-1",
    });
    expect(first.recoveryId).toBeTruthy();
    const copy = { ...first, screenId: "document-2", takeover: false };
    expect(() => attachment.claim(copy)).toThrow(expect.objectContaining({ status: 423 }));
    attachment.touch(first);
    attachment.suspend(first);
    const restored = attachment.claim(copy);
    expect(restored.epoch).toBeGreaterThan(first.epoch);
    expect(() => attachment.touch(first)).toThrow(HttpError);
    expect(() => attachment.claim({ ...first, takeover: false })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(attachment.claim(copy)).toEqual(restored);
  });
});
