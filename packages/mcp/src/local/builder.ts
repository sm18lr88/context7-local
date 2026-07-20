import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { buildPackage, readLocalDocsFiles, type MarkdownFile } from "@neuledge/context";
import { LocalLibraryStore } from "./store.js";
import type {
  Context7ProjectConfig,
  DiscoveredLibrary,
  LibraryManifest,
  LibraryRef,
  LocalContext7Config,
} from "./types.js";

const execFileAsync = promisify(execFile);
const PARSER_VERSION = "context7-local-v1-neuledge-1.2.0";
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

interface SafeCheckout {
  tempDir: string;
  cleanup: () => Promise<void>;
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
    const args = [
      "-c",
      `core.hooksPath=${disabledHooks}`,
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
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    } as const;
    await execFileAsync("git", args, processOptions);
    await execFileAsync(
      "git",
      [
        "-c",
        `core.hooksPath=${disabledHooks}`,
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
      ["-c", `core.hooksPath=${disabledHooks}`, "-C", tempDir, "checkout", "--force"],
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

async function readProjectConfig(root: string): Promise<Context7ProjectConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(`${root}/context7.json`, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Context7ProjectConfig) : {};
  } catch {
    return {};
  }
}

async function packageDescription(root: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
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

      let files = filterFiles(readLocalDocsFiles(checkout.tempDir), project);
      files = files.sort((left, right) => left.path.localeCompare(right.path));
      if (files.length === 0) {
        throw new Error(
          `${ref.id} has no supported documentation files. Add Markdown, MDX, AsciiDoc, or reStructuredText documentation.`
        );
      }
      if (files.length > this.config.maxFiles) {
        files = files.slice(0, this.config.maxFiles);
      }

      let totalBytes = 0;
      const boundedFiles: MarkdownFile[] = [];
      for (const file of files) {
        const bytes = Buffer.byteLength(file.content);
        if (bytes > this.config.maxFileBytes) continue;
        if (totalBytes + bytes > this.config.maxIndexBytes) break;
        if (file.content.includes("\u0000")) continue;
        totalBytes += bytes;
        boundedFiles.push(file);
      }
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
