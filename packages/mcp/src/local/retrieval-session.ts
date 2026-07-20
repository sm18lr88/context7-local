interface SessionEntry {
  touchedAt: number;
  seenByLibrary: Map<string, Set<number>>;
}

const SESSION_TTL_MS = 60 * 60 * 1_000;
const MAX_SEEN_PER_LIBRARY = 500;

/**
 * Process-local retrieval history. It is deliberately advisory: losing it on
 * restart only means a client may see a repeated result, never lost data.
 */
export class RetrievalSessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  seen(sessionId: string | undefined, libraryId: string): ReadonlySet<number> {
    if (!sessionId) return new Set<number>();
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) return new Set<number>();
    session.touchedAt = Date.now();
    return new Set(session.seenByLibrary.get(libraryId.toLowerCase()) ?? []);
  }

  record(sessionId: string | undefined, libraryId: string, chunkIds: readonly number[]): void {
    if (!sessionId || chunkIds.length === 0) return;
    this.prune();
    const session = this.sessions.get(sessionId) ?? {
      touchedAt: Date.now(),
      seenByLibrary: new Map<string, Set<number>>(),
    };
    session.touchedAt = Date.now();
    const key = libraryId.toLowerCase();
    const seen = session.seenByLibrary.get(key) ?? new Set<number>();
    for (const id of chunkIds) seen.add(id);
    while (seen.size > MAX_SEEN_PER_LIBRARY) {
      const oldest = seen.values().next().value as number | undefined;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    session.seenByLibrary.set(key, seen);
    this.sessions.set(sessionId, session);
  }

  clear(sessionId: string | undefined, libraryId?: string): void {
    if (!sessionId) return;
    if (!libraryId) {
      this.sessions.delete(sessionId);
      return;
    }
    this.sessions.get(sessionId)?.seenByLibrary.delete(libraryId.toLowerCase());
  }

  private prune(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.touchedAt < cutoff) this.sessions.delete(id);
    }
  }
}

export const retrievalSessions = new RetrievalSessionStore();
