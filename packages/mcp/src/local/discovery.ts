import { normalizeSearchName, parseGitHubRepository } from "./library-id.js";
import type { DiscoveredLibrary, LibraryRef, LocalContext7Config } from "./types.js";

type JsonObject = Record<string, unknown>;
const DOCUMENTATION_QUALIFIERS = new Set([
  "docs",
  "documentation",
  "manual",
  "reference",
  "references",
]);
const MAX_GITHUB_SEARCH_CANDIDATES = 3;

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

function discoveryNames(name: string): string[] {
  const original = name.trim();
  const words = original.split(/\s+/);
  while (words.length > 1 && DOCUMENTATION_QUALIFIERS.has((words.at(-1) ?? "").toLowerCase())) {
    words.pop();
  }
  const withoutQualifier = words.join(" ");
  return withoutQualifier && withoutQualifier !== original
    ? [original, withoutQualifier]
    : [original];
}

function usableGitHubRepository(value: JsonObject | undefined): boolean {
  if (!value || value.archived === true || value.disabled === true) return false;
  return typeof value.size !== "number" || value.size > 0;
}

function discoveredFromGitHub(value: JsonObject | undefined): DiscoveredLibrary | undefined {
  if (!usableGitHubRepository(value)) return undefined;
  const fullName = asString(value?.full_name);
  const ref = fullName ? parseGitHubRepository(fullName) : undefined;
  const defaultBranch = asString(value?.default_branch);
  if (!ref || !defaultBranch) return undefined;
  return {
    ref,
    title: asString(value?.name),
    description: asString(value?.description),
    stars: typeof value?.stargazers_count === "number" ? value.stargazers_count : undefined,
    defaultBranch,
  };
}

function uniqueCandidates(candidates: DiscoveredLibrary[]): DiscoveredLibrary[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.ref.id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  private async verifiedGitHubRepository(ref: LibraryRef): Promise<DiscoveredLibrary | undefined> {
    const headers: Record<string, string> = {};
    if (this.config.githubToken) headers.Authorization = `Bearer ${this.config.githubToken}`;
    try {
      const data = asObject(
        await this.fetchJson(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, headers)
      );
      return discoveredFromGitHub(data);
    } catch {
      return undefined;
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

  private async fromOfficialDocumentationRepository(
    originalName: string,
    searchName: string
  ): Promise<DiscoveredLibrary | undefined> {
    if (originalName.trim() === searchName.trim()) return undefined;
    const owner = searchName.trim().split(/\s+/, 1)[0];
    if (!owner || !/^[A-Za-z0-9_.-]+$/.test(owner)) return undefined;
    const ref = parseGitHubRepository(`/${owner}/docs`);
    return ref ? this.verifiedGitHubRepository(ref) : undefined;
  }

  private async fromGitHubSearch(name: string): Promise<DiscoveredLibrary[]> {
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
      return items
        .filter((item) => normalizeSearchName(asString(item?.name) ?? "") === normalized)
        .map(discoveredFromGitHub)
        .filter((candidate): candidate is DiscoveredLibrary => Boolean(candidate))
        .sort((left, right) => (right.stars ?? 0) - (left.stars ?? 0))
        .slice(0, MAX_GITHUB_SEARCH_CANDIDATES);
    } catch {
      return [];
    }
  }

  async discoverCandidates(name: string): Promise<DiscoveredLibrary[]> {
    const direct = parseGitHubRepository(name);
    if (direct) return [await this.decorate(direct)];

    const names = discoveryNames(name);
    const registryCandidates = await Promise.all(
      names.flatMap((candidateName) =>
        [this.fromNpm, this.fromPyPi, this.fromCrates].map((resolver) =>
          resolver.call(this, candidateName)
        )
      )
    );
    const [officialDocumentation, ...githubCandidates] = await Promise.all([
      this.fromOfficialDocumentationRepository(names[0]!, names.at(-1)!),
      ...names.map((candidateName) => this.fromGitHubSearch(candidateName)),
    ]);
    return uniqueCandidates([
      ...registryCandidates.filter((candidate): candidate is DiscoveredLibrary =>
        Boolean(candidate)
      ),
      ...(officialDocumentation ? [officialDocumentation] : []),
      ...githubCandidates.flat(),
    ]);
  }

  async discover(name: string): Promise<DiscoveredLibrary | undefined> {
    return (await this.discoverCandidates(name))[0];
  }
}
