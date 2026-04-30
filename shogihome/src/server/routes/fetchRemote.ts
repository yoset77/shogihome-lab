import type { Express } from "express";
import { fetch as fetchRemote } from "@/server/helpers/http";
import { sendError } from "@/server/errors";
import { ALLOWED_FETCH_DOMAINS } from "@/server/config";

export const registerFetchRemoteRoute = (app: Express) => {
  app.get("/api/fetch-remote", async (req, res) => {
    const targetUrl = req.query.url;
    if (typeof targetUrl !== "string") {
      sendError(res, 400, "url is required");
      return;
    }

    let urlObj: URL;
    try {
      urlObj = new URL(targetUrl);
    } catch {
      sendError(res, 400, "Invalid URL");
      return;
    }
    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      sendError(res, 400, `Unsupported protocol: ${urlObj.protocol}`);
      return;
    }
    if (!ALLOWED_FETCH_DOMAINS.has(urlObj.hostname.toLowerCase())) {
      console.warn(`Blocked remote fetch for unauthorized domain: ${urlObj.hostname}`);
      sendError(
        res,
        403,
        `Forbidden: domain ${urlObj.hostname} is not allowed by ALLOWED_FETCH_DOMAINS.`,
      );
      return;
    }

    const text = await fetchRemote(urlObj.href);
    res.type("text/plain").send(text);
  });
};
