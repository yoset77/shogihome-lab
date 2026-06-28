import fs from "node:fs";
import path from "node:path";
import { loadYbbBook, openYbbBookOnTheFly, storeYbbBook } from "@/server/book/ybb";
import { getTempPathForTesting } from "@/tests/helpers/temp";

const ybbPath = path.resolve("src/tests/testdata/book/yaneuraou.ybb");
const tmpdir = path.join(getTempPathForTesting(), "ybb");
const YBB_MAGIC = "YANE-BINBOOK-V1\0";

describe("background/book/ybb", () => {
  beforeAll(() => {
    fs.mkdirSync(tmpdir, { recursive: true });
  });

  it("round-trips yaneuraou.ybb to identical binary", async () => {
    const ybbBook = await loadYbbBook(ybbPath);
    const tmpPath = path.join(tmpdir, "roundtrip.ybb");
    await storeYbbBook(ybbBook.entries, tmpPath);
    const expected = await fs.promises.readFile(ybbPath);
    const actual = await fs.promises.readFile(tmpPath);
    expect(Buffer.compare(actual, expected)).toBe(0);
  });

  it("rejects an impossible record count", async () => {
    const tmpPath = path.join(tmpdir, "invalid-record-count.ybb");
    const data = Buffer.alloc(32);
    data.write(YBB_MAGIC, 0, 16, "ascii");
    data.writeBigUInt64LE(1_000_000_000_000_000n, 16);
    await fs.promises.writeFile(tmpPath, data);

    await expect(loadYbbBook(tmpPath)).rejects.toThrow("recordCount too large");
    await expect(openYbbBookOnTheFly(tmpPath)).rejects.toThrow("recordCount too large");
  });

  it("rejects a move offset outside the file", async () => {
    const tmpPath = path.join(tmpdir, "invalid-moves-offset.ybb");
    const data = await fs.promises.readFile(ybbPath);
    data.writeBigUInt64LE(1_000_000_000n, 32 + 32);
    await fs.promises.writeFile(tmpPath, data);

    await expect(loadYbbBook(tmpPath)).rejects.toThrow("moves area exceeds file size");
  });
});
