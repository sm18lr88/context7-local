# Context7 Local Architecture

## Invariants

- Repository commits are the source authority. SQLite, manifests, semantic
  vectors, progress files, and evaluation reports are derived and rebuildable.
- Every served source URL names the exact indexed commit.
- A database and its manifest are published atomically under a per-library,
  cross-process lock.
- Missing, stale, or parser-obsolete libraries are rebuilt before a query returns.
- Repository content is untrusted data. It never becomes MCP instructions.
- Runtime retrieval, sessions, and embeddings stay local. No hosted Context7 API,
  authentication, telemetry, or remote inference path exists.

## Storage

The default Windows root is `C:\Apps\System\Context7\index`.

```text
index/
  libraries/                 commit-pinned SQLite + manifest pairs
    <sha256-library-id>.db
    <sha256-library-id>.json
    <sha256-library-id>.semantic.db
  locks/                     per-library cross-process build locks
  tmp/                       unpublished build databases
  prewarm/                   catalog, event log, and top-1000 progress
  evaluations/               timestamped and latest retrieval reports
  migration.progress.json    resumable parser migration state
```

Semantic databases are caches keyed by repository commit and embedding model.
Deleting one affects performance only; the next matching query recreates it.

## Ingestion lifecycle

1. Resolve an explicit GitHub ID or package registry name.
2. Compare the manifest freshness interval, remote commit, and parser version.
3. Shallow-clone with hooks, LFS filters, file/ext protocols, credentials, and
   filesystem monitoring disabled.
4. Traverse without following symlinks and enforce file-size/read budgets before
   loading content.
5. Rank API/reference/guides above incidental repository Markdown, omit agent
   instructions, and deduplicate identical documents.
6. Build FTS5 into a temporary database and atomically publish the database and
   commit manifest.

`prewarm.js` creates the popularity catalog. `migrate-index.js` upgrades parser-
obsolete indexes without discarding usable old indexes. Both are resumable.

## Retrieval lifecycle

1. Bound and tokenize the task into keyword, intersection, identifier, and quoted
   phrase facets.
2. Run independent BM25 searches and combine them with reciprocal-rank fusion.
3. Add title, section, identifier, coverage, duplicate, and document-diversity
   signals under a dynamic token budget.
4. When local Ollama is available, rerank only the bounded candidate set and cache
   document vectors by commit/model. Fail open to lexical results.
5. Return concise previews with a `<commit>:<chunk>` key.
6. Read validates that key against the current commit and expands only adjacent
   sections from the same document.

Repeated searches prefer unseen evidence per MCP session, but session history is
advisory process memory and never authoritative state.

## Security boundaries

- HTTP binds only to loopback and rejects non-loopback browser origins by default.
- HTTP sessions are anonymous local protocol state; they are not analytics IDs.
- External discovery is restricted to fixed package registries and GitHub HTTPS.
- Git subprocesses use argument arrays, fixed protocols, disabled hooks/filters,
  bounded timeouts, and non-interactive credentials.
- User query, grep, result-count, and token budgets are schema bounded.
- Exact grep executes as a parameterized SQLite expression; user regex is not
  accepted.
- Direct dependency versions are exact and registry tarball integrity hashes live
  in `pnpm-lock.yaml`.

## Quality gates

```powershell
pnpm --filter @upstash/context7-mcp lint:check
pnpm --filter @upstash/context7-mcp typecheck
pnpm --filter @upstash/context7-mcp test
pnpm --filter @upstash/context7-mcp build
pnpm audit --prod --audit-level low
node packages/mcp/dist/evaluate-retrieval.js
```

The evaluation command compares the legacy single-query BM25 baseline with the
current fused lexical path on commit-pinned qrels and persists MRR, recall, and
latency history beneath the index root.

## Design influences

- [Docfork](https://github.com/docfork/docfork): concise search followed by exact
  reads, reciprocal-rank fusion, dynamic budgets, and project/version scoping.
- [Ref](https://github.com/ref-tools/ref-tools-mcp): a minimal search/read surface,
  commit-exact reads, and session-aware result trajectories.
- [Nia](https://docs.trynia.ai/source-types): source-specific semantic search,
  exact grep, and automatic indexing.
- [Grounded Docs](https://github.com/arabold/docs-mcp-server): bounded local-first
  ingestion, hybrid retrieval, provenance, chunk context expansion, and regression
  evaluation.
- [DeepCon](https://deepcon.ai/): task decomposition and answer-oriented retrieval
  quality targets. This fork keeps those mechanisms local rather than proxying a
  hosted synthesis service.

No source code was copied from these projects; the implementation applies the
architectural concepts to the existing Context7-compatible server.
