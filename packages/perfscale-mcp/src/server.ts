import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  classify,
  listConfigs,
  readConfig,
  removeConfig,
  writeYaml,
} from "./configs.js";
import { getSchema, lintFiles, runTest, type ExecFn, defaultExec } from "./perfscale.js";
import { parseSummary } from "./summary.js";

/** Static catalog of native step actions (std/*), mirroring perfscale-core. */
const ACTIONS = [
  { id: "std/http@v1", description: "HTTP request step: method, url, headers, body" },
  { id: "std/check@v1", description: "Assert on the previous response: status, body, latency" },
  { id: "std/sleep@v1", description: "Pause for a fixed duration" },
  { id: "std/log@v1", description: "Emit a log line" },
  { id: "std/file@v1", description: "Read data files for parameterised requests" },
] as const;

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

async function guarded<T>(fn: () => Promise<T> | T) {
  try {
    return textResult(await fn());
  } catch (e) {
    return textResult(e instanceof Error ? e.message : String(e), true);
  }
}

export function buildServer(exec: ExecFn = defaultExec): McpServer {
  const server = new McpServer({ name: "perfscale", version: "0.1.0" });

  server.registerTool(
    "run_test",
    {
      title: "Run a load test",
      description:
        "Run a k6, locust, or native perfscale load test locally and return the structured " +
        "summary (avg/p90/p95/p99, error rate, RPS). Provide exactly one of k6/locust/file; " +
        "native tests (file) also require config.",
      inputSchema: {
        k6: z.string().optional().describe("Path to a k6 .js script"),
        locust: z.string().optional().describe("Path to a locust .py file"),
        file: z.string().optional().describe("Path to a native test .yaml (requires config)"),
        config: z.string().optional().describe("Path to a run config .yaml"),
        host: z.string().optional().describe("Target host override (locust)"),
      },
    },
    async (input) => guarded(() => runTest(input, exec)),
  );

  server.registerTool(
    "lint",
    {
      title: "Lint YAML files",
      description:
        "Validate perfscale test/config YAML files against their JSON Schemas plus extra " +
        "checks (typo'd fields, unknown action IDs). exitCode 0 = all valid.",
      inputSchema: {
        files: z.array(z.string()).min(1).describe("YAML files to validate"),
        schema: z.enum(["auto", "test", "config"]).default("auto"),
      },
    },
    async ({ files, schema }) => guarded(() => lintFiles(files, schema, exec)),
  );

  server.registerTool(
    "get_schema",
    {
      title: "Get JSON Schema",
      description:
        "Return the JSON Schema perfscale validates test or config YAML against — " +
        "use it to author valid files.",
      inputSchema: { kind: z.enum(["test", "config"]) },
    },
    async ({ kind }) => guarded(() => getSchema(kind, exec)),
  );

  server.registerTool(
    "parse_summary",
    {
      title: "Parse a k6-compatible summary",
      description:
        "Parse raw run output (k6/locust/native) into structured metrics: " +
        "avg/med/p90/p95/p99/min/max (ms), error_rate, total_requests, requests_per_sec.",
      inputSchema: { text: z.string().describe("Raw run output containing the summary block") },
    },
    async ({ text }) =>
      guarded(() => {
        const summary = parseSummary(text);
        if (summary === null) return { summary: null, note: "No HTTP metrics found in output" };
        return { summary };
      }),
  );

  server.registerTool(
    "list_actions",
    {
      title: "List native step actions",
      description: "Catalog of std/* actions usable in native test YAML steps.",
      inputSchema: {},
    },
    async () => guarded(() => ({ actions: ACTIONS })),
  );

  server.registerTool(
    "list_configs",
    {
      title: "List test/config YAML files",
      description:
        "Recursively list YAML files under a directory, classified as `test` " +
        "(top-level steps key), `config`, or `invalid`.",
      inputSchema: { dir: z.string().describe("Directory to scan") },
    },
    async ({ dir }) => guarded(() => listConfigs(dir)),
  );

  server.registerTool(
    "read_config",
    {
      title: "Read a YAML file",
      description: "Read a perfscale test/config YAML file and report its kind.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) =>
      guarded(async () => {
        const content = await readConfig(path);
        return { path, kind: classify(content), content };
      }),
  );

  const writeAndLint = async (
    path: string,
    content: string,
    schema: "test" | "config",
    mustExist: boolean,
  ) => {
    await writeYaml(path, content, mustExist);
    const lint = await lintFiles([path], schema, exec);
    return { path, written: true, lint };
  };

  server.registerTool(
    "write_test",
    {
      title: "Write a test definition",
      description:
        "Create or overwrite a native test YAML (steps) and lint it against the test schema.",
      inputSchema: { path: z.string(), content: z.string().describe("YAML content") },
    },
    async ({ path, content }) => guarded(() => writeAndLint(path, content, "test", false)),
  );

  server.registerTool(
    "write_config",
    {
      title: "Write a run config",
      description:
        "Create or overwrite a run config YAML and lint it against the config schema.",
      inputSchema: { path: z.string(), content: z.string().describe("YAML content") },
    },
    async ({ path, content }) => guarded(() => writeAndLint(path, content, "config", false)),
  );

  server.registerTool(
    "update_config",
    {
      title: "Update an existing YAML file",
      description:
        "Overwrite an existing test/config YAML (fails when absent) and lint it; " +
        "schema is detected from content.",
      inputSchema: { path: z.string(), content: z.string().describe("YAML content") },
    },
    async ({ path, content }) =>
      guarded(async () => {
        const kind = classify(content);
        if (kind === "invalid") throw new Error("Content is not a valid YAML mapping");
        return writeAndLint(path, content, kind, true);
      }),
  );

  server.registerTool(
    "remove_config",
    {
      title: "Remove a YAML file",
      description: "Delete a perfscale test/config YAML file.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) =>
      guarded(async () => {
        await removeConfig(path);
        return { path, removed: true };
      }),
  );

  return server;
}
