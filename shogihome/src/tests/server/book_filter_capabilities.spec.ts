// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "@/server/hono";
import { handleError } from "@/server/errors";
import { bookRoutes } from "@/server/routes/book";
import { getTempPathForTesting } from "@/tests/helpers/temp";
import { createYbbWithReferences } from "@/tests/helpers/ybb";
import { requestApp } from "./honoRequest";

const config = vi.hoisted(() => ({ directory: "" }));
vi.mock("@/server/config", async (original) => ({
  ...(await original<typeof import("@/server/config")>()),
  get KIFU_DIR() {
    return config.directory;
  },
}));
const app = new Hono<AppEnv>().route("/api/book", bookRoutes).onError(handleError);
const request = (file: string) =>
  requestApp(app, "GET", `/api/book/filter-capabilities?${new URLSearchParams({ path: file })}`);

beforeAll(async () => {
  config.directory = getTempPathForTesting();
  for (const file of ["yaneuraou.db", "apery.bin", "shogihome01.sbk"]) {
    await fs.copyFile(`src/tests/testdata/book/${file}`, path.join(config.directory, file));
  }
  for (const hasDepth of [false, true]) {
    await fs.writeFile(
      path.join(config.directory, `${hasDepth}.ybb`),
      createYbbWithReferences([{ moveCount: 1 }], 1, hasDepth),
    );
  }
});

it.each([
  { file: "yaneuraou.db", score: true, depth: true },
  { file: "apery.bin", score: true, depth: false },
  { file: "shogihome01.sbk", score: false, depth: false },
  { file: "false.ybb", score: true, depth: false },
  { file: "true.ybb", score: true, depth: true },
])(
  "reports which limits are supported by $file without a session ID",
  async ({ file, score, depth }) => {
    const response = await request(file);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ score, depth });
  },
);

it.each([
  { file: "", status: 400 },
  { file: "missing.ybb", status: 404 },
  { file: "record.kifu", status: 403 },
])("rejects unsupported or missing files ($file)", async ({ file, status }) => {
  expect((await request(file)).status).toBe(status);
});
