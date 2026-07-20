import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadLocalContext7Config } from "./local/config.js";
import { LocalContext7Service } from "./local/service.js";

interface MigrationProgress {
  schemaVersion: 1;
  status: "running" | "completed" | "stopped";
  pid: number;
  parserVersion: string;
  startedAt: string;
  updatedAt: string;
  total: number;
  succeeded: number;
  failed: number;
  remaining: number;
  active: number;
  lastLibraryId?: string;
  failures: Array<{ libraryId: string; error: string }>;
}

function concurrencyArgument(args: string[]): number {
  const index = args.indexOf("--concurrency");
  const value = index >= 0 ? Number(args[index + 1]) : 2;
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
    throw new Error("--concurrency must be an integer between 1 and 4");
  }
  return value;
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  try {
    const prior = Number(await readFile(path, "utf8"));
    if (Number.isSafeInteger(prior) && prior > 0) {
      let alive = false;
      try {
        process.kill(prior, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive) throw new Error(`Index migration is already running as PID ${prior}`);
      await rm(path, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(path, "wx");
  await handle.writeFile(`${process.pid}\n`, "utf8");
  await handle.close();
  return async () => rm(path, { force: true });
}

async function writeProgress(path: string, progress: MigrationProgress): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  await rm(path, { force: true });
  await rename(temporary, path);
}

async function main(): Promise<void> {
  const concurrency = concurrencyArgument(process.argv.slice(2));
  const config = loadLocalContext7Config();
  const service = new LocalContext7Service(config);
  const health = await service.indexHealth();
  const parserVersion = String(health.currentParserVersion);
  const manifests = (await service.status()).filter(
    (manifest) => manifest.parserVersion !== parserVersion
  );
  const progressPath = join(config.storageDir, "migration.progress.json");
  const releaseLock = await acquireLock(join(config.storageDir, "migration.lock"));
  const startedAt = new Date().toISOString();
  let nextIndex = 0;
  let active = 0;
  let succeeded = 0;
  let stopped = false;
  let lastLibraryId: string | undefined;
  const failures: MigrationProgress["failures"] = [];
  let writeQueue = Promise.resolve();

  const snapshot = (status: MigrationProgress["status"]): MigrationProgress => ({
    schemaVersion: 1,
    status,
    pid: process.pid,
    parserVersion,
    startedAt,
    updatedAt: new Date().toISOString(),
    total: manifests.length,
    succeeded,
    failed: failures.length,
    remaining: Math.max(0, manifests.length - succeeded - failures.length),
    active,
    lastLibraryId,
    failures: failures.slice(-100),
  });

  const persist = async (): Promise<void> => {
    writeQueue = writeQueue.then(() => writeProgress(progressPath, snapshot("running")));
    await writeQueue;
  };

  process.on("SIGINT", () => (stopped = true));
  process.on("SIGTERM", () => (stopped = true));
  await persist();
  try {
    const worker = async (): Promise<void> => {
      while (!stopped) {
        const manifest = manifests[nextIndex++];
        if (!manifest) return;
        active += 1;
        lastLibraryId = manifest.id;
        try {
          await service.refresh(manifest.id);
          succeeded += 1;
        } catch (error) {
          failures.push({
            libraryId: manifest.id,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
          });
        } finally {
          active -= 1;
          await persist();
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    await writeQueue;
    const final = snapshot(stopped ? "stopped" : "completed");
    await writeProgress(progressPath, final);
    process.stdout.write(`${JSON.stringify(final)}\n`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
