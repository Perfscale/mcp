# @perfscale/mcp

MCP server for the [perfscale](https://github.com/Perfscale/perfscale) OSS CLI.
Lets AI agents (Claude Code, Claude Desktop, any MCP client) run k6, locust,
and native load tests locally, read back structured metrics, and author
test/config YAML with schema-validated writes — no shell access required.

## Requirements

- Node.js 20+
- The `perfscale` binary on `PATH` ([install](https://perfscale.su/docs/oss/getting-started)),
  or point `PERFSCALE_BIN` at it

## Setup

Claude Code:

```sh
claude mcp add perfscale -- npx -y @perfscale/mcp
```

Claude Desktop / other MCP clients:

```json
{
  "mcpServers": {
    "perfscale": {
      "command": "npx",
      "args": ["-y", "@perfscale/mcp"]
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `run_test` | Run a k6/locust/native test (`perfscale run`), return exit code + parsed summary (avg/p90/p95/p99 ms, error rate, RPS) |
| `lint` | Validate YAML files, including typo and action-ID checks with did-you-mean hints |
| `get_schema` | JSON Schema for `test` or `config` YAML — the authoring contract |
| `parse_summary` | Parse raw k6-compatible output into structured metrics |
| `list_actions` | Catalog of native `std/*` step actions |
| `list_configs` | Recursively list YAML files in a directory, classified test/config |
| `read_config` | Read one YAML file with its detected kind |
| `write_test` | Create/overwrite a test definition, then lint it against the test schema |
| `write_config` | Create/overwrite a run config, then lint it against the config schema |
| `update_config` | Overwrite an existing file only (fails when absent), then lint |
| `remove_config` | Delete a test/config YAML file |

Every write is linted immediately — schema violations come back in the same
tool result, so invalid YAML never silently lands on disk.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PERFSCALE_BIN` | `perfscale` | Path to the perfscale binary |

## Example

Ask your agent:

> Write a native test that GETs https://example.com with 10 VUs for 30s,
> run it, and tell me the p95.

The agent calls `get_schema` → `write_test` (auto-linted) → `write_config` →
`run_test`, and reads `p95_ms` from the structured summary.

## Notes

- `get_schema` needs a perfscale build with the `schema` subcommand
  (`perfscale self-update` if you see an error mentioning it).
- For the hosted platform (machines, runs, dashboards on perfscale.su/.ru)
  use [`@perfscale/controlplane-mcp`](https://www.npmjs.com/package/@perfscale/controlplane-mcp).

## Links

- [Docs](https://perfscale.su/docs/oss/mcp)
- [perfscale CLI](https://github.com/Perfscale/perfscale)
- [Source](https://github.com/Perfscale/mcp)

## License

Apache-2.0
