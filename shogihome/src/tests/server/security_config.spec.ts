import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import path from "path";

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
      });

      let output = "";
      serverProcess.stdout?.on("data", (data) => {
        const msg = data.toString();
        output += msg;
        if (msg.includes("Server is listening on")) {
          serverProcess.kill();
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", serverProcess.pid!.toString(), "/f", "/t"]);
          }
          resolve(output);
        }
      });

      serverProcess.stderr?.on("data", (data) => {
        output += data.toString();
      });

      setTimeout(() => {
        serverProcess.kill();
        reject(new Error("Server start timeout. Output so far: " + output));
      }, 15000);
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
