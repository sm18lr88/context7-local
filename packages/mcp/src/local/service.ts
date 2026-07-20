import { initDatabase } from "@neuledge/context";
import type {
  ContextRequest,
  ContextResponse,
  SearchResponse,
  SearchResult,
} from "../lib/types.js";
import { LocalLibraryBuilder, remoteCommit } from "./builder.js";
import { loadLocalContext7Config } from "./config.js";
import { LibraryDiscovery } from "./discovery.js";
import { normalizeSearchName, parseLibraryId } from "./library-id.js";
import { queryLocalDocumentation } from "./retrieval.js";
import { LocalLibraryStore } from "./store.js";
import type {
  DiscoveredLibrary,
  EnsureIndexResult,
  LibraryManifest,
  LibraryRef,
  LocalContext7Config,
} from "./types.js";

function resultFromManifest(manifest: LibraryManifest): SearchResult {
  return {
    id: manifest.id,
    title: manifest.title,
    description: manifest.description,
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
          warning: `Freshness check failed; using commit ${current.commitSha}. ${
            error instanceof Error ? error.message : String(error)
          }`,
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

    try {
      const discovered = exact
        ? {
            ref: parseLibraryId(exact.id),
            title: exact.title,
            description: exact.description,
            stars: exact.stars,
            defaultBranch: exact.branch,
          }
        : await this.discovery.discover(libraryName);
      if (discovered) {
        const ensured = await this.ensure(discovered);
        const others = local.filter((manifest) => manifest.id !== ensured.manifest.id);
        return {
          results: [resultFromManifest(ensured.manifest), ...others.map(resultFromManifest)],
        };
      }
    } catch (error) {
      return {
        results: local.map(resultFromManifest),
        error: `Local indexing failed for ${libraryName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
      return {
        data:
          warning +
          readiness +
          queryLocalDocumentation(
            ensured.databasePath,
            ensured.manifest,
            request.query,
            this.config
          ),
      };
    } catch (error) {
      return {
        data: `Local Context7 query failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async status(libraryId?: string): Promise<LibraryManifest[]> {
    await this.ready;
    const manifests = await this.store.list();
    if (!libraryId) return manifests;
    const ref = parseLibraryId(libraryId);
    return manifests.filter((manifest) => manifest.id.toLowerCase() === ref.id.toLowerCase());
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
