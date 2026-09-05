import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
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
    let releaseHandler!: () => void;
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let outcome: "pending" | "resolved" | "rejected" = "pending";

    const result = writeStreamAtomic(outputPath, async (stream) => {
      setTimeout(() => stream.destroy(new Error("stream failed")), 0);
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

  it("does not replace an existing file when overwrite is disabled", async () => {
    const outputPath = path.join(rootDir, "result.sfen");
    fs.writeFileSync(outputPath, "old");

    await expect(
      writeStreamAtomic(
        outputPath,
        async (stream) => {
          stream.end("new");
          await finished(stream);
        },
        { overwrite: false },
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(fs.readFileSync(outputPath, "utf8")).toBe("old");
  });

  it("replaces a file after a successful streamed write", async () => {
    const outputPath = path.join(rootDir, "result.sfen");
    fs.writeFileSync(outputPath, "old");

    await writeStreamAtomic(outputPath, async (stream) => {
      stream.end("new");
      await finished(stream);
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe("new");
    expect(fs.readdirSync(rootDir)).toEqual(["result.sfen"]);
  });

  it("supports long multibyte filenames without exceeding the temporary name limit", async () => {
    const name = "\u68cb".repeat(75) + ".kif";
    const outputPath = path.join(rootDir, name);

    await writeStreamAtomic(outputPath, async (stream) => {
      stream.end("kifu");
      await finished(stream);
    });

    expect(fs.readFileSync(outputPath, "utf8")).toBe("kifu");
    expect(fs.readdirSync(rootDir)).toEqual([name]);
  });
});
