import { initDatabase } from "@neuledge/context";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ContextRequest,
  ContextResponse,
  SearchResponse,
  SearchResult,
} from "../lib/types.js";
import { LocalLibraryBuilder, PARSER_VERSION, remoteCommit } from "./builder.js";
import { loadLocalContext7Config } from "./config.js";
import { LibraryDiscovery } from "./discovery.js";
import { normalizeSearchName, parseLibraryId } from "./library-id.js";
import {
  formatDocumentationMatches,
  formatSearchMatches,
  grepLocalDocumentation,
  readLocalDocumentation,
  searchLocalDocumentation,
} from "./retrieval.js";
import { retrievalSessions } from "./retrieval-session.js";
import { rerankWithLocalEmbeddings } from "./semantic.js";
import { LocalLibraryStore } from "./store.js";
import type {
  DiscoveredLibrary,
  EnsureIndexResult,
  LibraryManifest,
  LibraryRef,
  LocalContext7Config,
} from "./types.js";

const MAX_INDEX_CANDIDATES = 5;

function resultFromManifest(manifest: LibraryManifest): SearchResult {
  const safe = (value: string, limit: number) =>
    value
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);
  return {
    id: manifest.id,
    title: safe(manifest.title, 200),
    description: safe(manifest.description, 1_000),
    branch: manifest.branch,
    lastUpdateDate: manifest.indexedAt,
    state: "finalized",
    totalTokens: manifest.totalTokens,
    totalSnippets: manifest.sectionCount,
    stars: manifest.stars,
    trustScore: 8,
    versions: manifest.versions,
    source: `Local SQLite index at commit ${manifest.commitSha}`,
  };
}

