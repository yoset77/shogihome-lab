import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, initDatabase, upsertKifuFile } from "@/server/database/kifu_index";
import {
  getSfenExportJob,
  resetSfenExportJobsForTesting,
  startSfenExportJob,
} from "@/server/kifu_export/job";
import { encodeText } from "@/common/helpers/encode";

describe("kifu_export/job", () => {
  let rootDir: string;
  let dataDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-sfen-export-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-sfen-export-db-"));
    initDatabase(dataDir);
    resetSfenExportJobsForTesting();
  });

  afterEach(() => {
    closeDatabase();
    resetSfenExportJobsForTesting();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("exports every matching file atomically and reports failures", async () => {
    writeKif("one.kif", ["1 ７六歩(77)", "2 ３四歩(33)"]);
    writeKif("two.kif", ["1 ２六歩(27)", "2 ８四歩(83)"]);
    fs.writeFileSync(path.join(rootDir, "broken.jkf"), "{");
    for (const filePath of ["one.kif", "two.kif", "broken.jkf"]) {
      upsertKifuFile(
        {
          file_path: filePath,
          mtime: Date.now(),
          size: 1,
          event: "Export Target",
        },
        [],
      );
    }

    const started = startSfenExportJob({
      kifuDir: rootDir,
      outputPath: "result.sfen",
      search: { keyword: "Export Target" },
      maxMoves: 1,
      standardInitialOnly: false,
      overwrite: false,
    });
    expect(started).toBeDefined();
    const completed = await waitForCompletion(started!.jobId);

    expect(completed).toMatchObject({
      state: "completed",
      totalFiles: 3,
      processedFiles: 3,
      exportedLines: 2,
      failedFiles: 1,
    });
    expect(fs.existsSync(path.join(rootDir, "result.sfen.tmp"))).toBe(false);
    expect(
      fs.readFileSync(path.join(rootDir, "result.sfen"), "utf8").trim().split("\n").sort(),
    ).toEqual(["position startpos moves 2g2f", "position startpos moves 7g7f"]);
  });

  it("allows only one running export", () => {
    writeKif("one.kif", ["1 ７六歩(77)"]);
    upsertKifuFile({ file_path: "one.kif", mtime: Date.now(), size: 1, event: "Target" }, []);
    const params = {
      kifuDir: rootDir,
      outputPath: "result.sfen",
      search: { keyword: "Target" },
      standardInitialOnly: false,
      overwrite: false,
    };

    expect(startSfenExportJob(params)).toBeDefined();
    expect(startSfenExportJob({ ...params, outputPath: "other.sfen" })).toBeUndefined();
  });

  it("skips non-standard records when requested", async () => {
    writeKif("standard.kif", ["1 ７六歩(77)"]);
    writeHandicapKif("handicap.kif", ["1 ６二銀(71)"]);
    upsertKifuFile({ file_path: "standard.kif", mtime: Date.now(), size: 1, event: "Target" }, []);
    upsertKifuFile({ file_path: "handicap.kif", mtime: Date.now(), size: 1, event: "Target" }, []);

    const started = startSfenExportJob({
      kifuDir: rootDir,
      outputPath: "result.sfen",
      search: { keyword: "Target" },
      standardInitialOnly: true,
      overwrite: false,
    });
    const completed = await waitForCompletion(started!.jobId);

    expect(completed).toMatchObject({
      state: "completed",
      totalFiles: 2,
      processedFiles: 2,
      exportedLines: 1,
      failedFiles: 0,
    });
    expect(fs.readFileSync(path.join(rootDir, "result.sfen"), "utf8").trim()).toBe(
      "position startpos moves 7g7f",
    );
  });

  it("does not replace a destination when overwrite is disabled", async () => {
    writeKif("one.kif", ["1 ７六歩(77)"]);
    upsertKifuFile({ file_path: "one.kif", mtime: Date.now(), size: 1, event: "Target" }, []);
    fs.writeFileSync(path.join(rootDir, "result.sfen"), "existing\n");

    const started = startSfenExportJob({
      kifuDir: rootDir,
      outputPath: "result.sfen",
      search: { keyword: "Target" },
      standardInitialOnly: false,
      overwrite: false,
    });
    const completed = await waitForCompletion(started!.jobId);

    expect(completed.state).toBe("failed");
    expect(fs.readFileSync(path.join(rootDir, "result.sfen"), "utf8")).toBe("existing\n");
  });

  function writeKif(filePath: string, moves: string[]) {
    const content = ["手合割：平手", "先手番", "手数----指手----消費時間--", ...moves].join("\n");
    fs.writeFileSync(path.join(rootDir, filePath), encodeText(content, "SJIS"));
  }

  function writeHandicapKif(filePath: string, moves: string[]) {
    const content = ["手合割：二枚落ち", "上手番", "手数----指手----消費時間--", ...moves].join(
      "\n",
    );
    fs.writeFileSync(path.join(rootDir, filePath), encodeText(content, "SJIS"));
  }
});

async function waitForCompletion(jobId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = getSfenExportJob(jobId);
    if (job && !["queued", "running"].includes(job.state)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("export job timed out");
}
