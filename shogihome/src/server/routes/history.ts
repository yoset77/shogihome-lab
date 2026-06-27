import type { Hono } from "hono";
import { addHistory, clearHistory, getHistory, saveBackup } from "@/server/file/history";
import { sendError } from "@/server/errors";
import {
  createBodyLimit,
  DEFAULT_JSON_BODY_LIMIT,
  LARGE_BODY_LIMIT,
  type AppEnv,
} from "@/server/hono";

export const registerHistoryRoutes = (app: Hono<AppEnv>) => {
  app.get("/api/history", async (c) => {
    const history = await getHistory();
    return c.json(history);
  });

  app.post("/api/history/add", createBodyLimit(DEFAULT_JSON_BODY_LIMIT), async (c) => {
    const body = await c.req.json<{ path?: unknown }>();
    const { path } = body;
    if (typeof path !== "string" || !path) {
      return sendError(c, 400, "path is required");
    }
    addHistory(path);
    return c.text("ok");
  });

  app.post("/api/history/backup", createBodyLimit(LARGE_BODY_LIMIT), async (c) => {
    const kif = await c.req.text();
    if (typeof kif !== "string" || !kif) {
      return sendError(c, 400, "kif text body is required");
    }
    await saveBackup(kif);
    return c.text("ok");
  });

  app.post("/api/history/clear", async (c) => {
    await clearHistory();
    return c.text("ok");
  });
};
