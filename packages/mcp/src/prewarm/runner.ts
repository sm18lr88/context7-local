import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseLibraryId } from "../local/library-id.js";
import { LocalContext7Service } from "../local/service.js";
import type { DiscoveredLibrary, LocalContext7Config } from "../local/types.js";
import type {
  PopularLibrary,
  PopularLibraryCatalog,
  PrewarmProgress,
  PrewarmResultEvent,
} from "./types.js";

interface RunOptions {
  concurrency: number;
  retryFailed: boolean;
  onProgress?: (progress: PrewarmProgress, event?: PrewarmResultEvent) => void;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

async function readEvents(path: string): Promise<Map<string, PrewarmResultEvent>> {
  const results = new Map<string, PrewarmResultEvent>();
  try {
    const content = await readFile(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Partial<PrewarmResultEvent>;
        if (event.schemaVersion === 1 && event.libraryId && event.status) {
          results.set(event.libraryId.toLowerCase(), event as PrewarmResultEvent);
        }
      } catch {
        // A final partial line can remain after a forced process termination.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return results;
}

async function writeProgress(path: string, progress: PrewarmProgress): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  await rm(path, { force: true });
  await rename(temporary, path);
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = Number.parseInt(await readFile(path, "utf8"), 10);
    if (Number.isSafeInteger(existing) && existing > 0 && (await processExists(existing))) {
      throw new Error(`Prewarm job is already running as PID ${existing}`);
    }
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && error instanceof Error) throw error;
  }
  const handle = await open(path, "wx");
  await handle.writeFile(`${process.pid}\n`, "utf8");
  await handle.close();
  return async () => rm(path, { force: true });
}

function discoveredLibrary(library: PopularLibrary): DiscoveredLibrary {
  const ref = parseLibraryId(library.libraryId);
  if (ref.version) throw new Error(`Prewarm catalog cannot contain versioned ID ${ref.id}`);
  return {
    ref,
    title: library.title,
    description: library.description,
    stars: library.stars,
    defaultBranch: library.defaultBranch,
  };
}

export class PopularLibraryPrewarmer {
  private stopRequested = false;

  constructor(private readonly config: LocalContext7Config) {}

  requestStop(): void {
    this.stopRequested = true;
  }

  async run(catalog: PopularLibraryCatalog, options: RunOptions): Promise<PrewarmProgress> {
    if (
      !Number.isSafeInteger(options.concurrency) ||
      options.concurrency < 1 ||
      options.concurrency > 8
    ) {
      throw new Error("Prewarm concurrency must be an integer between 1 and 8");
    }
    const prewarmDir = join(this.config.storageDir, "prewarm");
    const eventsPath = join(prewarmDir, "top-1000.results.jsonl");
    const progressPath = join(prewarmDir, "top-1000.progress.json");
    const releaseLock = await acquireLock(join(prewarmDir, "top-1000.lock"));
    const service = new LocalContext7Service(this.config);
    const results = await readEvents(eventsPath);
    const startedAt = new Date().toISOString();
    let nextIndex = 0;
    let active = 0;
    let lastLibraryId: string | undefined;
    let writeQueue = Promise.resolve();

    const counts = (): { succeeded: number; failed: number } => {
      let succeeded = 0;
      let failed = 0;
      for (const event of results.values()) {
        if (event.status === "succeeded") succeeded += 1;
        else failed += 1;
      }
      return { succeeded, failed };
    };

    const snapshot = (status: PrewarmProgress["status"] = "running"): PrewarmProgress => {
      const { succeeded, failed } = counts();
      return {
        schemaVersion: 1,
        status,
        pid: process.pid,
        startedAt,
        updatedAt: new Date().toISOString(),
        catalogGeneratedAt: catalog.generatedAt,
        targetSuccessful: catalog.targetSuccessful,
        candidateCount: catalog.libraries.length,
        concurrency: options.concurrency,
        succeeded,
        failed,
        remaining: Math.max(0, catalog.targetSuccessful - succeeded),
        active,
        lastLibraryId,
      };
    };

    const record = async (event: PrewarmResultEvent): Promise<void> => {
      results.set(event.libraryId.toLowerCase(), event);
      lastLibraryId = event.libraryId;
      writeQueue = writeQueue.then(async () => {
        await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
        const progress = snapshot();
        await writeProgress(progressPath, progress);
        options.onProgress?.(progress, event);
      });
      await writeQueue;
    };

    const nextLibrary = (): PopularLibrary | undefined => {
      if (this.stopRequested || counts().succeeded + active >= catalog.targetSuccessful)
        return undefined;
      while (nextIndex < catalog.libraries.length) {
        const library = catalog.libraries[nextIndex++];
        if (!library) continue;
        const prior = results.get(library.libraryId.toLowerCase());
        if (prior?.status === "succeeded") continue;
        if (prior?.status === "failed" && !options.retryFailed) continue;
        return library;
      }
      return undefined;
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        const library = nextLibrary();
        if (!library) return;
        active += 1;
        const began = Date.now();
        try {
          const ensured = await service.ensure(discoveredLibrary(library));
          await record({
            schemaVersion: 1,
            libraryId: library.libraryId,
            rank: library.rank,
            status: "succeeded",
            attemptedAt: new Date().toISOString(),
            elapsedMs: Date.now() - began,
            disposition: ensured.disposition,
            commitSha: ensured.manifest.commitSha,
            documentFiles: ensured.manifest.documentFiles,
            sectionCount: ensured.manifest.sectionCount,
            totalBytes: ensured.manifest.totalBytes,
          });
        } catch (error) {
          await record({
            schemaVersion: 1,
            libraryId: library.libraryId,
            rank: library.rank,
            status: "failed",
            attemptedAt: new Date().toISOString(),
            elapsedMs: Date.now() - began,
            error: errorMessage(error),
          });
        } finally {
          active -= 1;
        }
      }
    };

    await mkdir(prewarmDir, { recursive: true });
    await writeProgress(progressPath, snapshot());
    try {
      await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
      await writeQueue;
      const current = counts();
      const status: PrewarmProgress["status"] =
        current.succeeded >= catalog.targetSuccessful
          ? "completed"
          : this.stopRequested
            ? "stopped"
            : "exhausted";
      const finalProgress = snapshot(status);
      await writeProgress(progressPath, finalProgress);
      options.onProgress?.(finalProgress);
      return finalProgress;
    } finally {
      await releaseLock();
    }
  }
}

export { readEvents };
