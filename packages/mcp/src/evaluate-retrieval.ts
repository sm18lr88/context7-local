import { openDatabase } from "@neuledge/context";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalContext7Config } from "./local/config.js";
import { parseLibraryId } from "./local/library-id.js";
import { searchLocalDocumentation } from "./local/retrieval.js";
import { LocalLibraryStore } from "./local/store.js";

interface Scenario {
  libraryId: string;
  query: string;
  relevantPath: string;
}

interface ScenarioResult extends Scenario {
  legacyRank: number;
  fusedRank: number;
  legacyMs: number;
  fusedMs: number;
}

function ftsQuery(topic: string): string {
  const terms = [
    ...new Set(
      (topic.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((term) => term.length > 1)
    ),
  ].slice(0, 16);
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function legacyPaths(databasePath: string, query: string): string[] {
  const db = openDatabase(databasePath, { readonly: true });
  try {
    return (
      db
        .prepare(
          `SELECT c.doc_path AS path
           FROM chunks_fts
           JOIN chunks c ON chunks_fts.rowid = c.id
           WHERE chunks_fts MATCH ?
           ORDER BY bm25(chunks_fts, 5.0, 10.0, 1.0)
           LIMIT 10`
        )
        .all(ftsQuery(query)) as Array<{ path: string }>
    ).map((row) => row.path);
  } finally {
    db.close();
  }
}

function rank(paths: string[], relevantPath: string): number {
  const expected = relevantPath.replaceAll("\\", "/").toLowerCase();
  const index = paths.findIndex((path) =>
    path.replaceAll("\\", "/").toLowerCase().includes(expected)
  );
  return index + 1;
}

function metric(results: ScenarioResult[], key: "legacyRank" | "fusedRank") {
  const reciprocalRank =
    results.reduce((sum, result) => sum + (result[key] > 0 ? 1 / result[key] : 0), 0) /
    results.length;
  const recallAt5 =
    results.filter((result) => result[key] > 0 && result[key] <= 5).length / results.length;
  return { mrrAt10: reciprocalRank, recallAt5 };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const scenarioPath = resolve(here, "..", "evaluation", "retrieval-scenarios.json");
  const scenarios = JSON.parse(await readFile(scenarioPath, "utf8")) as Scenario[];
  const config = loadLocalContext7Config();
  const store = new LocalLibraryStore(config);
  await store.initialize();
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const ref = parseLibraryId(scenario.libraryId);
    const manifest = await store.load(ref);
    if (!manifest) continue;
    const databasePath = store.databasePath(ref);

    const legacyStart = performance.now();
    const legacy = legacyPaths(databasePath, scenario.query);
    const legacyMs = performance.now() - legacyStart;
    const fusedStart = performance.now();
    const fused = searchLocalDocumentation(databasePath, scenario.query, {
      limit: 10,
      maxTokens: 5_000,
    }).matches.map((match) => match.docPath);
    const fusedMs = performance.now() - fusedStart;
    results.push({
      ...scenario,
      legacyRank: rank(legacy, scenario.relevantPath),
      fusedRank: rank(fused, scenario.relevantPath),
      legacyMs,
      fusedMs,
    });
  }

  if (results.length === 0) throw new Error("None of the evaluation libraries are indexed locally");
  const report = {
    evaluatedAt: new Date().toISOString(),
    corpusCommitPolicy: "Each scenario uses its locally recorded immutable repository commit",
    scenariosAvailable: scenarios.length,
    scenariosEvaluated: results.length,
    legacy: {
      ...metric(results, "legacyRank"),
      latencyMs: {
        p50: percentile(
          results.map((result) => result.legacyMs),
          0.5
        ),
        p95: percentile(
          results.map((result) => result.legacyMs),
          0.95
        ),
      },
    },
    fused: {
      ...metric(results, "fusedRank"),
      latencyMs: {
        p50: percentile(
          results.map((result) => result.fusedMs),
          0.5
        ),
        p95: percentile(
          results.map((result) => result.fusedMs),
          0.95
        ),
      },
    },
    results,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const evaluationDir = join(config.storageDir, "evaluations");
  await mkdir(evaluationDir, { recursive: true });
  const timestamp = report.evaluatedAt.replaceAll(":", "-");
  await Promise.all([
    writeFile(join(evaluationDir, "retrieval-latest.json"), serialized, "utf8"),
    writeFile(join(evaluationDir, `retrieval-${timestamp}.json`), serialized, {
      encoding: "utf8",
      flag: "wx",
    }),
  ]);
  console.log(serialized);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
