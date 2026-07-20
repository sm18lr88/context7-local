export interface LocalContext7Config {
  storageDir: string;
  refreshIntervalMs: number;
  gitTimeoutMs: number;
  fetchTimeoutMs: number;
  maxFiles: number;
  maxFileBytes: number;
  maxIndexBytes: number;
  maxResultChars: number;
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  embeddingTimeoutMs?: number;
  embeddingCandidates?: number;
  githubToken?: string;
}

export interface LibraryRef {
  id: string;
  owner: string;
  repo: string;
  version?: string;
  repositoryUrl: string;
}

export interface DiscoveredLibrary {
  ref: LibraryRef;
  title?: string;
  description?: string;
  stars?: number;
  defaultBranch?: string;
}

export interface RepositoryCheckout {
  path: string;
  commitSha: string;
  branch: string;
  files: string[];
}

export interface LibraryManifest {
  schemaVersion: 1;
  parserVersion: string;
  id: string;
  title: string;
  description: string;
  repositoryUrl: string;
  owner: string;
  repo: string;
  version?: string;
  branch: string;
  commitSha: string;
  indexedAt: string;
  checkedAt: string;
  documentFiles: number;
  sectionCount: number;
  totalBytes: number;
  totalTokens: number;
  rules: string[];
  versions: string[];
  stars?: number;
  selection?: {
    candidateFiles: number;
    selectedFiles: number;
    excludedNoiseFiles: number;
    duplicateFiles: number;
    oversizedFiles: number;
    budgetSkippedFiles: number;
  };
}

export interface EnsureIndexResult {
  manifest: LibraryManifest;
  databasePath: string;
  disposition: "cached" | "indexed" | "refreshed" | "stale-fallback";
  warning?: string;
}

export interface Context7ProjectConfig {
  projectTitle?: string;
  description?: string;
  branch?: string;
  folders?: string[];
  excludeFolders?: string[];
  excludeFiles?: string[];
  rules?: string[];
  previousVersions?: Array<{ tag?: string }>;
  branchVersions?: Array<{ branch?: string }>;
}
