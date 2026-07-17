# perfscale MCP servers

Model Context Protocol servers for [perfscale](https://github.com/Perfscale/perfscale):

| Package | Server | Use case |
|---|---|---|
| [`@perfscale/mcp`](packages/perfscale-mcp) | `perfscale-mcp` | Local: run k6/locust/native load tests, lint and manage test/config YAML via the OSS `perfscale` CLI |
| [`@perfscale/controlplane-mcp`](packages/controlplane-mcp) | `perfscale-controlplane-mcp` | Cloud: machines, tests, runs, metrics, and audit data from [perfscale.su](https://perfscale.su) / [perfscale.ru](https://perfscale.ru) |

## Quick start

### OSS (local)

Requires the `perfscale` CLI on PATH (or `PERFSCALE_BIN`).

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

Tools: `run_test`, `lint`, `get_schema`, `parse_summary`, `list_actions`,
`list_configs`, `read_config`, `write_test`, `write_config`, `update_config`,
`remove_config`.

### Controlplane (cloud)

Create an API token in the dashboard (Settings → API Tokens; Scale plan: 1 per
user, Enterprise: 5 per user), then:

```json
{
  "mcpServers": {
    "perfscale-cloud": {
      "command": "npx",
      "args": ["-y", "@perfscale/controlplane-mcp"],
      "env": {
        "PERFSCALE_API_URL": "https://perfscale.su",
        "PERFSCALE_API_TOKEN": "psk_..."
      }
    }
  }
}
```

Tools: `whoami`, `limits`, `usage`, `list_machines`, `get_machine`,
`list_tests`, `get_test`, `write_test`, `list_configs`, `write_config`,
`list_runs`, `get_run`, `get_run_logs`, `runs_by_machine`, `run_test`,
`metrics_catalog`, `query_metrics`, `get_otel_timeseries`, `list_dashboards`,
`list_git_repos`, `sync_git_repo`, `list_env_vars` (values masked),
`audit_log`.

Every tool call is metered against the workspace's monthly AI tool-call
budget — `usage` shows where you stand, `limits` shows the plan.

#### Composite mode (workspace MCP servers)

By default the server also aggregates the **remote MCP servers attached to
your workspace** (dashboard → Settings → AI → MCP Servers): their tools
appear next to the core ones, prefixed with the server's name (`grafana` →
`grafana_search_dashboards`), and calls are proxied through. Only remote
transports are supported (streamable HTTP, SSE fallback) — never local
commands. Resolving the attached servers requires an **admin** token: header
values are secrets, so a regular member's token gets the core tools only. A
remote that is down is skipped with a warning; the core surface always
works. Set `PERFSCALE_MCP_COMPOSITE=off` to force the plain core server.

## Development

```bash
pnpm install
pnpm test        # vitest across all packages
pnpm build       # tsc -b per package
```

## Releasing

Bump the version in the package's `package.json`, then tag and push:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

CI publishes to npm (`release.yml`); packages whose version is already on
the registry are skipped, so packages version independently. Requires the
`NPM_TOKEN` repo secret.
