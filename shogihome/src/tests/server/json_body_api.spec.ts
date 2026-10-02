import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requestApp } from "./honoRequest";

vi.hoisted(() => {
  process.env.PORT = "8140";
  process.env.KIFU_DIR = "./data";
});

vi.mock("@/server/book/index.js");
vi.mock("@/server/file/history.js");
vi.mock("@/server/database/sqlite.js");
vi.mock("@/server/kifu_export/job.js");
vi.mock("@/server/file/atomic_stream.js");

import { app } from "@/server/main";
import { bookSessionManager } from "@/server/bookSessionManager";
import { importBookMoves, searchBookMoves, updateBookMove } from "@/server/book";
import { addHistory } from "@/server/file/history";
import {
  cleanupAnalysisResults,
  deleteAnalysisResult,
  deleteAnalysisResultsByEngine,
  exportAnalysisResultsByEngine,
} from "@/server/database/sqlite";
import { startSfenExportJob } from "@/server/kifu_export/job";
import { writeStreamAtomic } from "@/server/file/atomic_stream";
import { DEFAULT_JSON_BODY_LIMIT, LARGE_BODY_LIMIT } from "@/server/hono";

const sessionId = "json-body-client";
const operations = [
  importBookMoves,
  searchBookMoves,
  updateBookMove,
  addHistory,
  cleanupAnalysisResults,
  deleteAnalysisResult,
  deleteAnalysisResultsByEngine,
  exportAnalysisResultsByEngine,
  startSfenExportJob,
  writeStreamAtomic,
];
const routes = [
  { path: "/api/book/search/batch", limit: LARGE_BODY_LIMIT },
  { path: "/api/book/import", limit: DEFAULT_JSON_BODY_LIMIT },
  { path: "/api/book/update?sfen=startpos", limit: DEFAULT_JSON_BODY_LIMIT },
  { path: "/api/analysis/delete_by_engine", limit: DEFAULT_JSON_BODY_LIMIT },
  { path: "/api/analysis/cleanup", limit: DEFAULT_JSON_BODY_LIMIT },
  { path: "/api/analysis/export", limit: DEFAULT_JSON_BODY_LIMIT },
  { path: "/api/analysis/delete", limit: DEFAULT_JSON_BODY_LIMIT },
  { path: "/api/kifu/export/sfen", limit: DEFAULT_JSON_BODY_LIMIT },
  { path: "/api/kifu/directories", limit: DEFAULT_JSON_BODY_LIMIT },
  { path: "/api/history/add", limit: DEFAULT_JSON_BODY_LIMIT },
];

describe("JSON request body errors", () => {
  beforeAll(() => {
    bookSessionManager.get(sessionId, true);
  });

  afterAll(() => {
    bookSessionManager.close(sessionId);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(routes)("$path", ({ path, limit }) => {
    it.each(["{", '{"path":}', "", "null", "[]", "123", "true", '"text"'])(
      "rejects invalid JSON object body %j without performing the operation",
      async (body) => {
        const response = await requestApp(app, "POST", path, {
          headers: {
            "Content-Type": "application/json",
            "X-Book-Session-Id": sessionId,
          },
          body,
        });

        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(response.textBody).not.toBe("");
        expect(console.error).not.toHaveBeenCalled();
        for (const operation of operations) {
          expect(operation).not.toHaveBeenCalled();
        }
      },
    );

    it("keeps oversized JSON bodies as 413 errors", async () => {
      const response = await requestApp(app, "POST", path, {
        headers: {
          "Content-Type": "application/json",
          "X-Book-Session-Id": sessionId,
        },
        body: " ".repeat(limit + 1),
      });

      expect(response.status).toBe(413);
      expect(console.error).not.toHaveBeenCalled();
      for (const operation of operations) {
        expect(operation).not.toHaveBeenCalled();
      }
    });
  });
});
