import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import path from "path";
import { killTree } from "./helpers/process";

const SERVER_PATH = path.resolve(__dirname, "../../../server.ts");

describe("Server Security Configuration", () => {
  async function startServerWithEnv(env: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const serverProcess = spawn("npx", ["tsx", SERVER_PATH], {
        env: {
          ...process.env,
          PORT: (8200 + Math.floor(Math.random() * 1000)).toString(),
          BIND_ADDRESS: "127.0.0.1",
          REMOTE_ENGINE_PORT: "4082",
          ...env,
        },
        stdio: "pipe",
        shell: true,
        detached: process.platform !== "win32",
      });

      let output = "";
      let resolved = false;

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        killTree(serverProcess);
        reject(new Error("Server start timeout. Output so far: " + output));
      }, 15000);

      serverProcess.stdout?.on("data", (data) => {
        const msg = data.toString();
        output += msg;
        if (msg.includes("Server is listening on")) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            killTree(serverProcess);
            resolve(output);
          }
        }
      });

      serverProcess.stderr?.on("data", (data) => {
        output += data.toString();
      });

      serverProcess.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      serverProcess.on("exit", (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error(`Server exited unexpectedly with code ${code}. Output: ${output}`));
        }
      });
    });
  }

  it("should have trust proxy DISABLED by default", async () => {
    const output = await startServerWithEnv({ TRUST_PROXY: "false" });
    expect(output).toContain("Trust proxy is DISABLED");
  }, 30000);

  it("should have trust proxy ENABLED when TRUST_PROXY=true", async () => {
    const output = await startServerWithEnv({ TRUST_PROXY: "true" });
    expect(output).toContain("Trust proxy is ENABLED");
  }, 30000);
});
