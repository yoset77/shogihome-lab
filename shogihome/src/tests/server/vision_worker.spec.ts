import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.VISION_TIMEOUT_MS = "1000";
});

import { VisionWorkerClient } from "@/server/vision/worker";

const request = (imagePath: string) => ({
  type: "scan" as const,
  imagePath,
  sideToMove: "black" as const,
  maxCandidates: 1,
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

const createSerialClient = (): { client: VisionWorkerClient; dispatchLog: string } => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-worker-"));
  tempDirs.push(tempDir);
  const dispatchLog = path.join(tempDir, "dispatch.log");
  const client = new VisionWorkerClient();
  client.resolveConfig = () => ({
    command: process.execPath,
    args: ["src/tests/server/helpers/mock_vision_serial_cli.mjs", dispatchLog],
  });
  return { client, dispatchLog };
};

const readDispatches = (dispatchLog: string): string[] =>
  fs.existsSync(dispatchLog)
    ? fs.readFileSync(dispatchLog, "utf-8").trim().split("\n").filter(Boolean)
    : [];

describe("VisionWorkerClient", () => {
  it("rejects pending requests when the worker returns an unknown id", async () => {
    const client = new VisionWorkerClient();
    client.resolveConfig = () => ({
      command: process.execPath,
      args: ["src/tests/server/helpers/mock_vision_unknown_id_cli.mjs"],
    });

    await expect(
      client.scan({
        type: "scan",
        imagePath: "unused.png",
        sideToMove: "black",
        maxCandidates: 1,
      }),
    ).rejects.toThrow("unknown response id");
  });

  it("dispatches scans one at a time in FIFO order", async () => {
    const { client, dispatchLog } = createSerialClient();

    const first = client.scan(request("slow"));
    const second = client.scan(request("ok"));

    await vi.waitFor(() => expect(readDispatches(dispatchLog)).toEqual(["slow"]));
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(readDispatches(dispatchLog)).toEqual(["slow"]);
    await first;
    await second;
    await client.scan(request("ok-exit"));

    expect(readDispatches(dispatchLog)).toEqual(["slow", "ok", "ok-exit"]);
  });

  it.each([
    ["timeout", "vision worker timed out"],
    ["crash", "vision worker exited with code 1"],
    ["invalid-json", "vision worker returned invalid JSON"],
  ])("continues the queue with a fresh worker after %s", async (mode, message) => {
    const { client, dispatchLog } = createSerialClient();

    const failed = client.scan(request(mode));
    const queued = client.scan(request("ok-exit"));

    await expect(failed).rejects.toThrow(message);
    await expect(queued).resolves.toMatchObject({ ok: true });
    expect(readDispatches(dispatchLog)).toEqual([mode, "ok-exit"]);
  });

  it("ignores delayed output and close events from a replaced worker", async () => {
    const { client, dispatchLog } = createSerialClient();

    const failed = client.scan(request("stale-output"));
    const queued = client.scan(request("slow-exit"));

    await expect(failed).rejects.toThrow("vision worker returned invalid JSON");
    await expect(queued).resolves.toMatchObject({ ok: true });
    expect(readDispatches(dispatchLog)).toEqual(["stale-output", "slow-exit"]);
  });

  it("starts a fresh worker when the previous worker exits after a successful response", async () => {
    const { client, dispatchLog } = createSerialClient();

    const exiting = client.scan(request("ok-exit"));
    const queued = client.scan(request("ok"));

    await expect(exiting).resolves.toMatchObject({ ok: true });
    await expect(queued).resolves.toMatchObject({ ok: true });
    await client.scan(request("ok-exit"));
    expect(readDispatches(dispatchLog)).toEqual(["ok-exit", "ok", "ok-exit"]);
  });

  it("rejects scans beyond the bounded pending queue", async () => {
    const { client } = createSerialClient();
    const accepted = [client.scan(request("slow"))];
    for (let i = 0; i < 7; i++) {
      accepted.push(client.scan(request("ok")));
    }

    await expect(client.scan(request("overflow"))).rejects.toThrow("vision worker queue is full");
    await expect(Promise.all(accepted)).resolves.toHaveLength(8);
    await client.scan(request("ok-exit"));
  });
});
