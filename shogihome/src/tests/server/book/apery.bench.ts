import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { loadAperyBook } from "@/server/book/apery";
import { createTestAperyBookFile } from "@/tests/mock/book";
import { getTempPathForTesting } from "@/tests/helpers/temp";

const tmpdir = path.join(getTempPathForTesting(), "book/apery");

test("server/book/apery", async ({ bench }) => {
  const book10mPath = path.join(tmpdir, "book10m.bin");
  await fs.promises.mkdir(tmpdir, { recursive: true });
  await createTestAperyBookFile(book10mPath, 10_000_000);

  await bench("loadAperyBook", async () => {
    const file = fs.createReadStream(book10mPath);
    try {
      const book = await loadAperyBook(file);
      expect(book.entries.get(BigInt(0))).not.toBeUndefined();
    } finally {
      file.close();
    }
  }).run();
});
