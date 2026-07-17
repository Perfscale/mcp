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
});
