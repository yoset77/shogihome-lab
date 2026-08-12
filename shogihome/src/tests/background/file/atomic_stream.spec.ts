import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeStreamAtomic } from "@/server/file/atomic_stream";

describe("file/atomic_stream", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-atomic-stream-"));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("waits for the handler to stop after an asynchronous stream error", async () => {
    const outputPath = path.join(rootDir, "result.sfen");
    fs.mkdirSync(`${outputPath}.tmp`);
    let releaseHandler!: () => void;
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let outcome: "pending" | "resolved" | "rejected" = "pending";

    const result = writeStreamAtomic(outputPath, async () => {
      await handlerBlocked;
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(outcome).toBe("pending");
    releaseHandler();
    await result;
    expect(outcome).toBe("rejected");
  });
});
