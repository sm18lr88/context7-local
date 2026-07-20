import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadLocalContext7Config } from "./local/config.js";
import { generatePopularCatalog, writeCatalog } from "./prewarm/catalog.js";
import { PopularLibraryPrewarmer } from "./prewarm/runner.js";
import type { PopularLibraryCatalog, PrewarmProgress } from "./prewarm/types.js";

interface CliOptions {
  target: number;
  candidates: number;
  concurrency: number;
  regenerate: boolean;
  catalogOnly: boolean;
  runOnly: boolean;
  retryFailed: boolean;
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function parseArguments(args: string[]): CliOptions {
  const options: CliOptions = {
    target: 1_000,
    candidates: 1_600,
    concurrency: 2,
    regenerate: false,
    catalogOnly: false,
    runOnly: false,
    retryFailed: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--target") options.target = positiveInteger(args[++index], flag);
    else if (flag === "--candidates") options.candidates = positiveInteger(args[++index], flag);
    else if (flag === "--concurrency") options.concurrency = positiveInteger(args[++index], flag);
    else if (flag === "--regenerate") options.regenerate = true;
    else if (flag === "--catalog-only") options.catalogOnly = true;
    else if (flag === "--run-only") options.runOnly = true;
    else if (flag === "--retry-failed") options.retryFailed = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.catalogOnly && options.runOnly) {
    throw new Error("--catalog-only and --run-only cannot be combined");
  }
  if (options.candidates < options.target) {
    throw new Error("--candidates must be greater than or equal to --target");
  }
  return options;
}

async function loadCatalog(path: string): Promise<PopularLibraryCatalog | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PopularLibraryCatalog>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.libraries)) return undefined;
    return parsed as PopularLibraryCatalog;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function progressLine(progress: PrewarmProgress): string {
  return [
    new Date().toISOString(),
    progress.status,
    `succeeded=${progress.succeeded}/${progress.targetSuccessful}`,
    `failed=${progress.failed}`,
    `remaining=${progress.remaining}`,
    `active=${progress.active}`,
    progress.lastLibraryId ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const config = loadLocalContext7Config();
  const prewarmDir = join(config.storageDir, "prewarm");
  const catalogPath = join(prewarmDir, "top-1000.catalog.json");
  await mkdir(prewarmDir, { recursive: true });

  let catalog = options.regenerate ? undefined : await loadCatalog(catalogPath);
  if (!catalog && !options.runOnly) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
    catalog = await generatePopularCatalog({
      token,
      targetSuccessful: options.target,
      candidateCount: options.candidates,
      onSource: (source, completed, total) => {
        process.stdout.write(
          `${new Date().toISOString()} catalog ${completed}/${total} ${source}\n`
        );
      },
    });
    await writeCatalog(catalogPath, catalog);
    process.stdout.write(
      `${new Date().toISOString()} catalog-ready candidates=${catalog.libraries.length} path=${catalogPath}\n`
    );
  }
  if (!catalog) throw new Error(`No catalog exists at ${catalogPath}`);
  if (options.catalogOnly) return;

  const prewarmer = new PopularLibraryPrewarmer(config);
  process.on("SIGINT", () => prewarmer.requestStop());
  process.on("SIGTERM", () => prewarmer.requestStop());
  const progress = await prewarmer.run(catalog, {
    concurrency: options.concurrency,
    retryFailed: options.retryFailed,
    onProgress: (current) => process.stdout.write(`${progressLine(current)}\n`),
  });
  if (progress.status !== "completed") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
