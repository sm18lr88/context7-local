const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const REFRESH_THRESHOLD_SECONDS = 24 * 60 * 60; // 1 day — only extend TTL when below this

/** Local protocol state only. Session IDs are never persisted or exported. */
export function createSessionStore() {
  const sessions = new Map<string, number>();
  const ttlMs = SESSION_TTL_SECONDS * 1_000;
  const refreshThresholdMs = REFRESH_THRESHOLD_SECONDS * 1_000;

  return {
    async create(sessionId: string) {
      sessions.set(sessionId, Date.now() + ttlMs);
    },

    async refresh(sessionId: string) {
      const expiresAt = sessions.get(sessionId);
      if (!expiresAt || expiresAt <= Date.now()) {
        sessions.delete(sessionId);
        return false;
      }
      if (expiresAt - Date.now() < refreshThresholdMs) sessions.set(sessionId, Date.now() + ttlMs);
      return true;
    },

    async delete(sessionId: string) {
      sessions.delete(sessionId);
    },
  };
}
