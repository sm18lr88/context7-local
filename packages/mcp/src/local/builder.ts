import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { buildPackage, type MarkdownFile } from "@neuledge/context";
import { LocalLibraryStore } from "./store.js";
import type {
  Context7ProjectConfig,
  DiscoveredLibrary,
  LibraryManifest,
  LibraryRef,
  LocalContext7Config,
} from "./types.js";

const execFileAsync = promisify(execFile);
export const PARSER_VERSION = "context7-local-v2-neuledge-1.2.0";
const SPARSE_DOCUMENTATION_PATTERNS = [
  "/context7.json",
  "/package.json",
  "/.gitignore",
  "/*.md",
  "/**/*.md",
  "/*.mdx",
  "/**/*.mdx",
  "/*.markdown",
  "/**/*.markdown",
  "/*.mdown",
  "/**/*.mdown",
  "/*.mkd",
  "/**/*.mkd",
  "/*.adoc",
  "/**/*.adoc",
  "/*.asciidoc",
  "/**/*.asciidoc",
  "/*.rst",
  "/**/*.rst",
  "/*.rest",
  "/**/*.rest",
];
const DOCUMENTATION_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".markdown",
  ".mdown",
  ".mkd",
  ".adoc",
  ".asciidoc",
  ".rst",
  ".rest",
]);
const WALK_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  "out",
]);

interface SafeCheckout {
  tempDir: string;
  cleanup: () => Promise<void>;
}

