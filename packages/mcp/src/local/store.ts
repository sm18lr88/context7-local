import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { libraryStorageKey } from "./library-id.js";
import type { LibraryManifest, LibraryRef, LocalContext7Config } from "./types.js";

function isManifest(value: unknown): value is LibraryManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LibraryManifest>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.id === "string" &&
    typeof candidate.commitSha === "string" &&
    typeof candidate.indexedAt === "string" &&
    typeof candidate.checkedAt === "string"
  );
}

export class LocalLibraryStore {
  readonly librariesDir: string;
  readonly temporaryDir: string;
  readonly locksDir: string;

  constructor(private readonly config: LocalContext7Config) {
    this.librariesDir = resolve(config.storageDir, "libraries");
    this.temporaryDir = resolve(config.storageDir, "tmp");
    this.locksDir = resolve(config.storageDir, "locks");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.librariesDir, { recursive: true }),
      mkdir(this.temporaryDir, { recursive: true }),
      mkdir(this.locksDir, { recursive: true }),
    ]);
  }

  async acquireBuildLock(
    ref: Pick<LibraryRef, "id">,
    timeoutMs: number
  ): Promise<() => Promise<void>> {
    await this.initialize();
    const path = join(this.locksDir, `${libraryStorageKey(ref.id)}.lock`);
    const deadline = Date.now() + Math.max(timeoutMs, 10 * 60 * 1_000);
    for (;;) {
      try {
        const handle = await open(path, "wx");
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, libraryId: ref.id, acquiredAt: new Date().toISOString() })}\n`,
          "utf8"
        );
        await handle.close();
        return async () => rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      let stale = false;
      try {
        const lock = JSON.parse(await readFile(path, "utf8")) as {
          pid?: unknown;
          acquiredAt?: unknown;
        };
        const pid = typeof lock.pid === "number" ? lock.pid : 0;
        const acquiredAt = typeof lock.acquiredAt === "string" ? Date.parse(lock.acquiredAt) : 0;
        let processAlive = false;
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            processAlive = true;
          } catch (error) {
            processAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
          }
        }
        stale =
          !processAlive ||
          !Number.isFinite(acquiredAt) ||
          Date.now() - acquiredAt > 60 * 60 * 1_000;
      } catch {
        stale = true;
      }
      if (stale) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for local index lock for ${ref.id}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }

  databasePath(ref: Pick<LibraryRef, "id">): string {
    return join(this.librariesDir, `${libraryStorageKey(ref.id)}.db`);
  }

  manifestPath(ref: Pick<LibraryRef, "id">): string {
    return join(this.librariesDir, `${libraryStorageKey(ref.id)}.json`);
  }

  temporaryDatabasePath(ref: Pick<LibraryRef, "id">): string {
    return join(this.temporaryDir, `${libraryStorageKey(ref.id)}-${process.pid}-${Date.now()}.db`);
  }

  async load(ref: Pick<LibraryRef, "id">): Promise<LibraryManifest | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.manifestPath(ref), "utf8"));
      if (!isManifest(parsed) || parsed.id.toLowerCase() !== ref.id.toLowerCase()) return undefined;
      if (!(await stat(this.databasePath(ref))).isFile()) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<LibraryManifest[]> {
    await this.initialize();
    const entries = await readdir(this.librariesDir, { withFileTypes: true });
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            const parsed: unknown = JSON.parse(
              await readFile(join(this.librariesDir, entry.name), "utf8")
            );
            return isManifest(parsed) ? parsed : undefined;
          } catch {
            return undefined;
          }
        })
    );
    return manifests.filter((value): value is LibraryManifest => value !== undefined);
  }

  async saveManifest(manifest: LibraryManifest): Promise<void> {
    const target = this.manifestPath(manifest);
    const operationId = `${process.pid}.${randomUUID()}`;
    const temporary = `${target}.${operationId}.tmp`;
    const backup = `${target}.${operationId}.bak`;
    let hadExisting = false;
    let published = false;
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      try {
        await rename(target, backup);
        hadExisting = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(temporary, target);
      published = true;
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      if (hadExisting) await rename(backup, target).catch(() => undefined);
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (published) await rm(backup, { force: true }).catch(() => undefined);
    }
  }

  async publish(temporaryDatabase: string, manifest: LibraryManifest): Promise<string> {
    const target = this.databasePath(manifest);
    const backup = `${target}.${process.pid}.${randomUUID()}.bak`;
    let hadExisting = false;
    let published = false;

    try {
      try {
        await rename(target, backup);
        hadExisting = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }

      await rename(temporaryDatabase, target);
      await this.saveManifest(manifest);
      published = true;
      return target;
    } catch (error) {
      await rm(target, { force: true });
      if (hadExisting) await rename(backup, target).catch(() => undefined);
      throw error;
    } finally {
      await rm(temporaryDatabase, { force: true }).catch(() => undefined);
      if (published) await rm(backup, { force: true }).catch(() => undefined);
    }
  }
}
