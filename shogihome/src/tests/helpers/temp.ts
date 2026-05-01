import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempPathForTesting: string;

export function getTempPathForTesting(): string {
  if (!tempPathForTesting) {
    tempPathForTesting = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-"));
  }
  return tempPathForTesting;
}
