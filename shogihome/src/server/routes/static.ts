import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import path from "path";
import { shogiHomePath } from "@/server/config";
import { sendError } from "@/server/errors";
import type { AppEnv } from "@/server/hono";

export const registerStaticRoutes = (app: Hono<AppEnv>) => {
  app.all("/api", (c) => {
    return sendError(c, 404, "API endpoint not found");
  });

  app.all("/api/*", (c) => {
    return sendError(c, 404, "API endpoint not found");
  });

  app.use("*", serveStatic({ root: shogiHomePath }));

  app.get("*", serveStatic({ path: path.join(shogiHomePath, "index.html") }));
};