function hardenedGitConfig(disabledHooks: string): string[] {
  return [
    "-c",
    `core.hooksPath=${disabledHooks}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "filter.lfs.smudge=",
    "-c",
    "filter.lfs.process=",
    "-c",
    "filter.lfs.required=false",
  ];
}

function removeCheckout(path: string): Promise<void> {
  return rm(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 250,
  });
}

async function cloneRepositorySafe(
  url: string,
  ref: string | undefined,
  timeoutMs: number
): Promise<SafeCheckout> {
  const parent = await mkdtemp(join(tmpdir(), "context7-local-"));
  const tempDir = join(parent, "repository");
  const disabledHooks = join(parent, "hooks-disabled");
  await mkdir(disabledHooks);

  try {
    const gitConfig = hardenedGitConfig(disabledHooks);
    const args = [
      ...gitConfig,
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--filter=blob:none",
      "--no-checkout",
    ];
    if (ref) args.push("--branch", ref);
    args.push(url, tempDir);
    const processOptions = {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
    } as const;
    await execFileAsync("git", args, processOptions);
    await execFileAsync(
      "git",
      [
        ...gitConfig,
        "-C",
        tempDir,
        "sparse-checkout",
        "set",
        "--no-cone",
        ...SPARSE_DOCUMENTATION_PATTERNS,
      ],
      processOptions
    );
    await execFileAsync(
      "git",
      [...gitConfig, "-C", tempDir, "checkout", "--force"],
      processOptions
    );
    return {
      tempDir,
      cleanup: () => removeCheckout(parent),
    };
  } catch (error) {
    await removeCheckout(parent).catch(() => undefined);
    throw error;
  }
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`(^|/)${source}(/|$)`, "i");
}

function matchesFolder(path: string, pattern: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!pattern.includes("*") && !pattern.includes("?")) {
    const candidate = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (pattern.startsWith("./"))
      return normalized === candidate || normalized.startsWith(`${candidate}/`);
    return normalized.split("/").includes(candidate) || normalized.startsWith(`${candidate}/`);
  }
  return globToRegExp(pattern).test(normalized);
}

function filterFiles(files: MarkdownFile[], project: Context7ProjectConfig): MarkdownFile[] {
  const excludedFiles = new Set((project.excludeFiles ?? []).map((value) => value.toLowerCase()));
  const includedFolders = project.folders ?? [];
  const excludedFolders = project.excludeFolders ?? [];

  return files.filter((file) => {
    const path = file.path.replaceAll("\\", "/");
    if (excludedFiles.has(posix.basename(path).toLowerCase())) return false;
    if (excludedFolders.some((pattern) => matchesFolder(path, pattern))) return false;
    if (includedFolders.length === 0) return true;
    if (!path.includes("/")) return true;
    return includedFolders.some((pattern) => matchesFolder(path, pattern));
  });
}

interface DocumentationPath {
  absolutePath: string;
  relativePath: string;
  bytes: number;
}

function supportedDocumentationPath(path: string): boolean {
  const extension = posix.extname(path.toLowerCase());
  return DOCUMENTATION_EXTENSIONS.has(extension);
}

async function findDocumentationPaths(
  root: string,
  config: Pick<LocalContext7Config, "maxFiles" | "maxFileBytes">
): Promise<DocumentationPath[]> {
  const found: DocumentationPath[] = [];
  const pending = [{ absolutePath: root, relativePath: "" }];
  const traversalLimit = Math.max(20_000, config.maxFiles * 10);
  let visited = 0;

  while (pending.length > 0 && visited < traversalLimit) {
    const directory = pending.pop();
    if (!directory) break;
    let entries;
    try {
      entries = await readdir(directory.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > traversalLimit) break;
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const relativePath = directory.relativePath
        ? `${directory.relativePath}/${entry.name}`
        : entry.name;
      const absolutePath = join(directory.absolutePath, entry.name);
      if (entry.isDirectory()) {
        if (!WALK_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
          pending.push({ absolutePath, relativePath });
        }
        continue;
      }
      if (!entry.isFile() || !supportedDocumentationPath(relativePath)) continue;
      try {
        const info = await stat(absolutePath);
        if (info.size <= config.maxFileBytes) {
          found.push({ absolutePath, relativePath, bytes: info.size });
        }
      } catch {
        // A file may disappear if a checkout is interrupted; skip it safely.
      }
    }
  }
  return found;
}

export async function readDocumentationFilesBounded(
  root: string,
  config: Pick<LocalContext7Config, "maxFiles" | "maxFileBytes" | "maxIndexBytes">
): Promise<MarkdownFile[]> {
  const paths = await findDocumentationPaths(root, config);
  const ranked = paths.sort(
    (left, right) =>
      documentationPriority({ path: right.relativePath, content: "" }) -
        documentationPriority({ path: left.relativePath, content: "" }) ||
      left.relativePath.localeCompare(right.relativePath)
  );
  const files: MarkdownFile[] = [];
  const readBudget =
    config.maxIndexBytes + Math.min(config.maxIndexBytes, 64 * config.maxFileBytes);
  let bytesRead = 0;
  for (const candidate of ranked) {
    if (files.length >= config.maxFiles * 2 || bytesRead + candidate.bytes > readBudget) continue;
    try {
      const content = await readFile(candidate.absolutePath, "utf8");
      bytesRead += candidate.bytes;
      files.push({ path: candidate.relativePath, content });
    } catch {
      // Never let one unreadable file prevent an otherwise useful index.
    }
  }
  return files;
}

const NON_DOCUMENTATION_NAMES = new Set([
  "agents.md",
  "claude.md",
  "gemini.md",
  "license.md",
  "notice.md",
  "authors.md",
  "code_of_conduct.md",
  "code-of-conduct.md",
]);

function documentationPriority(file: MarkdownFile): number {
  const path = file.path.replaceAll("\\", "/").toLowerCase();
  const name = posix.basename(path);
  let score = 50;
  if (path === "readme.md" || path === "readme.mdx") score += 200;
  if (/(^|\/)(docs?|documentation|manual|handbook)(\/|$)/.test(path)) score += 150;
  if (/(^|\/)(reference|api|guides?|tutorials?|concepts?)(\/|$)/.test(path)) score += 110;
  if (/^(reference|api|guide|tutorial|concepts?)\.(md|mdx|markdown|rst|adoc)$/.test(name))
    score += 110;
  if (/(^|\/)(examples?|samples?)(\/|$)/.test(path)) score += 65;
  if (/migration|upgrade|changelog|release/.test(name)) score += 35;
  if (/(^|\/)(test|tests|fixtures?|benchmarks?|vendor|node_modules)(\/|$)/.test(path)) score -= 140;
  if (/contributing|governance|maintainers|pull_request/.test(name)) score -= 80;
  if (path.startsWith(".github/")) score -= 120;
  // Prefer concise source documentation when all other signals are equal.
  score -= Math.min(25, Math.floor(Buffer.byteLength(file.content) / (256 * 1024)));
  return score;
}

export interface SelectedDocumentation {
  files: MarkdownFile[];
  totalBytes: number;
  stats: NonNullable<LibraryManifest["selection"]>;
}

export function selectDocumentationFiles(
  candidates: MarkdownFile[],
  project: Context7ProjectConfig,
  limits: Pick<LocalContext7Config, "maxFiles" | "maxFileBytes" | "maxIndexBytes">
): SelectedDocumentation {
  const filtered = filterFiles(candidates, project);
  const explicitlyScoped = (project.folders?.length ?? 0) > 0;
  const ranked = filtered
    .filter((file) => {
      const name = posix.basename(file.path.replaceAll("\\", "/")).toLowerCase();
      return explicitlyScoped || !NON_DOCUMENTATION_NAMES.has(name);
    })
    .sort(
      (left, right) =>
        documentationPriority(right) - documentationPriority(left) ||
        left.path.localeCompare(right.path)
    );
  const excludedNoiseFiles = filtered.length - ranked.length;
  const files: MarkdownFile[] = [];
  const hashes = new Set<string>();
  let totalBytes = 0;
  let duplicateFiles = 0;
  let oversizedFiles = 0;
  let budgetSkippedFiles = 0;

  for (const file of ranked) {
    const bytes = Buffer.byteLength(file.content);
    if (bytes > limits.maxFileBytes || file.content.includes("\u0000")) {
      oversizedFiles += 1;
      continue;
    }
    const digest = createHash("sha256").update(file.content).digest("hex");
    if (hashes.has(digest)) {
      duplicateFiles += 1;
      continue;
    }
    if (files.length >= limits.maxFiles) {
      budgetSkippedFiles += 1;
      continue;
    }
    if (totalBytes + bytes > limits.maxIndexBytes) {
      budgetSkippedFiles += 1;
      continue;
    }
    hashes.add(digest);
    totalBytes += bytes;
    files.push(file);
  }

  return {
    files,
    totalBytes,
    stats: {
      candidateFiles: candidates.length,
      selectedFiles: files.length,
      excludedNoiseFiles,
      duplicateFiles,
      oversizedFiles,
      budgetSkippedFiles,
    },
  };
}

async function readProjectConfig(root: string): Promise<Context7ProjectConfig> {
  try {
    const path = join(root, "context7.json");
    if ((await stat(path)).size > 1024 * 1024) return {};
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Context7ProjectConfig) : {};
  } catch {
    return {};
  }
}

async function packageDescription(root: string): Promise<string | undefined> {
  try {
    const path = join(root, "package.json");
    if ((await stat(path)).size > 1024 * 1024) return undefined;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = (parsed as { description?: unknown }).description;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function gitValue(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function remoteCommit(
  ref: LibraryRef,
  branchOrTag: string | undefined,
  config: LocalContext7Config
): Promise<string> {
  const patterns = branchOrTag
    ? [`refs/tags/${branchOrTag}^{}`, `refs/tags/${branchOrTag}`, `refs/heads/${branchOrTag}`]
    : ["HEAD"];
  const result = await execFileAsync("git", ["ls-remote", ref.repositoryUrl, ...patterns], {
    encoding: "utf8",
    timeout: config.gitTimeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  const rows = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/, 2))
    .filter((row) => row.length === 2 && /^[0-9a-f]{40}$/i.test(row[0] ?? ""));
  const peeled = rows.find((row) => row[1]?.endsWith("^{}"));
  const commit = peeled?.[0] ?? rows[0]?.[0];
  if (!commit) throw new Error(`Unable to resolve the remote commit for ${ref.id}`);
  return commit;
}

export class LocalLibraryBuilder {
  constructor(
    private readonly config: LocalContext7Config,
    private readonly store: LocalLibraryStore
  ) {}

  async build(
    discovered: DiscoveredLibrary,
    preferredRef?: string
  ): Promise<{ manifest: LibraryManifest; databasePath: string }> {
    const releaseLock = await this.store.acquireBuildLock(
      discovered.ref,
      this.config.gitTimeoutMs * 3
    );
    try {
      return await this.buildUnlocked(discovered, preferredRef);
    } finally {
      await releaseLock();
    }
  }

  private async buildUnlocked(
    discovered: DiscoveredLibrary,
    preferredRef?: string
  ): Promise<{ manifest: LibraryManifest; databasePath: string }> {
    const { ref } = discovered;
    let checkout = await cloneRepositorySafe(
      ref.repositoryUrl,
      ref.version ?? preferredRef,
      this.config.gitTimeoutMs
    );

    try {
      let project = await readProjectConfig(checkout.tempDir);
      if (!ref.version && !preferredRef && project.branch) {
        await checkout.cleanup();
        checkout = await cloneRepositorySafe(
          ref.repositoryUrl,
          project.branch,
          this.config.gitTimeoutMs
        );
        project = await readProjectConfig(checkout.tempDir);
      }

      const commitSha = await gitValue(checkout.tempDir, "rev-parse", "HEAD");
      const branch =
        ref.version ??
        preferredRef ??
        project.branch ??
        discovered.defaultBranch ??
        (await gitValue(checkout.tempDir, "rev-parse", "--abbrev-ref", "HEAD"));

      const candidateFiles = await readDocumentationFilesBounded(checkout.tempDir, this.config);
      if (candidateFiles.length === 0) {
        throw new Error(
          `${ref.id} has no supported documentation files. Add Markdown, MDX, AsciiDoc, or reStructuredText documentation.`
        );
      }
      const selected = selectDocumentationFiles(candidateFiles, project, this.config);
      const boundedFiles = selected.files;
      const totalBytes = selected.totalBytes;
      if (boundedFiles.length === 0) {
        throw new Error(`${ref.id} exceeded the configured local indexing limits`);
      }

      const temporaryDatabase = this.store.temporaryDatabasePath(ref);
      const title = project.projectTitle ?? discovered.title ?? ref.repo;
      const description =
        project.description ??
        discovered.description ??
        (await packageDescription(checkout.tempDir)) ??
        `Documentation for ${ref.owner}/${ref.repo}`;
      const versionLabel = ref.version ?? branch ?? commitSha.slice(0, 12);
      const result = buildPackage(temporaryDatabase, boundedFiles, {
        name: ref.id,
        version: versionLabel,
        description,
        sourceUrl: ref.repositoryUrl.replace(/\.git$/, ""),
        sourceCommit: commitSha,
      });
      if (result.sectionCount === 0) {
        throw new Error(`${ref.id} documentation did not produce any searchable sections`);
      }

      const now = new Date().toISOString();
      const versions = [
        ...(project.previousVersions ?? []).flatMap((entry) =>
          entry.tag ? [`/${ref.owner}/${ref.repo}/${entry.tag}`] : []
        ),
        ...(project.branchVersions ?? []).flatMap((entry) =>
          entry.branch ? [`/${ref.owner}/${ref.repo}/${entry.branch}`] : []
        ),
      ];
      const manifest: LibraryManifest = {
        schemaVersion: 1,
        parserVersion: PARSER_VERSION,
        id: ref.id,
        title,
        description,
        repositoryUrl: ref.repositoryUrl,
        owner: ref.owner,
        repo: ref.repo,
        version: ref.version,
        branch,
        commitSha,
        indexedAt: now,
        checkedAt: now,
        documentFiles: boundedFiles.length,
        sectionCount: result.sectionCount,
        totalBytes,
        totalTokens: result.totalTokens,
        rules: (project.rules ?? []).filter((rule): rule is string => typeof rule === "string"),
        versions,
        stars: discovered.stars,
        selection: selected.stats,
      };
      const databasePath = await this.store.publish(temporaryDatabase, manifest);
      const databaseSize = (await stat(databasePath)).size;
      if (databaseSize === 0) throw new Error(`The generated database for ${ref.id} is empty`);
      return { manifest, databasePath };
    } finally {
      await checkout.cleanup();
    }
  }
}
