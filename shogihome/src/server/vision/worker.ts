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
  timer?: NodeJS.Timeout;
  child: ChildProcessWithoutNullStreams;
  request: ScanWorkerRequest;
  cleanExitRetries: number;
};

const STDOUT_BUFFER_LIMIT = 16 * 1024 * 1024;
const MAX_QUEUED_SCANS = 8;

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
  private scanTail: Promise<void> = Promise.resolve();
  private scheduledScans = 0;
  private stdoutBuffer = "";
  private stderrBuffer = "";

  scan(request: ScanWorkerRequest): Promise<VisionScanResponse> {
    if (this.scheduledScans >= MAX_QUEUED_SCANS) {
      return Promise.reject(new Error("vision worker queue is full"));
    }
    this.scheduledScans++;
    const result = this.scanTail.then(() => {
      this.scheduledScans--;
      return this.dispatch(request);
    });
    this.scanTail = result.then(
      () => this.waitForWorkerEvents(),
      () => this.waitForWorkerEvents(),
    );
    return result;
  }

  private waitForWorkerEvents(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  private dispatch(request: ScanWorkerRequest, cleanExitRetries = 1): Promise<VisionScanResponse> {
    const child = this.ensureStarted();
    const id = this.nextId++;
    const envelope: WorkerEnvelope = { ...request, id };
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, child, request, cleanExitRetries };
      const timer = setTimeout(() => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        this.stop(child);
        reject(new Error("vision worker timed out"));
      }, VISION_TIMEOUT_MS);
      pending.timer = timer;
      this.pending.set(id, pending);
      child.stdin.write(`${JSON.stringify(envelope)}\n`, (error) => {
        if (!error || this.pending.get(id) !== pending) return;
        if (this.retryPending(id, pending, true)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        this.stop(child);
        reject(error);
      });
    });
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (
      this.child &&
      !this.child.killed &&
      this.child.exitCode === null &&
      !this.child.stdin.destroyed
    ) {
      return this.child;
    }
    if (this.child) {
      this.stop(this.child);
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
    child.stdin.on("error", () => {
      // Write callbacks handle delivery failures; consume the stream event too.
    });
    child.stderr.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4096);
    });
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.rejectActive(error, child);
      this.stop(child);
    });
    child.on("close", (code) => {
      if (this.child !== child) return;
      const message = this.stderrBuffer.trim() || `vision worker exited with code ${code}`;
      this.child = undefined;
      if (code === 0 && this.retryAfterCleanExit(child)) {
        return;
      }
      this.rejectActive(new Error(message), child);
    });
    return child;
  }

  private handleStdout(chunk: string, child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > STDOUT_BUFFER_LIMIT) {
      this.failProtocol(new Error("vision worker stdout overflow"), child);
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
      this.failProtocol(new Error("vision worker returned invalid JSON"), child);
      return;
    }
    if (typeof data !== "object" || data === null || !("id" in data)) {
      this.failProtocol(new Error("vision worker returned an invalid envelope"), child);
      return;
    }
    const id = Number((data as { id: unknown }).id);
    const pending = this.pending.get(id);
    if (!pending || pending.child !== child) {
      this.failProtocol(new Error("vision worker returned an unknown response id"), child);
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
      this.stop(child);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectActive(error: Error, child: ChildProcessWithoutNullStreams): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.child !== child) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private retryAfterCleanExit(child: ChildProcessWithoutNullStreams): boolean {
    const active = [...this.pending.entries()].find(([, pending]) => pending.child === child);
    if (!active) return false;
    const [id, pending] = active;
    return this.retryPending(id, pending, false);
  }

  private retryPending(id: number, pending: PendingRequest, stopChild: boolean): boolean {
    if (pending.cleanExitRetries <= 0 || this.pending.get(id) !== pending) return false;

    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (stopChild) {
      this.stop(pending.child);
    }
    try {
      this.dispatch(pending.request, pending.cleanExitRetries - 1).then(
        pending.resolve,
        pending.reject,
      );
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  private failProtocol(error: Error, child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.rejectActive(error, child);
    this.stop(child);
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
