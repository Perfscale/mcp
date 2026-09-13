import { describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ControlplaneClient } from "../src/client.js";
import { buildServer } from "../src/server.js";

const EXPECTED_TOOLS = [
  "whoami",
  "limits",
  "usage",
  "write_test",
  "list_configs",
  "write_config",
  "list_machines",
  "get_machine",
  "list_tests",
  "get_test",
  "list_runs",
  "get_run",
  "get_run_logs",
  "runs_by_machine",
  "run_test",
  "metrics_catalog",
  "query_metrics",
  "get_otel_timeseries",
  "list_dashboards",
  "list_git_repos",
  "sync_git_repo",
  "list_env_vars",
  "audit_log",
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function connectedClient(fetchFn: typeof fetch) {
  const cp = new ControlplaneClient({
    baseUrl: "https://perfscale.su",
    token: "psk_test",
    fetchFn,
  });
  const server = buildServer(cp);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("controlplane MCP server", () => {
  it("registers the full tool surface", async () => {
    const client = await connectedClient(fetch);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("run_test maps tool input to the BFF request shape", async () => {
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain("/api/v1/test/run");
      expect(JSON.parse(init?.body as string)).toEqual({
        machine: ["m1", "m2"],
        test: "t9",
      });
      return jsonResponse({ streams: { m1: { taskId: "a", url: "/x" } } });
    });
    const client = await connectedClient(fetchFn as unknown as typeof fetch);
    const res = await client.callTool({
      name: "run_test",
      arguments: { testId: "t9", machineIds: ["m1", "m2"] },
    });
    expect(res.isError).toBeFalsy();
  });

  it("query_metrics JSON-encodes label filters", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      const u = new URL(String(url));
      expect(u.searchParams.get("metric")).toBe("cpu");
      expect(u.searchParams.get("labels")).toBe('{"region":"eu"}');
      return jsonResponse({ metric: "cpu", points: [] });
    });
    const client = await connectedClient(fetchFn as unknown as typeof fetch);
    const res = await client.callTool({
      name: "query_metrics",
      arguments: { metric: "cpu", labels: { region: "eu" } },
    });
    expect(res.isError).toBeFalsy();
  });

  it("list_env_vars masks values", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse([{ key: "SECRET_URL", value: "https://user:pass@db" }]),
    );
    const client = await connectedClient(fetchFn as unknown as typeof fetch);
    const res = await client.callTool({ name: "list_env_vars", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SECRET_URL");
    expect(text).not.toContain("user:pass");
    expect(text).toContain("***");
  });

  it("API errors surface as isError results, not protocol failures", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: "nope" }, 403));
    const client = await connectedClient(fetchFn as unknown as typeof fetch);
    const res = await client.callTool({ name: "list_machines", arguments: {} });
    expect(res.isError).toBe(true);
  });

  it("write_test creates via POST and updates via PUT", async () => {
    const calls: Array<{ method?: string; url: string; body: unknown }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({
        method: init?.method,
        url: String(url),
        body: JSON.parse(init?.body as string),
      });
      return jsonResponse({ id: "t1" });
    });
    const client = await connectedClient(fetchFn as unknown as typeof fetch);

    await client.callTool({
      name: "write_test",
      arguments: {
        name: "smoke",
        config: { steps: [{ use: "std/http@v1", with: { url: "https://x" } }] },
      },
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/api/v1/tests");
    expect((calls[0].body as { type: string }).type).toBe("native");

    await client.callTool({
      name: "write_test",
      arguments: { testId: "t1", name: "smoke-2" },
    });
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].url).toContain("/api/v1/tests/t1");
  });

  it("write_test without name/config is a clear isError, no request made", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}));
    const client = await connectedClient(fetchFn as unknown as typeof fetch);
    const res = await client.callTool({ name: "write_test", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("requires");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("write_config creates and updates configurations", async () => {
    const calls: Array<{ method?: string; url: string }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method, url: String(url) });
      return jsonResponse({ id: "c1", name: "evening-peak" });
    });
    const client = await connectedClient(fetchFn as unknown as typeof fetch);

    await client.callTool({
      name: "write_config",
      arguments: { name: "evening-peak", config: { vus: 50, duration: "10m" } },
    });
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0].url).toContain("/api/v1/configurations");

    await client.callTool({
      name: "write_config",
      arguments: { configId: "c1", config: { vus: 80, duration: "10m" } },
    });
    expect(calls[1]).toMatchObject({ method: "PUT" });
    expect(calls[1].url).toContain("/api/v1/configurations/c1");
  });

  it("usage and limits hit their endpoints", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return jsonResponse({});
    });
    const client = await connectedClient(fetchFn as unknown as typeof fetch);
    await client.callTool({ name: "usage", arguments: {} });
    await client.callTool({ name: "limits", arguments: {} });
    expect(urls[0]).toContain("/api/v1/ai/usage");
    expect(urls[1]).toContain("/api/v1/tenants/limits");
  });

  it("read tools map to their BFF paths", async () => {
    const calls: Array<{ method?: string; url: string }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url) });
      return jsonResponse({});
    });
    const client = await connectedClient(fetchFn as unknown as typeof fetch);

    const table: Array<{ tool: string; args: Record<string, unknown>; method: string; path: string }> = [
      { tool: "whoami", args: {}, method: "GET", path: "/api/v1/auth/me" },
      { tool: "list_machines", args: {}, method: "GET", path: "/api/v1/machines" },
      { tool: "get_machine", args: { machineId: "m1" }, method: "GET", path: "/api/v1/machines/m1" },
      { tool: "list_tests", args: {}, method: "GET", path: "/api/v1/tests" },
      { tool: "get_test", args: { testId: "t1" }, method: "GET", path: "/api/v1/tests/t1" },
      { tool: "list_configs", args: {}, method: "GET", path: "/api/v1/configurations" },
      { tool: "list_runs", args: {}, method: "GET", path: "/api/v1/tasks" },
      { tool: "get_run", args: { taskId: "k1" }, method: "GET", path: "/api/v1/tasks/k1" },
      { tool: "runs_by_machine", args: { machineId: "m1" }, method: "GET", path: "/api/v1/machines/m1/tasks" },
      { tool: "metrics_catalog", args: {}, method: "GET", path: "/api/v1/metrics/catalog" },
      { tool: "get_otel_timeseries", args: { taskId: "k1" }, method: "GET", path: "/api/v1/tasks/k1/otel-timeseries" },
      { tool: "list_dashboards", args: {}, method: "GET", path: "/api/v1/metric-dashboards" },
      { tool: "list_git_repos", args: {}, method: "GET", path: "/api/v1/git/repositories" },
      { tool: "sync_git_repo", args: { repoId: "r1" }, method: "POST", path: "/api/v1/git/repositories/r1/sync" },
      { tool: "audit_log", args: {}, method: "GET", path: "/api/v1/run-logs" },
    ];
    for (const { tool, args } of table) {
      const res = await client.callTool({ name: tool, arguments: args });
      expect(res.isError, tool).toBeFalsy();
    }
    expect(calls.map((c) => [c.method, c.url])).toEqual(
      table.map((t) => [t.method, `https://perfscale.su${t.path}`]),
    );
  });

  it("get_run_logs shapes logText/logUrl and defaults them to null", async () => {
    const bodies: unknown[] = [
      { logText: "line1\nline2", logUrl: "https://logs/k1" },
      {},
    ];
    const fetchFn = vi.fn(async () => jsonResponse(bodies.shift()));
    const client = await connectedClient(fetchFn as unknown as typeof fetch);

    const full = await client.callTool({ name: "get_run_logs", arguments: { taskId: "k1" } });
    expect(JSON.parse((full.content as Array<{ text: string }>)[0].text)).toEqual({
      taskId: "k1",
      logText: "line1\nline2",
      logUrl: "https://logs/k1",
    });

    const sparse = await client.callTool({ name: "get_run_logs", arguments: { taskId: "k2" } });
    expect(JSON.parse((sparse.content as Array<{ text: string }>)[0].text)).toEqual({
      taskId: "k2",
      logText: null,
      logUrl: null,
    });
  });

  it("run_test forwards configurationId as configuration", async () => {
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({
        machine: ["m1"],
        test: "t9",
        configuration: "evening-peak",
      });
      return jsonResponse({ streams: {} });
    });
    const client = await connectedClient(fetchFn as unknown as typeof fetch);
    const res = await client.callTool({
      name: "run_test",
      arguments: { testId: "t9", machineIds: ["m1"], configurationId: "evening-peak" },
    });
    expect(res.isError).toBeFalsy();
  });

  it("query_metrics passes from/to/step and omits labels when absent", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      const u = new URL(String(url));
      expect(u.searchParams.get("metric")).toBe("rps");
      expect(u.searchParams.get("from")).toBe("2026-09-13T10:00:00Z");
      expect(u.searchParams.get("to")).toBe("2026-09-13T11:00:00Z");
      expect(u.searchParams.get("step")).toBe("30");
      expect(u.searchParams.has("labels")).toBe(false);
      return jsonResponse({ points: [] });
    });
    const client = await connectedClient(fetchFn as unknown as typeof fetch);
    const res = await client.callTool({
      name: "query_metrics",
      arguments: { metric: "rps", from: "2026-09-13T10:00:00Z", to: "2026-09-13T11:00:00Z", step: 30 },
    });
    expect(res.isError).toBeFalsy();
  });

  it("write_config without name/config is a clear isError, no request made", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}));
    const client = await connectedClient(fetchFn as unknown as typeof fetch);
    const res = await client.callTool({ name: "write_config", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("requires");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("invalid arguments are rejected by the schema, not sent upstream", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}));
    const client = await connectedClient(fetchFn as unknown as typeof fetch);

    const noMachines = await client.callTool({
      name: "run_test",
      arguments: { testId: "t9", machineIds: [] },
    });
    expect(noMachines.isError).toBe(true);
    expect((noMachines.content as Array<{ text: string }>)[0].text).toContain("Invalid arguments");

    const badStep = await client.callTool({
      name: "query_metrics",
      arguments: { metric: "cpu", step: -5 },
    });
    expect(badStep.isError).toBe(true);

    const badType = await client.callTool({
      name: "write_test",
      arguments: { name: "x", config: {}, type: "cucumber" },
    });
    expect(badType.isError).toBe(true);

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
