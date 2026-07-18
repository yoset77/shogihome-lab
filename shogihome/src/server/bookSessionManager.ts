import { closeBookSession, initBookSession } from "@/server/book";
import { HttpError } from "@/server/errors";
import AsyncLock from "async-lock";

const SESSION_ID_HEADER_REGEX = /^[a-zA-Z0-9_-]{8,128}$/;

class BookSessionManager {
  private sessions = new Map<string, number>();
  private lastAccess = new Map<string, number>();
  private lock = new AsyncLock();
  private nextSessionId = 1;
  private readonly MAX_SESSIONS = 50;

  get(sessionId: string): number {
    this.lastAccess.set(sessionId, Date.now());
    if (!this.sessions.has(sessionId)) {
      if (this.sessions.size >= this.MAX_SESSIONS) {
        throw new HttpError(503, `Book session limit reached (${this.MAX_SESSIONS})`);
      }
      const id = this.nextSessionId++;
      this.sessions.set(sessionId, id);
      initBookSession(id);
    }
    return this.sessions.get(sessionId)!;
  }

  close(sessionId: string): void {
    const id = this.sessions.get(sessionId);
    if (id !== undefined) {
      closeBookSession(id);
      this.sessions.delete(sessionId);
      this.lastAccess.delete(sessionId);
    }
  }

  runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.lock.acquire(sessionId, operation);
  }

  cleanup() {
    const now = Date.now();
    for (const [sessionId, lastTime] of this.lastAccess.entries()) {
      if (now - lastTime > 1000 * 60 * 60) {
        void this.runExclusive(sessionId, async () => {
          const currentLastAccess = this.lastAccess.get(sessionId);
          if (currentLastAccess === undefined || Date.now() - currentLastAccess <= 1000 * 60 * 60) {
            return;
          }
          this.close(sessionId);
        }).catch((e) => {
          console.error("failed to close book session", e);
        });
      }
    }
  }
}

export const bookSessionManager = new BookSessionManager();

const bookCleanupInterval = setInterval(() => bookSessionManager.cleanup(), 1000 * 60 * 10);
bookCleanupInterval.unref();

export function getBookSession(sessionId: string | undefined): number {
  return bookSessionManager.get(validateBookSessionId(sessionId));
}

export function closeBookSessionForHeader(sessionId: string | undefined): void {
  if (sessionId && SESSION_ID_HEADER_REGEX.test(sessionId)) {
    bookSessionManager.close(sessionId);
  }
}

export function runWithBookSessionLock<T>(
  sessionId: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return bookSessionManager.runExclusive(validateBookSessionId(sessionId), operation);
}

function validateBookSessionId(sessionId: string | undefined): string {
  if (!sessionId || !SESSION_ID_HEADER_REGEX.test(sessionId)) {
    throw new HttpError(400, "Invalid or missing X-Book-Session-Id header");
  }
  return sessionId;
}
