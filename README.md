# Context7 Local

Context7 Local is a complete local-first, Context7-compatible MCP server for current library documentation.

Unlike the upstream open-source MCP, this fork handles discovery, ingestion, storage, freshness, and retrieval locally. Missing libraries build automatically during the first request. It has no hosted Context7 API, API key, quota, telemetry, authentication, or remote inference.

## Capabilities

### Local indexing

- It resolves explicit GitHub IDs and library names through npm, PyPI, crates.io, and GitHub, then builds missing libraries before returning the first query.
- Concurrent requests share one build.
- Cross-process per-library locks protect SQLite FTS5 indexes and manifests.
- Each index records the exact repository commit, parser version, index time, freshness time, and document counts.
- Indexing prioritizes documentation, API references, and guides, and removes duplicates and repository agent rules.

### Retrieval

- Retrieval splits tasks into keyword, intersection, identifier, and quoted-phrase searches, then combines BM25 with reciprocal-rank fusion, API/title boosts, coverage, and document diversity.
- Dynamic context budgets replace fixed blocks of loosely related text.
- Optional local Ollama embeddings rerank bounded candidates. The server caches vectors by commit and model.
- If Ollama is unavailable, lexical search continues.
- Within one MCP session, repeated searches prefer unseen evidence.
- Tools support concise search followed by exact reads, adjacent-section expansion, literal grep, and the original Context7-compatible query flow.
- Commit-bound result keys prevent reads after the underlying index moves to a different commit.

### Freshness and scale

- By default, it checks upstream commits every 24 hours and atomically refreshes changed libraries.
- It automatically rebuilds parser-obsolete indexes before use.
- Durable progress files make prewarm and migration jobs resumable.
- It generates a popularity-based catalog to prebuild 1,000 common libraries at their latest upstream commits.
- MCP tools expose freshness, provenance, migration, prewarm, and semantic-cache state.

### Local security

- It treats repository documentation as untrusted data, not MCP instructions.
- It excludes agent-instruction files, avoids symlinks, and limits file reads, index size, queries, and responses.
- Indexing disables Git hooks, credentials, LFS filters, filesystem monitoring, and unsafe file/ext protocols.
- External discovery uses only package registries and public GitHub HTTPS.
- Parameterized literal grep never executes user regular expressions.
- HTTP transport binds to loopback and rejects unapproved browser origins.
- The lockfile keeps registry integrity hashes, and direct dependencies use exact versions.

### Measured retrieval

A regression harness uses commit-pinned scenarios to compare fused retrieval with the original single-query BM25 path. It records MRR, recall, and latency history to measure retrieval changes without relying on examples alone.

On Windows, the default index directory is `C:\Apps\System\Context7\index`. On other platforms, it is `~/.cache/context7-local`.

## Requirements

- Node.js 26.x
- pnpm
- Git
- Optional: Ollama with `qwen3-embedding:0.6b` for local semantic reranking

## Build and run

Clone and build the server:

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

If you cloned the repository elsewhere, replace the paths below.

Configure Codex in `~/.codex/config.toml`:

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

Configure VS Code in the user or workspace `mcp.json`:

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

Configure OpenCode in `~/.config/opencode/opencode.json`:

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
      "env": {
        "CONTEXT7_LOCAL_STORAGE_DIR": "C:\\Apps\\System\\Context7\\index"
      },
      "enabled": true
    }
  }
}
```

After the configuration changes for a running client, restart or reload the client.

## MCP tools

- `resolve-library-id` finds a Context7-compatible library ID.
- When necessary, `query-docs` builds the library before returning answer-ready documentation.
- `search-docs` returns ranked previews with commit-bound result keys.
- `read-docs` reads a selected result with adjacent sections.
- `grep-docs` searches locally for an exact API name, option, or error.
- `local-index-status` reports freshness, migration, prewarm, and semantic-cache state.
- `refresh-local-index` refreshes a library to its current upstream commit.

## Index maintenance

Prebuild the common-library catalog:

```powershell
node packages/mcp/dist/prewarm.js --target 1000 --candidates 1600 --concurrency 2
```

After a parser change, upgrade existing indexes:

```powershell
node packages/mcp/dist/migrate-index.js --concurrency 2
```

Run the retrieval regression suite:

```powershell
node packages/mcp/dist/evaluate-retrieval.js
```

Progress and evaluation history remain inside the index directory. This lets interrupted jobs resume and keeps retrieval changes comparable over time.

## Configuration

The most useful environment variables are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXT7_LOCAL_STORAGE_DIR` | Platform-specific local cache | Index location |
| `CONTEXT7_REFRESH_INTERVAL_MS` | `86400000` | Upstream freshness-check interval |
| `CONTEXT7_LOCAL_EMBEDDINGS` | Enabled | Set to `off` for lexical retrieval only |
| `CONTEXT7_EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | Local Ollama embedding model |
| `CONTEXT7_EMBEDDING_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama endpoint |
| `GITHUB_TOKEN` or `GH_TOKEN` | Unset | Optional GitHub search and metadata authentication |

[MCP package details](packages/mcp/README.md) and the [local architecture](packages/mcp/LOCAL_ARCHITECTURE.md) document all limits, storage details, design influences, and architecture invariants.

## License

This MIT-licensed project is based on [Upstash Context7](https://github.com/upstash/context7).
