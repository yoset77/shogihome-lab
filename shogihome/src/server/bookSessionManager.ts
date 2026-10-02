import { closeBookSession, initBookSession } from "@/server/book";
import { HttpError } from "@/server/errors";
import AsyncLock from "async-lock";
import { t } from "@/common/i18n";
import { BOOK_SESSION_IDLE_TIMEOUT_MINUTES } from "@/server/config";

const SESSION_ID_HEADER_REGEX = /^[a-zA-Z0-9_-]{8,128}$/;
const BOOK_LOCK_MAX_PENDING = 32;
const BOOK_LOCK_TIMEOUT_MS = 30_000;
const BOOK_SESSION_TIMEOUT_MS = BOOK_SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000;

class BookSessionManager {
  private sessions = new Map<string, number>();
  private lastAccess = new Map<string, number>();
  private lock = new AsyncLock({
    maxPending: BOOK_LOCK_MAX_PENDING,
    timeout: BOOK_LOCK_TIMEOUT_MS,
  });
  private nextSessionId = 1;
  private readonly MAX_SESSIONS = 50;

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string, allowReopen = false): number {
    if (!this.sessions.has(sessionId)) {
      if (!allowReopen) {
        throw new HttpError(410, t.serverBookSessionExpired);
      }
      if (this.sessions.size >= this.MAX_SESSIONS) {
        throw new HttpError(503, `Book session limit reached (${this.MAX_SESSIONS})`);
      }
      const id = this.nextSessionId++;
      initBookSession(id);
      this.sessions.set(sessionId, id);
    }
    this.lastAccess.set(sessionId, Date.now());
    return this.sessions.get(sessionId)!;
  }

  close(sessionId: string): void {
    const id = this.sessions.get(sessionId);
    if (id !== undefined) {
      closeBookSession(id);
      this.sessions.delete(sessionId);
    }
    this.lastAccess.delete(sessionId);
  }

  async runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    let operationStarted = false;
    try {
      return await this.lock.acquire(sessionId, async () => {
        operationStarted = true;
        try {
          return await operation();
        } finally {
          if (this.sessions.has(sessionId)) this.lastAccess.set(sessionId, Date.now());
        }
      });
    } catch (error) {
      if (!operationStarted) {
        throw new HttpError(503, "Book session is busy");
      }
      throw error;
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [sessionId, lastTime] of this.lastAccess.entries()) {
      if (now - lastTime > BOOK_SESSION_TIMEOUT_MS) {
        void this.runExclusive(sessionId, async () => {
          const currentLastAccess = this.lastAccess.get(sessionId);
          if (
            currentLastAccess === undefined ||
            Date.now() - currentLastAccess <= BOOK_SESSION_TIMEOUT_MS
          ) {
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

export function getBookSession(sessionId: string | undefined, allowReopen = false): number {
  return bookSessionManager.get(validateBookSessionId(sessionId), allowReopen);
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
