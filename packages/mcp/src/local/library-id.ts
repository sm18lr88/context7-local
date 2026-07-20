import { createHash } from "node:crypto";
import type { LibraryRef } from "./types.js";

const PART_PATTERN = /^[A-Za-z0-9_.-]+$/;
const VERSION_PATTERN = /^[A-Za-z0-9_.+/-]+$/;

function assertSafePart(value: string, label: string): void {
  if (!PART_PATTERN.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${label} in library ID`);
  }
}

export function parseLibraryId(value: string): LibraryRef {
  const parts = value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/");
  if (parts.length < 2) {
    throw new Error("Library ID must use /owner/repository format");
  }
  const [owner, repo, ...versionParts] = parts;
  assertSafePart(owner, "owner");
  assertSafePart(repo, "repository");
  const version = versionParts.length > 0 ? versionParts.join("/") : undefined;
  if (version && (!VERSION_PATTERN.test(version) || version.includes(".."))) {
    throw new Error("Invalid version in library ID");
  }
  const id = `/${owner}/${repo}${version ? `/${version}` : ""}`;
  return {
    id,
    owner,
    repo,
    version,
    repositoryUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

export function parseGitHubRepository(value: string): LibraryRef | undefined {
  const trimmed = value.trim();
  if (/^\/?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(trimmed)) {
    return parseLibraryId(trimmed.replace(/\.git$/i, ""));
  }

  const normalized = trimmed
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
    .replace(/^git:\/\/github\.com\//i, "https://github.com/");

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return undefined;
  const parts = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (parts.length !== 2) return undefined;
  return parseLibraryId(`/${parts[0]}/${parts[1]}`);
}

export function libraryStorageKey(id: string): string {
  return createHash("sha256").update(id.toLowerCase()).digest("hex");
}

export function normalizeSearchName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
