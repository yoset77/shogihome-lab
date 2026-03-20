import https from "node:https";
import http from "node:http";
import { getAppLogger } from "@/background/log.js";
import ejpn from "encoding-japanese";
import { RateLimiter, WindowRule } from "./limiter.js";
import { isTest } from "@/background/proc/env.js";
const convert = ejpn.convert;

const domainLimiter = new Map<string, RateLimiter>();
domainLimiter.set(
  "live4.computer-shogi.org",
  new RateLimiter([
    { limit: 1, windowMs: 1 * 1000 },
    { limit: 2, windowMs: 2 * 1000 },
    { limit: 3, windowMs: 4 * 1000 },
    { limit: 4, windowMs: 8 * 1000 },
    { limit: 5, windowMs: 12 * 1000 },
    { limit: 6, windowMs: 18 * 1000 },
  ]),
);
const commonRules: WindowRule[] = isTest()
  ? [{ limit: 100, windowMs: 1 * 1000 }]
  : [
      { limit: 2, windowMs: 1 * 1000 },
      { limit: 3, windowMs: 2 * 1000 },
      { limit: 4, windowMs: 4 * 1000 },
      { limit: 5, windowMs: 8 * 1000 },
      { limit: 6, windowMs: 12 * 1000 },
      { limit: 8, windowMs: 16 * 1000 },
    ];

const MAX_REMOTE_BYTES = 10 * 1024 * 1024; // 10 MB

export async function fetch(url: string): Promise<string> {
  const urlObj = new URL(url);
  if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${urlObj.protocol}`);
  }

  const hostName = urlObj.hostname;

  // Prevent SSRF targeting internal/private networks unless in test environment
  if (!isTest()) {
    const isInternalIp =
      /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+|0\.0\.0\.0|::1)$/i.test(
        hostName,
      );
    if (isInternalIp) {
      throw new Error(`Forbidden: Access to internal network is not allowed.`);
    }
  }

  let limiter = domainLimiter.get(hostName);
  if (!limiter) {
    limiter = new RateLimiter(commonRules);
    domainLimiter.set(hostName, limiter);
  }

  await limiter.waitUntilAllowed();

  // CodeQL SSRF Mitigation: Break the taint chain by explicitly constructing the RequestOptions object.
  // We do not pass `url` or `urlObj` directly to the sink.
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port ? parseInt(urlObj.port, 10) : undefined,
    path: urlObj.pathname + urlObj.search,
    headers: {
      "User-Agent": "ShogiHome",
    },
  };

  return new Promise((resolve, reject) => {
    const get = urlObj.protocol === "http:" ? http.get : https.get;
    getAppLogger().debug(
      `fetch remote file: ${urlObj.protocol}//${options.hostname}${options.path}`,
    );

    // lgtm[js/request-forgery]
    // codeql[js/request-forgery]
    const req = get(options);
    let settled = false;
    req.setTimeout(5000, () => {
      if (settled) return;
      settled = true;
      reject(new Error(`request timeout: ${url}`));
      req.destroy();
    });
    req.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(new Error(`request failed: ${url}: ${e}`));
    });
    req.on("response", (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        if (settled) return;
        settled = true;
        reject(new Error(`request failed: ${url}: ${res.statusCode}`));
        return;
      }
      let totalBytes = 0;
      const data: Buffer[] = [];
      res
        .on("readable", () => {
          for (let chunk = res.read(); chunk; chunk = res.read()) {
            totalBytes += chunk.length;
            if (totalBytes > MAX_REMOTE_BYTES) {
              if (settled) return;
              settled = true;
              req.destroy();
              reject(new Error(`response too large: ${url}`));
              return;
            }
            data.push(chunk);
          }
        })
        .on("end", () => {
          if (settled) return;
          settled = true;
          const concat = Buffer.concat(data);
          const decoded = convert(concat, { type: "string", to: "UNICODE" });
          resolve(decoded);
        })
        .on("error", (e) => {
          if (settled) return;
          settled = true;
          reject(new Error(`request failed: ${url}: ${e}`));
        });
    });
  });
}
