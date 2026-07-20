# Context7 Local

A complete local-first, Context7-compatible MCP server for current library documentation.

Unlike the upstream open-source MCP, this fork includes the discovery, ingestion, storage, freshness, and retrieval pipeline needed to serve documentation locally. Missing libraries build automatically during the first request. There is no hosted Context7 API, API key, quota, telemetry, authentication, or remote inference.

## What this version adds

### Automatic local indexing

- Resolves explicit GitHub IDs and library names through npm, PyPI, crates.io, and GitHub.
- Builds a missing library before returning the first query; concurrent requests share one build.
- Stores SQLite FTS5 indexes and manifests under a cross-process per-library lock.
- Records the exact repository commit, parser version, index time, freshness time, and document counts.
- Prioritizes documentation, API references, and guides while removing duplicates and repository agent rules.

### Better retrieval

- Decomposes each task into keyword, intersection, identifier, and quoted-phrase searches.
- Combines BM25 results with reciprocal-rank fusion, API/title boosts, coverage, and document diversity.
- Uses dynamic context budgets instead of returning a fixed block of loosely related text.
- Optionally reranks a bounded candidate set with local Ollama embeddings and caches vectors by commit and model.
- Fails open to lexical search when Ollama is unavailable.
- Prefers unseen evidence during repeated searches in the same MCP session.
- Supports concise search followed by exact read, adjacent-section expansion, literal grep, and the original Context7-compatible query flow.
- Uses commit-bound result keys and refuses reads after the underlying index has moved to a different commit.

### Freshness and scale

- Checks upstream commits every 24 hours by default and refreshes changed libraries atomically.
- Rebuilds parser-obsolete indexes automatically before serving them.
- Includes resumable prewarm and migration jobs with durable progress files.
- Generates a popularity-based catalog for prebuilding 1,000 commonly queried libraries at their latest upstream commits.
- Exposes freshness, provenance, migration, prewarm, and semantic-cache state through MCP tools.

### Local security

- Treats repository documentation as untrusted input and marks it as data, not MCP instructions.
- Excludes agent-instruction files, avoids symlinks, and bounds file reads, index size, queries, and responses.
- Disables Git hooks, credentials, LFS filters, filesystem monitoring, and unsafe file/ext protocols while indexing.
- Restricts external discovery to package registries and public GitHub HTTPS.
- Uses parameterized literal grep instead of executing user regular expressions.
- Binds HTTP transport to loopback and rejects unapproved browser origins.
- Exact-pins direct dependencies and keeps registry integrity hashes in the lockfile.

### Measured retrieval

The included regression harness compares the original single-query BM25 path with fused retrieval using commit-pinned scenarios. It records MRR, recall, and latency history so retrieval changes can be measured instead of judged by examples alone.

On Windows, indexes are stored in `C:\Apps\System\Context7\index` by default. On other platforms, the default is `~/.cache/context7-local`.

## Requirements

- Node.js 22.12 or newer
- pnpm
- Git
- Optional: Ollama with `qwen3-embedding:0.6b` for local semantic reranking

## Build

```powershell
git clone https://github.com/sm18lr88/context7-local.git
cd context7-local
pnpm install --frozen-lockfile
pnpm --filter @upstash/context7-mcp build
```

Run the MCP server over stdio:

```powershell
node packages/mcp/dist/index.js --transport stdio
```

## MCP configuration

Replace the path below if you cloned the repository somewhere else.

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.context7]
command = "node"
args = [
  "D:\\Apps\\LLM\\context7-local\\packages\\mcp\\dist\\index.js",
  "--transport",
  "stdio"
]

[mcp_servers.context7.env]
CONTEXT7_LOCAL_STORAGE_DIR = "C:\\Apps\\System\\Context7\\index"
```

VS Code, in the user or workspace `mcp.json`:

```json
{
  "servers": {
    "context7": {
      "type": "stdio",
      "command": "node",
      "args": [
        "D:\\Apps\\LLM\\context7-local\\packages\\mcp\\dist\\index.js",
        "--transport",
        "stdio"
      ],
      "env": {
        "CONTEXT7_LOCAL_STORAGE_DIR": "C:\\Apps\\System\\Context7\\index"
      }
    }
  }
}
```

OpenCode, in `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "context7": {
      "type": "local",
      "command": [
        "node",
        "D:\\Apps\\LLM\\context7-local\\packages\\mcp\\dist\\index.js",
        "--transport",
        "stdio"
      ],
      "environment": {
        "CONTEXT7_LOCAL_STORAGE_DIR": "C:\\Apps\\System\\Context7\\index"
      },
      "enabled": true
    }
  }
}
```

Restart or reload clients that were already running when their configuration changed.

## Tools

- `resolve-library-id`: finds a Context7-compatible library ID.
- `query-docs`: returns answer-ready documentation and builds the library first when needed.
- `search-docs`: returns ranked previews with commit-bound result keys.
- `read-docs`: reads a selected result with adjacent sections.
- `grep-docs`: searches locally for an exact API name, option, or error.
- `local-index-status`: reports freshness, migration, prewarm, and semantic-cache state.
- `refresh-local-index`: refreshes a library to its current upstream commit.

## Index maintenance

Prebuild the common-library catalog:

```powershell
node packages/mcp/dist/prewarm.js --target 1000 --candidates 1600 --concurrency 2
```

Upgrade existing indexes after a parser change:

```powershell
node packages/mcp/dist/migrate-index.js --concurrency 2
```

Run the retrieval regression suite:

```powershell
node packages/mcp/dist/evaluate-retrieval.js
```

Progress and evaluation history are kept inside the index directory, so interrupted jobs resume and retrieval changes remain comparable over time.

## Configuration

The most useful environment variables are:

| Variable                       | Default                       | Purpose                                            |
| ------------------------------ | ----------------------------- | -------------------------------------------------- |
| `CONTEXT7_LOCAL_STORAGE_DIR`   | Platform-specific local cache | Index location                                     |
| `CONTEXT7_REFRESH_INTERVAL_MS` | `86400000`                    | Upstream freshness-check interval                  |
| `CONTEXT7_LOCAL_EMBEDDINGS`    | Enabled                       | Set to `off` for lexical retrieval only            |
| `CONTEXT7_EMBEDDING_MODEL`     | `qwen3-embedding:0.6b`        | Local Ollama embedding model                       |
| `CONTEXT7_EMBEDDING_BASE_URL`  | `http://127.0.0.1:11434`      | Local Ollama endpoint                              |
| `GITHUB_TOKEN` or `GH_TOKEN`   | Unset                         | Optional GitHub search and metadata authentication |

All limits, storage details, design influences, and architecture invariants are documented in [packages/mcp/README.md](packages/mcp/README.md) and [packages/mcp/LOCAL_ARCHITECTURE.md](packages/mcp/LOCAL_ARCHITECTURE.md).

## License

MIT. This project is based on [Upstash Context7](https://github.com/upstash/context7).
