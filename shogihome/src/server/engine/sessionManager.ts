export class SessionManager<TSession> {
  private sessions = new Map<string, TSession>();
  private readonly MAX_SESSIONS = 50;

  constructor(private readonly createSession: (sessionId: string) => TSession) {}

  getOrCreateSession(sessionId: string): TSession | null {
    let session = this.sessions.get(sessionId);
    if (!session) {
      if (this.sessions.size >= this.MAX_SESSIONS) {
        console.warn(
          `Session limit reached (${this.MAX_SESSIONS}), rejecting new session: ${sessionId.substring(0, 8)}...`,
        );
        return null;
      }
      console.log(`Creating new session: ${sessionId}`);
      session = this.createSession(sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
  }
}
