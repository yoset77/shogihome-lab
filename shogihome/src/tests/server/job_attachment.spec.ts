import { JobAttachment } from "@/server/jobs/attachment";
import { HttpError } from "@/server/errors";

describe("job attachment", () => {
  it("requires explicit takeover and fences the previous owner", () => {
    const attachment = new JobAttachment();
    const first = attachment.claim({ ownerId: "first", epoch: 0, takeover: false });
    expect(() =>
      attachment.claim({ ownerId: "second", epoch: first.epoch, takeover: false }),
    ).toThrow(HttpError);
    const second = attachment.claim({ ownerId: "second", epoch: first.epoch, takeover: true });
    expect(() => attachment.touch(first)).toThrow(HttpError);
    expect(() => attachment.claim({ ...first, takeover: false })).toThrow(HttpError);
    attachment.release(first);
    expect(attachment.status().attached).toBe(true);
    attachment.release(second);
    expect(attachment.status().attached).toBe(false);
  });

  it("retains the epoch across disconnects and makes retries idempotent", () => {
    const attachment = new JobAttachment();
    const first = attachment.claim({ ownerId: "first", epoch: 0, takeover: false });
    expect(attachment.claim({ ownerId: "first", epoch: 0, takeover: false })).toEqual(first);
    attachment.release(first);
    const second = attachment.claim({
      ownerId: "second",
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
      const first = attachment.claim({ ownerId: "first", epoch: 0, takeover: false });
      vi.advanceTimersByTime(30_001);
      expect(attachment.status().attached).toBe(false);
      attachment.touch(first);
      expect(attachment.status().attached).toBe(true);
      vi.advanceTimersByTime(30_001);
      attachment.claim({ ownerId: "second", epoch: first.epoch, takeover: false });
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
      expect.objectContaining({ status: 423 }),
    );
    expect(attachment.claim(copy)).toEqual(restored);
  });
});
