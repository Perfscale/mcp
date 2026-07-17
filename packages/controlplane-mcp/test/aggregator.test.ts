import { createServer, type Server as HttpServer } from "node:http";

import { describe, expect, it, vi, afterAll } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { buildCompositeServer, fetchRemoteServers } from "../src/aggregator.js";
import { ControlplaneClient } from "../src/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cpClient(fetchFn: typeof fetch): ControlplaneClient {
  return new ControlplaneClient({
    baseUrl: "https://perfscale.su",
    token: "psk_test",
    fetchFn,
  });
}

/** A minimal remote MCP server over real streamable HTTP, for the proxy path.
 * Stateless mode: a fresh server+transport per request, as the SDK docs
 * prescribe when `sessionIdGenerator` is undefined. */
async function startRemote(): Promise<{ url: string; http: HttpServer; seen: string[] }> {
  const seen: string[] = [];

  const buildFake = () => {
    const mcp = new McpServer({ name: "fake-grafana", version: "0.0.0" });
    mcp.registerTool(
      "search_dashboards",
      {
        description: "Search Grafana dashboards",
        inputSchema: { query: z.string() },
      },
      async ({ query }) => {
        seen.push(query);
        return { content: [{ type: "text" as const, text: `found: ${query}` }] };
      },
    );
    return mcp;
  };

  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await buildFake().connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}/mcp`, http, seen };
}

const openServers: HttpServer[] = [];
afterAll(async () => {
  await Promise.all(
    openServers.map((s) => {
      // The MCP client keeps its connection alive — sever it, then close.
      s.closeAllConnections();
      return new Promise<void>((resolve) => s.close(() => resolve()));
    }),
  );
});

async function connectComposite(
  cp: ControlplaneClient,
  remotes: Parameters<typeof buildCompositeServer>[1],
) {
  const server = await buildCompositeServer(cp, remotes, { onRemoteError: () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("composite aggregator", () => {
  it("with no remotes exposes exactly the core tool surface", async () => {
    const client = await connectComposite(cpClient(fetch), []);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("whoami");
    expect(names).toContain("write_test");
    expect(names).toContain("usage");
    expect(names.every((n) => !n.includes("grafana"))).toBe(true);
  });

  it("merges a remote's tools under its name prefix and routes calls", async () => {
    const remote = await startRemote();
    openServers.push(remote.http);

    const client = await connectComposite(cpClient(fetch), [
      { id: "r1", name: "grafana", url: remote.url, headers: {}, enabled: true },
    ]);

    const { tools } = await client.listTools();
    const grafanaTool = tools.find((t) => t.name === "grafana_search_dashboards");
    expect(grafanaTool, "remote tool present with prefix").toBeTruthy();
    // The remote's input schema travels through the proxy untouched.
    expect(grafanaTool!.inputSchema.properties).toHaveProperty("query");
    // Core tools keep their plain names next to the remote's.
    expect(tools.some((t) => t.name === "run_test")).toBe(true);

    const res = await client.callTool({
      name: "grafana_search_dashboards",
      arguments: { query: "p99 latency" },
    });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text).toBe("found: p99 latency");
    expect(remote.seen).toEqual(["p99 latency"]);
  });

  it("a dead remote is skipped, core tools survive", async () => {
    const client = await connectComposite(cpClient(fetch), [
      { id: "r1", name: "dead", url: "http://127.0.0.1:1/mcp", headers: {}, enabled: true },
    ]);
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === "whoami")).toBe(true);
    expect(tools.some((t) => t.name.startsWith("dead_"))).toBe(false);
  });

  it("disabled remotes are not connected at all", async () => {
    const client = await connectComposite(cpClient(fetch), [
      { id: "r1", name: "off", url: "http://127.0.0.1:1/mcp", headers: {}, enabled: false },
    ]);
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name.startsWith("off_"))).toBe(false);
  });

  it("unknown tool names come back as isError", async () => {
    const client = await connectComposite(cpClient(fetch), []);
    const res = await client.callTool({ name: "nonexistent_tool", arguments: {} });
    expect(res.isError).toBe(true);
  });
});

describe("fetchRemoteServers", () => {
  it("returns servers from the resolved endpoint", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain("/api/v1/ai/mcp-servers/resolved");
      return jsonResponse([
        { id: "a", name: "grafana", url: "https://g/mcp", headers: {}, enabled: true },
      ]);
    });
    const servers = await fetchRemoteServers(cpClient(fetchFn as unknown as typeof fetch));
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("grafana");
  });

  it("non-admin (403) and older controlplanes (404) mean core-only, not a crash", async () => {
    for (const status of [403, 404]) {
      const fetchFn = vi.fn(async () => jsonResponse({ message: "forbidden" }, status));
      const servers = await fetchRemoteServers(
        cpClient(fetchFn as unknown as typeof fetch),
      );
      expect(servers).toEqual([]);
    }
  });
});
