import { createHash, randomUUID } from "node:crypto";
import { decodeGameRequest, isGameTerminal, type GameSessionRequest } from "@/common/game/protocol";
import { LARGE_BODY_LIMIT } from "@/server/hono";
import { t } from "@/common/i18n";
import { HttpError } from "@/server/errors";
import { GameSession, GAME_HEARTBEAT_MS, type GameDependencies } from "./session";
import { validateGameSaveDirectory } from "./files";
import type { JobSummary } from "@/common/jobs/types";
import { ES_HUMAN } from "@/common/uri";

export class GameSessionManager {
  readonly serverInstanceId = randomUUID();
  private sessions = new Map<string, GameSession>();
  private requests = new Map<string, { hash: string; sessionId: string }>();
  constructor(private readonly dependencies: GameDependencies = {}) {}
  capabilities() {
    return {
      serverInstanceId: this.serverInstanceId,
      maxInputBytes: LARGE_BODY_LIMIT,
      heartbeatMs: GAME_HEARTBEAT_MS,
    };
  }
  create(input: GameSessionRequest): GameSession {
    const decoded = decodeGameRequest(input);
    if (!decoded.ok) throw new HttpError(400, t.gameInvalid);
    const request = decoded.value;
    if (request.serverInstanceId !== this.serverInstanceId)
      throw new HttpError(410, t.gameSessionExpired);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = this.requests.get(request.requestId);
    if (existing) {
      if (hash !== existing.hash) throw new HttpError(409, t.gameConflict);
      return this.get(existing.sessionId);
    }
    this.cleanup();
    if (
      this.requests.size >= 10_000 ||
      [...this.sessions.values()].some((session) => !isGameTerminal(session.snapshot().state))
    )
      throw new HttpError(503, t.gameCapacity);
    if (request.settings.enableAutoSave && !this.dependencies.saveRecord)
      validateGameSaveDirectory(request.options.save);
    const session = new GameSession(randomUUID(), structuredClone(request), this.dependencies);
    this.sessions.set(session.id, session);
    this.requests.set(request.requestId, { hash, sessionId: session.id });
    session.start();
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
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
  }
}
export const gameSessionManager = new GameSessionManager();
const cleanupTimer = setInterval(() => gameSessionManager.cleanup(), 60_000);
cleanupTimer.unref();
