import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as sea from "node:sea";
import type { VisionScanResponse, VisionTurn } from "@/common/vision/types";
import { getBasePath, VISION_TIMEOUT_MS } from "@/server/config";
import { parseVisionScanResponse } from "@/server/vision/schema";

type ScanWorkerRequest = {
  type: "scan";
  imagePath: string;
  sideToMove: VisionTurn;
  maxCandidates: number;
};

type WorkerEnvelope = ScanWorkerRequest & {
  id: number;
};

type PendingRequest = {
  resolve: (value: VisionScanResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  child: ChildProcessWithoutNullStreams;
};

const STDOUT_BUFFER_LIMIT = 16 * 1024 * 1024;

export type WorkerProcessConfig = {
  command: string;
  args: string[];
  cwd?: string;
};

export type ResolveWorkerConfig = () => WorkerProcessConfig;

export class VisionWorkerClient {
  resolveConfig: ResolveWorkerConfig = resolveWorkerProcessConfig;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private stderrBuffer = "";

  async scan(request: ScanWorkerRequest): Promise<VisionScanResponse> {
    const child = this.ensureStarted();
    const id = this.nextId++;
    const envelope: WorkerEnvelope = { ...request, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stop(child);
        this.rejectAll(new Error("vision worker stopped"), child);
        reject(new Error("vision worker timed out"));
      }, VISION_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, child });
      child.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
      return this.child;
    }
    const config = this.resolveConfig();
    const child = spawn(config.command, config.args, {
      cwd: config.cwd,
      stdio: "pipe",
      windowsHide: true,
    });
    this.child = child;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk, child));
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4096);
    });
    child.on("error", (error) => this.rejectAll(error, child));
    child.on("close", (code) => {
      if (this.child !== child) return;
      const message = this.stderrBuffer.trim() || `vision worker exited with code ${code}`;
      this.child = undefined;
      this.rejectAll(new Error(message), child);
    });
    return child;
  }

  private handleStdout(chunk: string, child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > STDOUT_BUFFER_LIMIT) {
      this.rejectAll(new Error("vision worker stdout overflow"), child);
      this.stop(child);
      return;
    }

    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line, child);
      }
    }
  }

  private handleLine(line: string, child: ChildProcessWithoutNullStreams): void {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      this.rejectAll(new Error("vision worker returned invalid JSON"), child);
      this.stop(child);
      return;
    }
    if (typeof data !== "object" || data === null || !("id" in data)) {
      this.rejectAll(new Error("vision worker returned an invalid envelope"), child);
      this.stop(child);
      return;
    }
    const id = Number((data as { id: unknown }).id);
    const pending = this.pending.get(id);
    if (!pending) {
      this.rejectAll(new Error("vision worker returned an unknown response id"), child);
      this.stop(child);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);

    if ((data as { ok?: unknown }).ok !== true) {
      const error = (data as { error?: unknown }).error;
      pending.reject(new Error(typeof error === "string" ? error : "vision worker failed"));
      return;
    }
    try {
      pending.resolve(parseVisionScanResponse((data as { result?: unknown }).result));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectAll(error: Error, child?: ChildProcessWithoutNullStreams): void {
    for (const [id, pending] of this.pending.entries()) {
      if (child && pending.child !== child) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private stop(child = this.child): void {
    if (child && !child.killed) {
      child.kill("SIGKILL");
    }
    if (this.child === child) {
      this.child = undefined;
    }
  }
}

const isSeaRuntime = (): boolean => sea.isSea();

const getRuntimeBase = (): string =>
  isSeaRuntime() ? path.dirname(process.execPath) : getBasePath();

const resolveNodeBinary = (runtimeDir: string): string => {
  // When running as a Single Executable Application, process.execPath is the
  // bundled server binary itself and cannot execute arbitrary scripts. In that
  // case a plain Node binary is shipped next to the executable.
  if (isSeaRuntime()) {
    const binaryName = process.platform === "win32" ? "node.exe" : "node";
    const bundledNode = path.join(runtimeDir, binaryName);
    if (fs.existsSync(bundledNode)) {
      return bundledNode;
    }
    throw new Error(
      "bundled Node runtime not found; ensure node/node.exe is shipped next to the SEA executable",
    );
  }
  return process.execPath;
};

const resolveWorkerScriptPath = (runtimeDir: string): string | undefined => {
  const candidates = isSeaRuntime()
    ? [path.join(runtimeDir, "node-worker", "worker.js")]
    : [
        path.join(runtimeDir, "dist", "server", "node-worker", "worker.js"),
        path.join(runtimeDir, "src", "server", "vision", "node-worker", "worker.ts"),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate));
};

const resolveModelDir = (workerPath: string): string =>
  path.resolve(path.dirname(workerPath), "..", "models");

export const resolveWorkerProcessConfig = (): WorkerProcessConfig => {
  const runtimeDir = getRuntimeBase();
  const workerPath = resolveWorkerScriptPath(runtimeDir);
  if (!workerPath) {
    throw new Error(
      "vision worker not found; run `npm run server:build` or ensure dist/server/node-worker/worker.js is deployed",
    );
  }

  const nodeBinary = resolveNodeBinary(runtimeDir);
  const modelDir = resolveModelDir(workerPath);
  const args = ["--model-dir", modelDir];

  // Source TypeScript worker: launch via tsx so devs do not need to rebuild the
  // worker bundle for every change.
  if (workerPath.endsWith(".ts")) {
    return {
      command: nodeBinary,
      args: ["--import", "tsx", workerPath, ...args],
      cwd: runtimeDir,
    };
  }

  return {
    command: nodeBinary,
    args: [workerPath, ...args],
  };
};

export const visionWorkerClient = new VisionWorkerClient();
