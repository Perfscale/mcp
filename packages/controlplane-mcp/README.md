# @perfscale/controlplane-mcp

MCP server for the [perfscale](https://perfscale.su) hosted platform.
Gives AI agents (Claude Code, Claude Desktop, any MCP client) access to your
workspace — machines, tests, runs with full metrics and logs, OTEL
time-series, dashboards, audit log — plus the ability to dispatch test runs.

## Requirements

- Node.js 20+
- A perfscale workspace on the **Scale** or **Enterprise** plan
- A personal API token (`psk_...`)

## Get an API token

In the dashboard: **Settings → API Tokens → Create API Token**. The plaintext
is shown once — store it in a secret manager.

- Limits per user: Scale — 1 token, Enterprise — 5
- A token acts as you, with your role, in the workspace it was created in
- Revoke any time from the same page; usage stamps `last used`, creation and
  revocation land in the audit log

## Setup

Claude Code:

```sh
claude mcp add perfscale-cloud \
  -e PERFSCALE_API_URL=https://perfscale.su \
  -e PERFSCALE_API_TOKEN=psk_... \
  -- npx -y @perfscale/controlplane-mcp
```

Claude Desktop / other MCP clients:

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

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PERFSCALE_API_TOKEN` | — (required) | Personal API token (`psk_...`) |
| `PERFSCALE_API_URL` | `https://perfscale.su` | Base URL; use `https://perfscale.ru` if your workspace lives there |

## Tools

| Tool | Access | What it returns |
|---|---|---|
| `whoami` | read | Current user, workspace, role, permissions |
| `tenant_limits` | read | Plan, machine/test limits, retention, storage usage |
| `list_machines` / `get_machine` | read | Machine fleet: status, hardware, agent version, benchmark capacity, region |
| `list_tests` / `get_test` | read | Test definitions with config JSON |
| `list_runs` / `get_run` | read | Runs with p50/p95/p99, error rate, RPS, total requests |
| `get_run_logs` | read | Full log output of a run |
| `runs_by_machine` | read | Run history for one machine |
| `metrics_catalog` / `query_metrics` | read | Available metrics; time-series with label filters |
| `get_otel_timeseries` | read | OTEL metrics collected during a run |
| `list_dashboards` | read | Custom metric dashboards |
| `list_git_repos` | read | Connected repositories and sync status |
| `list_env_vars` | read | Environment variable keys — **values are always masked** |
| `audit_log` | read | Workspace activity: action, actor, target, time |
| `run_test` | **write** | Dispatch a test to machines; returns task IDs and log-stream URLs |
| `sync_git_repo` | **write** | Trigger test discovery for a repository |

Write tools respect workspace RBAC — `run_test` requires the `run_tests`
permission, exactly as in the dashboard.

## Example

> Which machine handled the most requests today, and what was its p95 in the
> last run?

The agent calls `list_machines` → `runs_by_machine` → `get_run` and answers
from the structured metrics.

## Notes

- For local load testing with the open-source CLI use
  [`@perfscale/mcp`](https://www.npmjs.com/package/@perfscale/mcp).
- Tokens work for the whole REST API too:
  `curl https://perfscale.su/api/v1/machines -H "Authorization: Bearer psk_..."`

## Links

- [Docs](https://perfscale.su/docs/api-reference/mcp)
- [Source](https://github.com/Perfscale/mcp)

## License

Apache-2.0
