export interface PopularLibraryCandidate {
  libraryId: string;
  title: string;
  description?: string;
  stars?: number;
  defaultBranch?: string;
  sources: string[];
  score: number;
}

export interface PopularLibrary extends PopularLibraryCandidate {
  rank: number;
}

export interface PopularLibraryCatalog {
  schemaVersion: 1;
  generatedAt: string;
  targetSuccessful: number;
  candidateCount: number;
  methodology: string;
  sources: Array<{ name: string; query: string }>;
  libraries: PopularLibrary[];
}

export interface PrewarmResultEvent {
  schemaVersion: 1;
  libraryId: string;
  rank: number;
  status: "succeeded" | "failed";
  attemptedAt: string;
  elapsedMs: number;
  disposition?: "cached" | "indexed" | "refreshed" | "stale-fallback";
  commitSha?: string;
  documentFiles?: number;
  sectionCount?: number;
  totalBytes?: number;
  error?: string;
}

export interface PrewarmProgress {
  schemaVersion: 1;
  status: "running" | "completed" | "stopped" | "exhausted";
  pid: number;
  startedAt: string;
  updatedAt: string;
  catalogGeneratedAt: string;
  targetSuccessful: number;
  candidateCount: number;
  concurrency: number;
  succeeded: number;
  failed: number;
  remaining: number;
  active: number;
  lastLibraryId?: string;
}
