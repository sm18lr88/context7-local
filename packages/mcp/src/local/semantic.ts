import { openDatabase, type DatabaseConnection } from "@neuledge/context";
import { resolve } from "node:path";
import type { DocumentationMatch, DocumentationSearchResult } from "./retrieval.js";
import type { LibraryManifest, LocalContext7Config } from "./types.js";

interface OllamaEmbedResponse {
  model?: unknown;
  embeddings?: unknown;
}

interface CachedVector {
  chunk_id: number;
  vector: Uint8Array;
}

let unavailableUntil = 0;

function semanticDatabasePath(databasePath: string): string {
  return resolve(databasePath.replace(/\.db$/i, ".semantic.db"));
}

function assertLoopback(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const allowed = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  if (!allowed.has(url.hostname.toLowerCase())) {
    throw new Error("Local embeddings endpoint must use a loopback host");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Local embeddings endpoint must use HTTP or HTTPS");
  }
  return url;
}

function openSemanticCache(
  databasePath: string,
  manifest: LibraryManifest,
  model: string
): DatabaseConnection {
  const db = openDatabase(semanticDatabasePath(databasePath));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL
    );
  `);
  const commit = (
    db.prepare("SELECT value FROM semantic_meta WHERE key = 'commit'").get() as
      | { value: string }
      | undefined
  )?.value;
  const cachedModel = (
    db.prepare("SELECT value FROM semantic_meta WHERE key = 'model'").get() as
      | { value: string }
      | undefined
  )?.value;
  if ((commit && commit !== manifest.commitSha) || (cachedModel && cachedModel !== model)) {
    db.exec("DELETE FROM chunk_embeddings; DELETE FROM semantic_meta;");
  }
  const setMeta = db.prepare(
    "INSERT INTO semantic_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  setMeta.run("commit", manifest.commitSha);
  setMeta.run("model", model);
  setMeta.run("library_id", manifest.id);
  return db;
}

function vectorBuffer(values: number[]): Buffer {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function bufferVector(value: Uint8Array): number[] {
  const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const vector: number[] = [];
  for (let offset = 0; offset < buffer.length; offset += 4) vector.push(buffer.readFloatLE(offset));
  return vector;
}

function validVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 4_096 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

async function embed(
  input: string[],
  model: string,
  baseUrl: string,
  timeoutMs: number
): Promise<number[][]> {
  const endpoint = new URL("/api/embed", assertLoopback(baseUrl));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input, truncate: true, keep_alive: "15m" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Local embedding endpoint returned HTTP ${response.status}`);
  const body = (await response.json()) as OllamaEmbedResponse;
  if (!Array.isArray(body.embeddings) || !body.embeddings.every(validVector)) {
    throw new Error("Local embedding endpoint returned invalid vectors");
  }
  const vectors = body.embeddings as number[][];
  if (vectors.length !== input.length) throw new Error("Local embedding result count mismatch");
  const dimensions = vectors[0]?.length;
  if (!dimensions || vectors.some((vector) => vector.length !== dimensions)) {
    throw new Error("Local embedding dimensions are inconsistent");
  }
  return vectors;
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

function normalize(value: number, min: number, max: number): number {
  return max === min ? 1 : (value - min) / (max - min);
}

/**
 * Rerank a bounded lexical candidate set with a strictly local Ollama model.
 * Document embeddings are commit/model-keyed derived data and can be deleted
 * safely. Any endpoint or cache failure returns the lexical ordering intact.
 */
export async function rerankWithLocalEmbeddings(
  databasePath: string,
  manifest: LibraryManifest,
  query: string,
  result: DocumentationSearchResult,
  config: LocalContext7Config
): Promise<DocumentationSearchResult> {
  const model = config.embeddingModel;
  const baseUrl = config.embeddingBaseUrl;
  if (!model || !baseUrl || result.matches.length < 2 || Date.now() < unavailableUntil)
    return result;

  const candidates = result.matches.slice(0, Math.max(2, config.embeddingCandidates ?? 24));
  let db: DatabaseConnection | undefined;
  try {
    db = openSemanticCache(databasePath, manifest, model);
    const ids = candidates.map((match) => match.id);
    const placeholders = ids.map(() => "?").join(",");
    const cached = db
      .prepare(`SELECT chunk_id, vector FROM chunk_embeddings WHERE chunk_id IN (${placeholders})`)
      .all(...ids) as CachedVector[];
    const vectors = new Map(cached.map((row) => [row.chunk_id, bufferVector(row.vector)]));
    const missing = candidates.filter((candidate) => !vectors.has(candidate.id));
    const inputs = [
      query.slice(0, 4_000),
      ...missing.map(
        (match) => `${match.docTitle}\n${match.sectionTitle}\n${match.content.slice(0, 6_000)}`
      ),
    ];
    const generated = await embed(inputs, model, baseUrl, config.embeddingTimeoutMs ?? 45_000);
    const queryVector = generated[0]!;
    const insert = db.prepare(
      "INSERT OR REPLACE INTO chunk_embeddings(chunk_id, dimensions, vector) VALUES (?, ?, ?)"
    );
    const save = db.transaction(() => {
      missing.forEach((match, index) => {
        const vector = generated[index + 1]!;
        vectors.set(match.id, vector);
        insert.run(match.id, vector.length, vectorBuffer(vector));
      });
    });
    save();

    const lexicalScores = candidates.map((match) => match.score);
    const semanticScores = candidates.map((match) =>
      cosine(queryVector, vectors.get(match.id) ?? [])
    );
    const lexicalMin = Math.min(...lexicalScores);
    const lexicalMax = Math.max(...lexicalScores);
    const semanticMin = Math.min(...semanticScores);
    const semanticMax = Math.max(...semanticScores);
    const matches: DocumentationMatch[] = candidates
      .map((match, index) => ({
        ...match,
        score:
          normalize(match.score, lexicalMin, lexicalMax) * 0.65 +
          normalize(semanticScores[index] ?? -1, semanticMin, semanticMax) * 0.35,
      }))
      .sort((left, right) => right.score - left.score || left.id - right.id);
    return { ...result, matches, retrievalMode: "hybrid-local", semanticModel: model };
  } catch (error) {
    unavailableUntil = Date.now() + 5 * 60 * 1_000;
    console.error(
      `[Context7 Local] Semantic reranking unavailable; using fused lexical results: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return result;
  } finally {
    db?.close();
  }
}
