import { guardJobRecovery, JobTabGuard, releaseJobTab } from "@/renderer/store/job_tab_guard";

describe("job document recovery guard", () => {
  afterEach(() => {
    releaseJobTab("game");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("rejects copied tab authority while the original document holds its lock", async () => {
    const held = new Set<string>();
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          name: string,
          _options: unknown,
          callback: (lock: object | null) => Promise<void>,
        ) => {
          if (held.has(name)) return callback(null);
          held.add(name);
          try {
            await callback({});
          } finally {
            held.delete(name);
          }
        },
      },
    });
    const original = new JobTabGuard();
    const copied = new JobTabGuard();
    expect(await original.acquire("authority")).toBe(true);
    expect(await original.acquire("authority")).toBe(true);
    expect(await copied.acquire("authority")).toBe(false);
    copied.release();
    original.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(await copied.acquire("authority")).toBe(true);
    copied.release();
  });

  it("elects only one restoring document on HTTP origins using BroadcastChannel", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {});
    const channels = new Set<FakeChannel>();
    class FakeChannel {
      onmessage?: (event: MessageEvent<unknown>) => void;
      constructor(readonly name: string) {
        channels.add(this);
      }
      postMessage(data: unknown): void {
        for (const other of channels) {
          if (other !== this && other.name === this.name)
            queueMicrotask(() => {
              if (channels.has(other)) other.onmessage?.({ data } as MessageEvent);
            });
        }
      }
      close(): void {
        channels.delete(this);
      }
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const first = new JobTabGuard();
    const second = new JobTabGuard();
    const restoring = Promise.all([
      first.acquire("copied-authority"),
      second.acquire("copied-authority"),
    ]);
    await vi.advanceTimersByTimeAsync(150);
    expect((await restoring).filter(Boolean)).toHaveLength(1);
    first.release();
    second.release();
  });

  it("fails closed when live-document exclusion is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(await new JobTabGuard().acquire("authority")).toBe(false);
  });

  it("guards a durable candidate without attaching it and retries after an occupied tab closes", async () => {
    let occupied = true;
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          callback: (lock: object | null) => Promise<void>,
        ) => callback(occupied ? null : {}),
      },
    });
    sessionStorage.clear();
    const reference = { serverInstanceId: "server", requestId: "request", controllerId: "owner" };
    expect(await guardJobRecovery("game", reference)).toBe(false);
    occupied = false;
    expect(await guardJobRecovery("game", reference)).toBe(true);
    expect(sessionStorage.getItem("shogihome-job-attachment:game")).toBeNull();
  });
});
