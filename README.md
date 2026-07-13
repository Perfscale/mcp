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

Tools: `whoami`, `tenant_limits`, `list_machines`, `get_machine`, `list_tests`,
`get_test`, `list_runs`, `get_run`, `get_run_logs`, `runs_by_machine`,
`run_test`, `metrics_catalog`, `query_metrics`, `get_otel_timeseries`,
`list_dashboards`, `list_git_repos`, `sync_git_repo`, `list_env_vars`
(values masked), `audit_log`.

## Development

```bash
pnpm install
pnpm test        # vitest across all packages
pnpm build       # tsc -b per package
```
