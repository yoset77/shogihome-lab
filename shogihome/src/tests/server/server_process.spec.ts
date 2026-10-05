// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./helpers/server_process_child.ts", import.meta.url));

it.each([
  { argument: "", code: 0, output: "LATER_LISTENER_RAN" },
  { argument: "--import-only", code: 0, output: "SIGNAL_LISTENERS:0" },
  { argument: "--start-server", code: 0, output: "SIGNAL_LISTENERS:0" },
])(
  "runs server process boundaries ($argument)",
  async (scenario) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shogihome-server-process-"));
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fixture, ...(scenario.argument ? [scenario.argument] : [])],
      {
        cwd: path.resolve(process.cwd()),
        env: {
          ...process.env,
          SHOGIHOME_BASE_PATH: directory,
          PORT: String(port),
          BIND_ADDRESS: "127.0.0.1",
          KIFU_DIR: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.on("data", (data) => {
      output += data.toString();
    });
    try {
      const result = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(output));
        }, 10_000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      expect(result, output).toBe(scenario.code);
      expect(output).toContain(scenario.output);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);
