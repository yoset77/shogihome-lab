import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import http from "http";
import { killTree } from "./helpers/process";

const SERVER_PORT = 8092 + Math.floor(Math.random() * 1000); // Avoid conflict
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

describe("API: /api/fetch-remote", () => {
  let serverProcess: ChildProcess;
  let serverReady = false;

  beforeAll(async () => {
    // Start server.ts in a child process with specific ALLOWED_FETCH_DOMAINS
    const serverPath = path.resolve(__dirname, "../../../server.ts");
    serverProcess = spawn("npx", ["tsx", serverPath], {
      env: {
        ...process.env,
        PORT: SERVER_PORT.toString(),
        BIND_ADDRESS: "0.0.0.0",
        ALLOWED_FETCH_DOMAINS: "example.com",
        WRAPPER_ACCESS_TOKEN: "", // Disable auth for tests
      },
      stdio: "pipe",
      shell: true,
      detached: process.platform !== "win32",
    });

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      serverProcess.stdout?.on("data", (data) => {
        const msg = data.toString();
        if (msg.includes(`Server is listening on 0.0.0.0:${SERVER_PORT}`)) {
          serverReady = true;
          resolve();
        }
      });

      serverProcess.stderr?.on("data", (data) => {
        console.error("[Server Error]:", data.toString());
      });

      setTimeout(() => {
        if (!serverReady) reject(new Error("Server start timeout"));
      }, 30000);
    });
  }, 30000);

  afterAll(() => {
    if (serverProcess) {
      killTree(serverProcess);
    }
  });

  const fetchApi = (urlPath: string): Promise<{ status: number; data: string }> => {
    return new Promise((resolve, reject) => {
      http
        .get(`${SERVER_URL}${urlPath}`, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode || 500, data });
          });
        })
        .on("error", (err) => {
          reject(err);
        });
    });
  };

  it("should return 400 if url parameter is missing", async () => {
    const { status, data } = await fetchApi("/api/fetch-remote");
    expect(status).toBe(400);
    expect(data).toContain("url is required");
  });

  it("should return 400 for unsupported protocols", async () => {
    const { status } = await fetchApi("/api/fetch-remote?url=file:///etc/passwd");
    expect(status).toBe(400);
  });

  it("should return 403 if the domain is not allowed", async () => {
    const { status, data } = await fetchApi("/api/fetch-remote?url=http://malicious.com/kifu.csa");
    expect(status).toBe(403);
    expect(data).toContain("Forbidden");
  });

  it("should return 403 for disallowed localhost", async () => {
    const { status } = await fetchApi("/api/fetch-remote?url=http://localhost:8140/api/history");
    expect(status).toBe(403);
  });

  it("should attempt to fetch and return 500 or 200 for allowed domains", async () => {
    // example.com is allowed, but fetching might fail or succeed depending on network and content
    // The main point is that it doesn't return 403.
    const { status } = await fetchApi("/api/fetch-remote?url=http://example.com/");
    // example.com usually returns HTML, which might fail or pass encoding-japanese depending on the content
    // However, it should definitely not be 403.
    expect(status).not.toBe(403);
  });
});
