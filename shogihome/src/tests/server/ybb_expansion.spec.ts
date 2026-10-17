// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { Position } from "tsshogi";
import { bookRoutes } from "@/server/routes/book";
import { handleError } from "@/server/errors";
import { bookSessionManager } from "@/server/bookSessionManager";
import { isBookOnTheFly, isBookUnsaved } from "@/server/book";
import type { AppEnv } from "@/server/hono";
import { t } from "@/common/i18n";
import { getTempPathForTesting } from "@/tests/helpers/temp";
import { createDistinctYbbPositions, createYbbWithReferences } from "@/tests/helpers/ybb";
import { requestApp } from "./honoRequest";

const config = vi.hoisted(() => ({ directory: "", threshold: 64 }));
vi.mock("@/server/config", async (original) => ({
  ...(await original<typeof import("@/server/config")>()),
  get KIFU_DIR() {
    return config.directory;
  },
  get ONTHEFLY_THRESHOLD_MB() {
    return config.threshold;
  },
}));

const app = new Hono<AppEnv>().route("/api/book", bookRoutes);
app.onError(handleError);
const client = "ybb-expansion-client";
const headers = { "X-Book-Session-Id": client };
const sfen = new Position().sfen;

beforeAll(async () => {
  config.directory = path.join(getTempPathForTesting(), "ybb-expansion-api");
  await fs.mkdir(config.directory, { recursive: true });
  await fs.copyFile(
    "src/tests/testdata/book/yaneuraou.ybb",
    path.join(config.directory, "original.ybb"),
  );
  const records = createDistinctYbbPositions(1000).map((sfen) => ({ sfen, moveCount: 1000 }));
  await fs.writeFile(
    path.join(config.directory, "amplifying.ybb"),
    createYbbWithReferences(records, 1000),
  );
});

afterEach(() => {
  bookSessionManager.close(client);
  config.threshold = 64;
});

it.each(["in-memory", "on-the-fly"])(
  "returns 413 without losing the existing %s book or unsaved edits",
  async (mode) => {
    config.threshold = mode === "on-the-fly" ? 0 : 64;
    const opened = await requestApp(app, "POST", "/api/book/open?path=original.ybb", { headers });
    expect(opened.status).toBe(200);
    expect(opened.body.mode).toBe(mode);
    const updated = await requestApp(
      app,
      "POST",
      `/api/book/update?sfen=${encodeURIComponent(sfen)}`,
      {
        headers,
        json: { usi: "7g7f", score: 123, comment: "unsaved" },
      },
    );
    expect(updated.status).toBe(200);
    const search = () =>
      requestApp(app, "GET", `/api/book/search?sfen=${encodeURIComponent(sfen)}`, { headers });
    const before = await search();
    const session = bookSessionManager.get(client);
    expect(isBookUnsaved(session)).toBe(true);
    config.threshold = 64;

    const rejected = await requestApp(app, "POST", "/api/book/open?path=amplifying.ybb", {
      headers,
    });
    expect(rejected.status).toBe(413);
    expect(rejected.textBody).toBe(t.serverYbbExpansionLimit);
    expect(bookSessionManager.get(client)).toBe(session);
    expect(isBookUnsaved(session)).toBe(true);
    expect(isBookOnTheFly(session)).toBe(mode === "on-the-fly");
    const after = await search();
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
  },
);

it("does not retain a new session after rejecting an amplifying book", async () => {
  const response = await requestApp(app, "POST", "/api/book/open?path=amplifying.ybb", { headers });
  expect(response.status).toBe(413);
  expect(bookSessionManager.has(client)).toBe(false);
});
