import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { requestApp } from "./honoRequest";

const { SERVER_PORT, tempBaseDir } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const port = 8400 + Math.floor(Math.random() * 100);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shogihome-test-static-api-"));
  process.env.PORT = port.toString();
  process.env.SHOGIHOME_BASE_PATH = dir;
  return { SERVER_PORT: port, tempBaseDir: dir };
});

// Prepare a minimal runtime asset tree so that the static route can find index.html
// without depending on a previous production build.
fs.mkdirSync(path.join(tempBaseDir, "docs", "webapp"), { recursive: true });
fs.writeFileSync(
  path.join(tempBaseDir, "docs", "webapp", "index.html"),
  "<!doctype html><html><head></head><body></body></html>",
);

import { app } from "@/server/main";

const host = `localhost:${SERVER_PORT}`;

describe("Static routes", () => {
  afterAll(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  });

  it("serves index.html for SPA routes", async () => {
    const response = await requestApp(app, "GET", "/some-vue-route", { host });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.textBody).toContain("<!doctype html>");
  });

  it("does not fall back to index.html for unknown API routes", async () => {
    const response = await requestApp(app, "GET", "/api/unknown", { host });

    expect(response.status).toBe(404);
    expect(response.textBody).toContain("API endpoint not found");
  });
});
