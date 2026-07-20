import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackage, initDatabase } from "@neuledge/context";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { queryLocalDocumentation } from "../src/local/retrieval.js";
import { LocalLibraryStore } from "../src/local/store.js";
import type { LibraryManifest, LocalContext7Config } from "../src/local/types.js";

const temporaryDirectories: string[] = [];

beforeAll(async () => {
  await initDatabase();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture() {
  const storageDir = await mkdtemp(join(tmpdir(), "context7-local-index-"));
  temporaryDirectories.push(storageDir);
  const config: LocalContext7Config = {
    storageDir,
    refreshIntervalMs: 60_000,
    gitTimeoutMs: 30_000,
    fetchTimeoutMs: 5_000,
    maxFiles: 100,
    maxFileBytes: 100_000,
    maxIndexBytes: 1_000_000,
    maxResultChars: 10_000,
  };
  const store = new LocalLibraryStore(config);
  await store.initialize();
  const ref = {
    id: "/example/router",
    owner: "example",
    repo: "router",
    repositoryUrl: "https://github.com/example/router.git",
  };
  const temporaryDatabase = store.temporaryDatabasePath(ref);
  const result = buildPackage(
    temporaryDatabase,
    [
      {
        path: "docs/middleware.md",
        content:
          "# Router\n\n## Authentication middleware\n\nUse `router.beforeEach()` to validate a session before entering protected routes.",
      },
    ],
    {
      name: ref.id,
      version: "main",
      sourceUrl: "https://github.com/example/router",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    }
  );
  const now = new Date().toISOString();
  const manifest: LibraryManifest = {
    schemaVersion: 1,
    parserVersion: "test",
    ...ref,
    title: "Router",
    description: "Test router",
    branch: "main",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    indexedAt: now,
    checkedAt: now,
    documentFiles: 1,
    sectionCount: result.sectionCount,
    totalBytes: 100,
    totalTokens: result.totalTokens,
    rules: [],
    versions: [],
  };
  const databasePath = await store.publish(temporaryDatabase, manifest);
  return { config, store, ref, manifest, databasePath };
}

describe("local SQLite documentation index", () => {
  test("publishes a portable database and returns commit-pinned results", async () => {
    const { config, manifest, databasePath } = await fixture();
    const output = queryLocalDocumentation(
      databasePath,
      manifest,
      "authentication middleware",
      config
    );
    expect(output).toContain("router.beforeEach()");
    expect(output).toContain(manifest.commitSha);
    expect(output).toContain(
      `https://github.com/example/router/blob/${manifest.commitSha}/docs/middleware.md`
    );
  });

  test("updates freshness metadata without replacing the database", async () => {
    const { store, ref, manifest, databasePath } = await fixture();
    const databaseBefore = await readFile(databasePath);
    const checkedAt = new Date(Date.now() + 1_000).toISOString();
    await store.saveManifest({ ...manifest, checkedAt });
    expect((await store.load(ref))?.checkedAt).toBe(checkedAt);
    expect(await readFile(databasePath)).toEqual(databaseBefore);
  });
});
