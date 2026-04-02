import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import http from "http";
import fs from "fs";
import { killTree } from "./helpers/process";
import {
  RecordFileHistory,
  RecordFileHistoryEntry,
  UserFileEntry,
  BackupEntryV2,
  HistoryClass,
} from "@/common/file/history.js";

const SERVER_PORT = 8100 + Math.floor(Math.random() * 1000);
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const TEST_DATA_DIR = path.resolve(__dirname, "../../../test-data-history");

describe("API: /api/history (Backup & History)", () => {
  let serverProcess: ChildProcess;
  let serverReady = false;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

    const serverPath = path.resolve(__dirname, "../../../server.ts");
    serverProcess = spawn("npx", ["tsx", serverPath], {
      env: {
        ...process.env,
        PORT: SERVER_PORT.toString(),
        BIND_ADDRESS: "0.0.0.0",
        // We can't easily override getUserDataPath() via env,
        // but server.ts uses process.cwd() / data by default.
        // For testing, we'll just let it run and clean up if needed,
        // or rely on the fact that server.ts is running in its own process.
        WRAPPER_ACCESS_TOKEN: "",
      },
      stdio: "pipe",
      shell: true,
      detached: process.platform !== "win32",
    });

    await new Promise<void>((resolve, reject) => {
      serverProcess.stdout?.on("data", (data) => {
        if (data.toString().includes(`Server is listening on 0.0.0.0:${SERVER_PORT}`)) {
          serverReady = true;
          resolve();
        }
      });
      setTimeout(() => {
        if (!serverReady) reject(new Error("Server start timeout"));
      }, 30000);
    });
  }, 35000);

  afterAll(() => {
    if (serverProcess) {
      killTree(serverProcess);
    }
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  const request = <T>(
    method: string,
    path: string,
    body?: string,
    contentType = "application/json",
  ): Promise<{ status: number; data: T }> => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${SERVER_URL}${path}`,
        {
          method,
          headers: body
            ? { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) }
            : {},
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode || 500,
                data: (res.headers["content-type"]?.includes("json")
                  ? JSON.parse(data)
                  : data) as T,
              });
            } catch {
              resolve({ status: res.statusCode || 500, data: data as T });
            }
          });
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  };

  it("should initially return an empty history", async () => {
    const { status, data } = await request<RecordFileHistory>("GET", "/api/history");
    expect(status).toBe(200);
    expect(data.entries).toBeInstanceOf(Array);
  });

  it("should add a file to history via /api/history/add", async () => {
    const testPath = "server://test-kifu.kif";
    const { status } = await request<void>(
      "POST",
      "/api/history/add",
      JSON.stringify({ path: testPath }),
    );
    expect(status).toBe(200);

    const { data } = await request<RecordFileHistory>("GET", "/api/history");
    const entry = data.entries.find(
      (e: RecordFileHistoryEntry) =>
        e.class === HistoryClass.USER && (e as UserFileEntry).userFilePath === testPath,
    );
    expect(entry).toBeDefined();
    expect(entry?.class).toBe("user");
  });

  it("should save a backup via /api/history/backup", async () => {
    const kifData = "any kif data";
    const { status } = await request<void>("POST", "/api/history/backup", kifData, "text/plain");
    expect(status).toBe(200);

    const { data } = await request<RecordFileHistory>("GET", "/api/history");
    const entry = data.entries.find(
      (e: RecordFileHistoryEntry) =>
        e.class === HistoryClass.BACKUP_V2 && (e as BackupEntryV2).kif === kifData,
    );
    expect(entry).toBeDefined();
    expect(entry?.class).toBe("backupV2");
  });

  it("should clear history via /api/history/clear", async () => {
    const { status } = await request<void>("POST", "/api/history/clear");
    expect(status).toBe(200);

    const { data } = await request<RecordFileHistory>("GET", "/api/history");
    expect(data.entries).toHaveLength(0);
  });
});