function matchesManifest(manifest: LibraryManifest, name: string): boolean {
  const needle = normalizeSearchName(name);
  return [manifest.id, manifest.title, manifest.repo]
    .map(normalizeSearchName)
    .some((candidate) => candidate === needle || candidate.includes(needle));
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

export class LocalContext7Service {
  readonly config: LocalContext7Config;
  readonly store: LocalLibraryStore;
  private readonly discovery: LibraryDiscovery;
  private readonly builder: LocalLibraryBuilder;
  private readonly ready: Promise<void>;
  private readonly inFlight = new Map<string, Promise<EnsureIndexResult>>();

  constructor(config: LocalContext7Config = loadLocalContext7Config()) {
    this.config = config;
    this.store = new LocalLibraryStore(config);
    this.discovery = new LibraryDiscovery(config);
    this.builder = new LocalLibraryBuilder(config, this.store);
    this.ready = Promise.all([this.store.initialize(), initDatabase()]).then(() => undefined);
  }

  private async buildOnce(
    discovered: DiscoveredLibrary,
    preferredRef?: string
  ): Promise<EnsureIndexResult> {
    const key = discovered.ref.id.toLowerCase();
    const active = this.inFlight.get(key);
    if (active) return active;
    const operation = this.builder
      .build(discovered, preferredRef)
      .then(({ manifest, databasePath }) => ({
        manifest,
        databasePath,
        disposition: "indexed" as const,
      }))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return operation;
  }

  async ensure(
    discovered: DiscoveredLibrary,
    options: { force?: boolean } = {}
  ): Promise<EnsureIndexResult> {
    await this.ready;
    const current = await this.store.load(discovered.ref);
    if (!current) return this.buildOnce(discovered);

    if (current.parserVersion !== PARSER_VERSION) {
      const migrated = await this.buildOnce(discovered, current.version ?? current.branch);
      return { ...migrated, disposition: "refreshed" };
    }

    if (!options.force) {
      const age = Date.now() - Date.parse(current.checkedAt);
      if (Number.isFinite(age) && age < this.config.refreshIntervalMs) {
        return {
          manifest: current,
          databasePath: this.store.databasePath(discovered.ref),
          disposition: "cached",
        };
      }

      try {
        const remote = await remoteCommit(
          discovered.ref,
          current.version ?? current.branch,
          this.config
        );
        if (remote === current.commitSha) {
          const checked = { ...current, checkedAt: new Date().toISOString() };
          await this.store.saveManifest(checked);
          return {
            manifest: checked,
            databasePath: this.store.databasePath(discovered.ref),
            disposition: "cached",
          };
        }
      } catch (error) {
        return {
          manifest: current,
          databasePath: this.store.databasePath(discovered.ref),
          disposition: "stale-fallback",
          warning: `Freshness check failed; using commit ${current.commitSha}. ${safeError(error)}`,
        };
      }
    }

    const refreshed = await this.buildOnce(discovered, current.version ?? current.branch);
    return { ...refreshed, disposition: "refreshed" };
  }

  async searchLibraries(query: string, libraryName: string): Promise<SearchResponse> {
    await this.ready;
    const local = (await this.store.list()).filter((manifest) =>
      matchesManifest(manifest, libraryName)
    );
    const exact = local.find(
      (manifest) =>
        normalizeSearchName(manifest.title) === normalizeSearchName(libraryName) ||
        normalizeSearchName(manifest.repo) === normalizeSearchName(libraryName) ||
        normalizeSearchName(manifest.id) === normalizeSearchName(libraryName)
    );

    const candidates = exact
      ? {
          ref: parseLibraryId(exact.id),
          title: exact.title,
          description: exact.description,
          stars: exact.stars,
          defaultBranch: exact.branch,
        }
      : undefined;
    const discovered = candidates
      ? [candidates]
      : await this.discovery.discoverCandidates(libraryName);
    const failures: string[] = [];
    for (const candidate of discovered.slice(0, MAX_INDEX_CANDIDATES)) {
      try {
        const ensured = await this.ensure(candidate);
        const others = local.filter((manifest) => manifest.id !== ensured.manifest.id);
        return {
          results: [resultFromManifest(ensured.manifest), ...others.map(resultFromManifest)],
        };
      } catch (error) {
        failures.push(`${candidate.ref.id}: ${safeError(error)}`);
      }
    }
    if (failures.length > 0) {
      return {
        results: local.map(resultFromManifest),
        error: `Local indexing failed for ${libraryName} after trying ${failures.join("; ")}`,
      };
    }

    if (local.length > 0) return { results: local.map(resultFromManifest) };
    return {
      results: [],
      error: `No unambiguous GitHub repository was found for ${JSON.stringify(
        libraryName
      )}. Retry with an explicit /owner/repository Context7 library ID. Query: ${query}`,
    };
  }

  async fetchLibraryContext(request: ContextRequest): Promise<ContextResponse> {
    try {
      const ref = parseLibraryId(request.libraryId);
      const existing = await this.store.load(ref);
      const discovered = existing
        ? {
            ref,
            title: existing.title,
            description: existing.description,
            stars: existing.stars,
            defaultBranch: existing.branch,
          }
        : await this.discovery.discover(ref.id);
      if (!discovered) return { data: `Unable to discover ${ref.id}` };
      const ensured = await this.ensure(discovered);
      const warning = ensured.warning ? `Warning: ${ensured.warning}\n\n` : "";
      const readiness = `Local index ${ensured.disposition}: ${ensured.manifest.id} is ready.\n\n`;
      const lexical = searchLocalDocumentation(ensured.databasePath, request.query, {
        maxTokens: 4_000,
        limit: Math.max(12, this.config.embeddingCandidates ?? 24),
      });
      const result = await rerankWithLocalEmbeddings(
        ensured.databasePath,
        ensured.manifest,
        request.query,
        lexical,
        this.config
      );
      return {
        data:
          warning +
          readiness +
          formatDocumentationMatches(result, ensured.manifest, request.query, this.config),
      };
    } catch (error) {
      return {
        data: `Local Context7 query failed: ${safeError(error)}`,
      };
    }
  }

  private async readyLibrary(libraryId: string): Promise<EnsureIndexResult> {
    const ref = parseLibraryId(libraryId);
    const existing = await this.store.load(ref);
    const discovered = existing
      ? {
          ref,
          title: existing.title,
          description: existing.description,
          stars: existing.stars,
          defaultBranch: existing.branch,
        }
      : await this.discovery.discover(ref.id);
    if (!discovered) throw new Error(`Unable to discover ${ref.id}`);
    return this.ensure(discovered);
  }

  async searchDocumentation(
    libraryId: string,
    query: string,
    options: { maxTokens?: number; limit?: number; sessionId?: string; includeSeen?: boolean } = {}
  ): Promise<string> {
    const ensured = await this.readyLibrary(libraryId);
    const excluded = options.includeSeen
      ? undefined
      : retrievalSessions.seen(
          options.sessionId,
          `${ensured.manifest.id}@${ensured.manifest.commitSha}`
        );
    let result = searchLocalDocumentation(ensured.databasePath, query, {
      maxTokens: options.maxTokens,
      limit: Math.max(options.limit ?? 12, this.config.embeddingCandidates ?? 24),
      excludeChunkIds: excluded,
    });
    // A long session should not make relevant information disappear forever.
    // If every good result was already seen, repeat the best evidence explicitly.
    if (result.matches.length === 0 && excluded && excluded.size > 0) {
      result = searchLocalDocumentation(ensured.databasePath, query, {
        maxTokens: options.maxTokens,
        limit: options.limit,
      });
    }
    result = await rerankWithLocalEmbeddings(
      ensured.databasePath,
      ensured.manifest,
      query,
      result,
      this.config
    );
    if (options.limit && result.matches.length > options.limit) {
      result = { ...result, matches: result.matches.slice(0, options.limit) };
    }
    retrievalSessions.record(
      options.sessionId,
      `${ensured.manifest.id}@${ensured.manifest.commitSha}`,
      result.matches.map((match) => match.id)
    );
    const readiness = `Local index ${ensured.disposition}: ${ensured.manifest.id} is ready.\n\n`;
    const warning = ensured.warning ? `Warning: ${ensured.warning}\n\n` : "";
    return warning + readiness + formatSearchMatches(result, ensured.manifest);
  }

  async readDocumentation(
    libraryId: string,
    resultId: number | string,
    maxTokens?: number
  ): Promise<string> {
    const ensured = await this.readyLibrary(libraryId);
    let chunkId: number;
    if (typeof resultId === "number") {
      chunkId = resultId;
    } else {
      const match = /^([0-9a-f]{40}):([1-9][0-9]*)$/i.exec(resultId);
      if (!match) throw new Error("Result key must use <40-character-commit-sha>:<chunk-id>");
      const expectedCommit = match[1]!;
      if (expectedCommit.toLowerCase() !== ensured.manifest.commitSha.toLowerCase()) {
        return `Result key ${resultId} belongs to an older repository commit. Run search-docs again to get current evidence.`;
      }
      chunkId = Number(match[2]);
      if (!Number.isSafeInteger(chunkId)) throw new Error("Result key chunk ID is out of range");
    }
    return readLocalDocumentation(ensured.databasePath, ensured.manifest, chunkId, maxTokens);
  }

  async grepDocumentation(
    libraryId: string,
    pattern: string,
    options: { limit?: number } = {}
  ): Promise<string> {
    const ensured = await this.readyLibrary(libraryId);
    return grepLocalDocumentation(ensured.databasePath, ensured.manifest, pattern, options);
  }

  async status(libraryId?: string): Promise<LibraryManifest[]> {
    await this.ready;
    const manifests = await this.store.list();
    if (!libraryId) return manifests;
    const ref = parseLibraryId(libraryId);
    return manifests.filter((manifest) => manifest.id.toLowerCase() === ref.id.toLowerCase());
  }

  async indexHealth(libraryId?: string): Promise<Record<string, unknown>> {
    const manifests = await this.status(libraryId);
    const current = manifests.filter((manifest) => manifest.parserVersion === PARSER_VERSION);
    let prewarm: unknown;
    let migration: unknown;
    try {
      const value = JSON.parse(
        await readFile(join(this.config.storageDir, "prewarm", "top-1000.progress.json"), "utf8")
      ) as Record<string, unknown>;
      prewarm = {
        status: value.status,
        target: value.target,
        succeeded: value.succeeded,
        failed: value.failed,
        nextCandidateIndex: value.nextCandidateIndex,
        updatedAt: value.updatedAt,
      };
    } catch {
      prewarm = { status: "not-started" };
    }
    try {
      const value = JSON.parse(
        await readFile(join(this.config.storageDir, "migration.progress.json"), "utf8")
      ) as Record<string, unknown>;
      migration = {
        status: value.status,
        parserVersion: value.parserVersion,
        total: value.total,
        succeeded: value.succeeded,
        failed: value.failed,
        remaining: value.remaining,
        active: value.active,
        updatedAt: value.updatedAt,
      };
    } catch {
      migration = { status: "not-started" };
    }

    if (libraryId) {
      const manifest = manifests[0];
      if (!manifest) {
        return {
          storageDir: this.config.storageDir,
          libraryId,
          indexed: false,
          prewarm,
          migration,
        };
      }
      const semanticPath = this.store.databasePath(manifest).replace(/\.db$/i, ".semantic.db");
      let semanticCacheBytes = 0;
      try {
        semanticCacheBytes = (await stat(semanticPath)).size;
      } catch {
        // A semantic cache is optional derived data.
      }
      const { rules, ...publicManifest } = manifest;
      return {
        storageDir: this.config.storageDir,
        indexed: true,
        updateRequired: manifest.parserVersion !== PARSER_VERSION,
        semanticModel: this.config.embeddingModel ?? "disabled",
        semanticCacheBytes,
        manifest: {
          ...publicManifest,
          title: manifest.title.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200),
          description: manifest.description.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1_000),
          repositoryRuleCount: rules.length,
        },
        prewarm,
        migration,
      };
    }

    return {
      storageDir: this.config.storageDir,
      indexedLibraries: manifests.length,
      currentParserVersion: PARSER_VERSION,
      currentLibraries: current.length,
      migrationPendingLibraries: manifests.length - current.length,
      totalSections: manifests.reduce((sum, manifest) => sum + manifest.sectionCount, 0),
      totalTokens: manifests.reduce((sum, manifest) => sum + manifest.totalTokens, 0),
      oldestFreshnessCheck: manifests.map((manifest) => manifest.checkedAt).sort()[0],
      semanticModel: this.config.embeddingModel ?? "disabled",
      prewarm,
      migration,
    };
  }

  async refresh(libraryId: string): Promise<EnsureIndexResult> {
    const ref: LibraryRef = parseLibraryId(libraryId);
    const current = await this.store.load(ref);
    const discovered = current
      ? {
          ref,
          title: current.title,
          description: current.description,
          stars: current.stars,
          defaultBranch: current.branch,
        }
      : await this.discovery.discover(ref.id);
    if (!discovered) throw new Error(`Unable to discover ${ref.id}`);
    return this.ensure(discovered, { force: true });
  }
}

export const localContext7Service = new LocalContext7Service();
