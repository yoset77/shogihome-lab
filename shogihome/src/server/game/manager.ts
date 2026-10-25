import { createHash, randomUUID } from "node:crypto";
import { decodeGameRequest, isGameTerminal, type GameSessionRequest } from "@/common/game/protocol";
import { LARGE_BODY_LIMIT } from "@/server/hono";
import { t } from "@/common/i18n";
import { HttpError } from "@/server/errors";
import {
  engineRequirements,
  maxRequirements,
  resourceRegistry,
  type ResourceLease,
} from "@/server/engine/resources";
import {
  GameSession,
  GAME_HEARTBEAT_MS,
  resolveGameEngineConfigs,
  type GameDependencies,
  type GameStartup,
} from "./session";
import { validateGameSaveDirectory } from "./files";
import type { JobSummary } from "@/common/jobs/types";
import { ES_HUMAN } from "@/common/uri";
import type { EngineConfig } from "@/server/engine/types";

/**
 * Reserve the shared budget for a game before either engine starts. AI
 * engines search alternately (no ponder), so the reservation is the
 * per-group maximum of both engines per worker, summed across workers
 * and held for the whole session. The caller supplies the same frozen
 * configurations used to launch players.
 */
export async function acquireGameResourceLease(
  configs: readonly EngineConfig[],
  parallelism = 1,
): Promise<ResourceLease | undefined> {
  return resourceRegistry.acquire(
    ...maxRequirements(...configs.map(engineRequirements)).map((requirement) => ({
      ...requirement,
      cost: requirement.cost * parallelism,
    })),
  );
}

export class GameSessionManager {
  readonly serverInstanceId = randomUUID();
  private sessions = new Map<string, GameSession>();
  private requests = new Map<string, { hash: string; sessionId: string }>();
  private pending?: { requestId: string; hash: string; result: Promise<GameSession> };
  private closed = false;
  constructor(private readonly dependencies: GameDependencies = {}) {}
  capabilities() {
    return {
      serverInstanceId: this.serverInstanceId,
      maxInputBytes: LARGE_BODY_LIMIT,
      heartbeatMs: GAME_HEARTBEAT_MS,
    };
  }
  async create(input: GameSessionRequest): Promise<GameSession> {
    const decoded = decodeGameRequest(input);
    if (!decoded.ok) throw new HttpError(400, t.gameInvalid);
    const request = structuredClone(decoded.value);
    if (request.serverInstanceId !== this.serverInstanceId)
      throw new HttpError(410, t.gameSessionExpired);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = this.requests.get(request.requestId);
    if (existing) {
      if (hash !== existing.hash) throw new HttpError(409, t.gameConflict);
      return this.get(existing.sessionId);
    }
    if (this.pending) {
      if (request.requestId !== this.pending.requestId) throw new HttpError(503, t.gameCapacity);
      if (hash !== this.pending.hash) throw new HttpError(409, t.gameConflict);
      return this.pending.result;
    }
    this.cleanup();
    this.ensureCapacity();
    if (request.settings.enableAutoSave && !this.dependencies.saveRecord)
      validateGameSaveDirectory(request.settings.autoSaveDirectory);
    if ((request.settings.parallelism ?? 1) <= 1) return this.register(request, hash);
    // In-flight creation owns the session slot, including retries of the same request.
    const result = this.createParallel(request, hash);
    this.pending = { requestId: request.requestId, hash, result };
    try {
      return await result;
    } finally {
      this.pending = undefined;
    }
  }
  private ensureCapacity(): void {
    if (
      this.closed ||
      this.requests.size >= 10_000 ||
      [...this.sessions.values()].some((session) => !isGameTerminal(session.snapshot().state))
    )
      throw new HttpError(503, t.gameCapacity);
  }
  private async createParallel(request: GameSessionRequest, hash: string): Promise<GameSession> {
    const configs = await resolveGameEngineConfigs(request, this.dependencies);
    this.ensureCapacity();
    const resourceLease = await this.dependencies.acquireResourceLease?.(
      [...configs.values()],
      Math.min(request.settings.parallelism!, request.settings.repeat),
    );
    try {
      this.ensureCapacity();
      return this.register(request, hash, { configs, resourceLease });
    } catch (error) {
      resourceLease?.release();
      throw error;
    }
  }
  private register(request: GameSessionRequest, hash: string, startup?: GameStartup): GameSession {
    const session = new GameSession(randomUUID(), request, this.dependencies, startup);
    try {
      session.start();
    } catch (error) {
      session.dispose();
      throw error;
    }
    this.sessions.set(session.id, session);
    this.requests.set(request.requestId, { hash, sessionId: session.id });
    return session;
  }
  get(id: string): GameSession {
    this.cleanup();
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(410, t.gameSessionExpired);
    return session;
  }
  list(): JobSummary[] {
    this.cleanup();
    return [...this.sessions.values()]
      .reverse()
      .filter(
        (session) =>
          session.request.settings.black.uri !== ES_HUMAN &&
          session.request.settings.white.uri !== ES_HUMAN,
      )
      .map((session) => session.summary());
  }
  byRequest(id: string): GameSession {
    const request = this.requests.get(id);
    if (!request) throw new HttpError(410, t.gameSessionExpired);
    return this.get(request.sessionId);
  }
  cleanup(): void {
    const sessions = [...this.sessions.values()]
      .filter((session) => session.endedAt !== undefined)
      .sort((a, b) => a.endedAt! - b.endedAt!);
    for (const [index, session] of sessions.entries()) {
      if (Date.now() - session.endedAt! >= 24 * 60 * 60 * 1000 || index < sessions.length - 10) {
        session.dispose();
        this.sessions.delete(session.id);
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.pending?.result.catch(() => {});
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
  }
}
export const gameSessionManager = new GameSessionManager({
  acquireResourceLease: acquireGameResourceLease,
});
const cleanupTimer = setInterval(() => gameSessionManager.cleanup(), 60_000);
cleanupTimer.unref();
