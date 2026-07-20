import { normalizeSearchName, parseGitHubRepository } from "./library-id.js";
import type { DiscoveredLibrary, LibraryRef, LocalContext7Config } from "./types.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" ? (value as JsonObject) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function repositoryFromValue(value: unknown): LibraryRef | undefined {
  if (typeof value === "string") return parseGitHubRepository(value);
  const object = asObject(value);
  return object ? parseGitHubRepository(asString(object.url) ?? "") : undefined;
}

export class LibraryDiscovery {
  constructor(private readonly config: LocalContext7Config) {}

  private async fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "context7-local/1.0", ...headers },
      signal: AbortSignal.timeout(this.config.fetchTimeoutMs),
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error(`${url} response exceeded 2 MiB`);
    return JSON.parse(text) as unknown;
  }

  private async decorate(
    ref: LibraryRef,
    fallback: Partial<DiscoveredLibrary> = {}
  ): Promise<DiscoveredLibrary> {
    const headers: Record<string, string> = {};
    if (this.config.githubToken) headers.Authorization = `Bearer ${this.config.githubToken}`;
    try {
      const data = asObject(
        await this.fetchJson(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, headers)
      );
      return {
        ref,
        title: asString(data?.name) ?? fallback.title,
        description: asString(data?.description) ?? fallback.description,
        stars: typeof data?.stargazers_count === "number" ? data.stargazers_count : fallback.stars,
        defaultBranch: asString(data?.default_branch) ?? fallback.defaultBranch,
      };
    } catch {
      return { ref, ...fallback };
    }
  }

  private async fromNpm(name: string): Promise<DiscoveredLibrary | undefined> {
    try {
      const data = asObject(
        await this.fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)
      );
      const ref = repositoryFromValue(data?.repository);
      if (!ref) return undefined;
      return this.decorate(ref, {
        title: asString(data?.name),
        description: asString(data?.description),
      });
    } catch {
      return undefined;
    }
  }

  private async fromPyPi(name: string): Promise<DiscoveredLibrary | undefined> {
    try {
      const root = asObject(
        await this.fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)
      );
      const info = asObject(root?.info);
      const projectUrls = asObject(info?.project_urls);
      const candidates = [
        projectUrls?.Source,
        projectUrls?.Repository,
        projectUrls?.Code,
        info?.home_page,
      ];
      const ref = candidates.map(repositoryFromValue).find(Boolean);
      if (!ref) return undefined;
      return this.decorate(ref, {
        title: asString(info?.name),
        description: asString(info?.summary),
      });
    } catch {
      return undefined;
    }
  }

  private async fromCrates(name: string): Promise<DiscoveredLibrary | undefined> {
    try {
      const root = asObject(
        await this.fetchJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`)
      );
      const crate = asObject(root?.crate);
      const ref = repositoryFromValue(crate?.repository);
      if (!ref) return undefined;
      return this.decorate(ref, {
        title: asString(crate?.name),
        description: asString(crate?.description),
      });
    } catch {
      return undefined;
    }
  }

  private async fromGitHubSearch(name: string): Promise<DiscoveredLibrary | undefined> {
    const headers: Record<string, string> = {};
    if (this.config.githubToken) headers.Authorization = `Bearer ${this.config.githubToken}`;
    try {
      const root = asObject(
        await this.fetchJson(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(`${name} in:name fork:false`)}&per_page=10`,
          headers
        )
      );
      const items = Array.isArray(root?.items) ? root.items.map(asObject).filter(Boolean) : [];
      const normalized = normalizeSearchName(name);
      const exact = items.find(
        (item) => normalizeSearchName(asString(item?.name) ?? "") === normalized
      );
      const fullName = asString(exact?.full_name);
      const ref = fullName ? parseGitHubRepository(fullName) : undefined;
      if (!ref) return undefined;
      return {
        ref,
        title: asString(exact?.name),
        description: asString(exact?.description),
        stars: typeof exact?.stargazers_count === "number" ? exact.stargazers_count : undefined,
        defaultBranch: asString(exact?.default_branch),
      };
    } catch {
      return undefined;
    }
  }

  async discover(name: string): Promise<DiscoveredLibrary | undefined> {
    const direct = parseGitHubRepository(name);
    if (direct) return this.decorate(direct);

    for (const resolver of [this.fromNpm, this.fromPyPi, this.fromCrates, this.fromGitHubSearch]) {
      const result = await resolver.call(this, name);
      if (result) return result;
    }
    return undefined;
  }
}
