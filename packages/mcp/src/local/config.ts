import { homedir } from "node:os";
import { resolve } from "node:path";
import type { LocalContext7Config } from "./types.js";

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function defaultStorageDir(): string {
  if (process.platform === "win32") {
    return resolve("C:\\Apps\\System\\Context7\\index");
  }
  return resolve(homedir(), ".cache", "context7-local");
}

export function loadLocalContext7Config(): LocalContext7Config {
  return {
    storageDir: resolve(process.env.CONTEXT7_LOCAL_STORAGE_DIR || defaultStorageDir()),
    refreshIntervalMs: positiveInteger("CONTEXT7_REFRESH_INTERVAL_MS", 24 * 60 * 60 * 1000),
    gitTimeoutMs: positiveInteger("CONTEXT7_GIT_TIMEOUT_MS", 120_000),
    fetchTimeoutMs: positiveInteger("CONTEXT7_FETCH_TIMEOUT_MS", 15_000),
    maxFiles: positiveInteger("CONTEXT7_MAX_FILES", 5_000),
    maxFileBytes: positiveInteger("CONTEXT7_MAX_FILE_BYTES", 2 * 1024 * 1024),
    maxIndexBytes: positiveInteger("CONTEXT7_MAX_INDEX_BYTES", 200 * 1024 * 1024),
    maxResultChars: positiveInteger("CONTEXT7_MAX_RESULT_CHARS", 16_000),
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  };
}
