import type { Hono } from "hono";
import { fetch as fetchRemote } from "@/server/helpers/http";
import { sendError } from "@/server/errors";
import { ALLOWED_FETCH_DOMAINS } from "@/server/config";
import type { AppEnv } from "@/server/hono";

export const registerFetchRemoteRoute = (app: Hono<AppEnv>) => {
  app.get("/api/fetch-remote", async (c) => {
    const targetUrl = c.req.query("url");
    if (typeof targetUrl !== "string") {
      return sendError(c, 400, "url is required");
    }

    let urlObj: URL;
    try {
      urlObj = new URL(targetUrl);
    } catch {
      return sendError(c, 400, "Invalid URL");
    }
    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      return sendError(c, 400, `Unsupported protocol: ${urlObj.protocol}`);
    }
    if (!ALLOWED_FETCH_DOMAINS.has(urlObj.hostname.toLowerCase())) {
      console.warn(`Blocked remote fetch for unauthorized domain: ${urlObj.hostname}`);
      return sendError(
        c,
        403,
        `Forbidden: domain ${urlObj.hostname} is not allowed by ALLOWED_FETCH_DOMAINS.`,
      );
    }

    const text = await fetchRemote(urlObj.href);
    return c.text(text);
  });
};
