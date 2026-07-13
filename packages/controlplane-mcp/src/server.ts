import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ControlplaneClient, maskEnvVars } from "./client.js";

function textResult(data: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

async function guarded<T>(fn: () => Promise<T>) {
  try {
    return textResult(await fn());
  } catch (e) {
    return textResult(e instanceof Error ? e.message : String(e), true);
  }
}

export function buildServer(client: ControlplaneClient): McpServer {
  const server = new McpServer({ name: "perfscale-controlplane", version: "0.1.0" });

  // ── Identity & workspace ──────────────────────────────────────────────
  server.registerTool(
    "whoami",
    {
      title: "Current user",
      description: "Current user profile, active workspace, role, and permissions.",
      inputSchema: {},
    },
    async () => guarded(() => client.get("/auth/me")),
  );

  server.registerTool(
    "tenant_limits",
    {
      title: "Workspace plan & limits",
      description:
        "Plan (starter/scale/enterprise), machine/test limits, retention, storage usage.",
      inputSchema: {},
    },
    async () => guarded(() => client.get("/tenants/limits")),
  );

  // ── Machines ──────────────────────────────────────────────────────────
  server.registerTool(
    "list_machines",
    {
      title: "List machines",
      description:
        "Load generator machines: status, OS/arch, CPU/RAM, agent version, " +
        "benchmark capacity (VUs/RPS), region.",
      inputSchema: {},
    },
    async () => guarded(() => client.get("/machines")),
  );

  server.registerTool(
    "get_machine",
    {
      title: "Get machine",
      description: "Single machine detail including network throughput and last-seen time.",
      inputSchema: { machineId: z.string() },
    },
    async ({ machineId }) => guarded(() => client.get(`/machines/${machineId}`)),
  );

  // ── Tests ─────────────────────────────────────────────────────────────
  server.registerTool(
    "list_tests",
    {
      title: "List tests",
      description: "Test definitions with type (native/k6/locust/...) and status.",
      inputSchema: {},
    },
    async () => guarded(() => client.get("/tests")),
  );

  server.registerTool(
    "get_test",
    {
      title: "Get test",
      description: "Full test definition including its config JSON.",
      inputSchema: { testId: z.string() },
    },
    async ({ testId }) => guarded(() => client.get(`/tests/${testId}`)),
  );

  // ── Runs (tasks) ──────────────────────────────────────────────────────
  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description: "Recent test runs: status, duration, result metrics (p50/p95/p99, RPS).",
      inputSchema: {},
    },
    async () => guarded(() => client.get("/tasks")),
  );

  server.registerTool(
    "get_run",
    {
      title: "Get run",
      description:
        "Single run with result metrics: p50/p95/p99 ms, error rate, RPS, total requests.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => guarded(() => client.get(`/tasks/${taskId}`)),
  );

  server.registerTool(
    "get_run_logs",
    {
      title: "Get run logs",
      description: "Full log output of a run (log_text / log_url from the run record).",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) =>
      guarded(async () => {
        const task = await client.get<{ logText?: string; logUrl?: string }>(`/tasks/${taskId}`);
        return {
          taskId,
          logText: task.logText ?? null,
          logUrl: task.logUrl ?? null,
        };
      }),
  );

  server.registerTool(
    "runs_by_machine",
    {
      title: "Runs by machine",
      description: "Run history for a specific machine.",
      inputSchema: { machineId: z.string() },
    },
    async ({ machineId }) => guarded(() => client.get(`/machines/${machineId}/tasks`)),
  );

  server.registerTool(
    "run_test",
    {
      title: "Run a test",
      description:
        "Dispatch a test to one or more machines. Returns per-machine task IDs and " +
        "log-stream URLs. Requires the run_tests permission.",
      inputSchema: {
        testId: z.string().describe("Test definition ID"),
        machineIds: z.array(z.string()).min(1).describe("Machine IDs to run on"),
        configurationId: z.string().optional().describe("Configuration preset ID"),
      },
    },
    async ({ testId, machineIds, configurationId }) =>
      guarded(() =>
        client.post("/test/run", {
          machine: machineIds,
          test: testId,
          configuration: configurationId,
        }),
      ),
  );

  // ── Metrics ───────────────────────────────────────────────────────────
  server.registerTool(
    "metrics_catalog",
    {
      title: "Metrics catalog",
      description: "Names of all metrics available for querying in this workspace.",
      inputSchema: {},
    },
    async () => guarded(() => client.get("/metrics/catalog")),
  );

  server.registerTool(
    "query_metrics",
    {
      title: "Query metrics",
      description:
        "Time-series for a metric. Optional RFC3339 from/to (default: last hour), " +
        "step in seconds (default 60), and a label filter.",
      inputSchema: {
        metric: z.string(),
        from: z.string().optional().describe("RFC3339 start, default now-1h"),
        to: z.string().optional().describe("RFC3339 end, default now"),
        step: z.number().int().positive().optional().describe("Bucket seconds, default 60"),
        labels: z.record(z.string()).optional().describe('Label filter, e.g. {"region":"eu"}'),
      },
    },
    async ({ metric, from, to, step, labels }) =>
      guarded(() =>
        client.get("/metrics/query", {
          metric,
          from,
          to,
          step,
          labels: labels ? JSON.stringify(labels) : undefined,
        }),
      ),
  );

  server.registerTool(
    "get_otel_timeseries",
    {
      title: "OTEL time-series for a run",
      description: "OTEL metric time-series collected during a specific run.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => guarded(() => client.get(`/tasks/${taskId}/otel-timeseries`)),
  );

  server.registerTool(
    "list_dashboards",
    {
      title: "List metric dashboards",
      description: "Custom metric dashboards with their layouts.",
      inputSchema: {},
    },
    async () => guarded(() => client.get("/metric-dashboards")),
  );

  // ── Integrations & environment ────────────────────────────────────────
  server.registerTool(
    "list_git_repos",
    {
      title: "List git repositories",
      description: "Connected git repositories and their test-sync status.",
      inputSchema: {},
    },
    async () => guarded(() => client.get("/git/repositories")),
  );

  server.registerTool(
    "sync_git_repo",
    {
      title: "Sync a git repository",
      description: "Trigger test discovery/sync for a connected git repository.",
      inputSchema: { repoId: z.string() },
    },
    async ({ repoId }) => guarded(() => client.post(`/git/repositories/${repoId}/sync`, {})),
  );

  server.registerTool(
    "list_env_vars",
    {
      title: "List environment variables",
      description: "Global environment variable keys. Values are masked — never exposed.",
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const vars = await client.get<Array<{ value?: string }>>("/env-vars");
        return maskEnvVars(vars);
      }),
  );

  // ── Audit ─────────────────────────────────────────────────────────────
  server.registerTool(
    "audit_log",
    {
      title: "Audit log",
      description: "Workspace activity log: action, actor, target, time.",
      inputSchema: {},
    },
    async () => guarded(() => client.get("/run-logs")),
  );

  return server;
}
