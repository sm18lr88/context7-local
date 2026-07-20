# Context7 Local

A local-first, Context7-compatible MCP server for current library documentation.

It keeps documentation indexes on your machine, builds missing libraries automatically, and refreshes stale libraries from their public GitHub repositories. It does not use the hosted Context7 API, so there are no Context7 API keys, quotas, or rate limits.

## What it does

- Supports the standard `resolve-library-id` and `query-docs` workflow.
- Discovers and indexes a missing public GitHub library during the first request.
- Stores each index with the exact source commit and refreshes it every 24 hours by default.
- Publishes rebuilt indexes atomically so existing documentation remains available during updates.
- Uses local SQLite full-text search, rank fusion, and optional local Ollama embeddings.
- Includes a catalog for prebuilding 1,000 commonly queried libraries.
- Sends no Context7 telemetry and has no hosted authentication path.

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

Progress and evaluation history are kept inside the index directory, so interrupted jobs can resume and retrieval changes can be compared over time.

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

All limits and architecture details are documented in [packages/mcp/README.md](packages/mcp/README.md) and [packages/mcp/LOCAL_ARCHITECTURE.md](packages/mcp/LOCAL_ARCHITECTURE.md).

## Security

Repository documentation is treated as untrusted input. Agent-instruction files are excluded, file and response sizes are bounded, Git hooks and filters are disabled, and returned source links are pinned to the indexed commit.

HTTP transport binds to loopback by default. Use an authenticated reverse proxy or SSH tunnel if another machine needs access.

## License

MIT. This project is based on [Upstash Context7](https://github.com/upstash/context7).
