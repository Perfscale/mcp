/**
 * Composite MCP — the core controlplane server plus the workspace's attached
 * remote MCP servers (Settings → AI → MCP Servers), exposed as ONE server.
 *
 * Everything is treated as a client: the core `buildServer` is wired up over
 * an in-memory transport, remote servers over streamable HTTP (with an SSE
 * fallback), and a thin low-level Server merges their tool lists and routes
 * calls. Remote tools are namespaced by the server's name (`grafana` →
 * `grafana_search_dashboards`); core tools keep their plain names. A remote
 * that fails to connect is skipped with a warning — the core surface must
 * never be held hostage by someone's Grafana being down.
 *
 * Attached servers are resolved via `GET /ai/mcp-servers/resolved`, which is
 * admin-only (header values are secrets): a non-admin token gets the core
 * server only.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { ControlplaneClient, ControlplaneError } from "./client.js";
import { buildServer } from "./server.js";

export interface RemoteMcpServer {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
}

/** One connected upstream: the core server or a tenant-attached remote. */
interface Upstream {
  /** Tool-name prefix ("" for the core server). */
  prefix: string;
  client: Client;
}

const CLIENT_INFO = { name: "perfscale-composite", version: "0.2.0" };

/** Fetch the workspace's attached servers; [] when the token lacks admin. */
export async function fetchRemoteServers(
  client: ControlplaneClient,
): Promise<RemoteMcpServer[]> {
  try {
    return await client.get<RemoteMcpServer[]>("/ai/mcp-servers/resolved");
  } catch (e) {
    if (e instanceof ControlplaneError && (e.status === 403 || e.status === 404)) {
      // Non-admin token, or a controlplane predating MCP servers.
      return [];
    }
    throw e;
  }
}

/** Connect a remote: streamable HTTP first, SSE as the legacy fallback. */
async function connectRemote(remote: RemoteMcpServer): Promise<Client> {
  const url = new URL(remote.url);
  const headers = remote.headers;
  try {
    const client = new Client(CLIENT_INFO);
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
    );
    return client;
  } catch {
    const client = new Client(CLIENT_INFO);
    await client.connect(new SSEClientTransport(url, { requestInit: { headers } }));
    return client;
  }
}

/** Wire the core `buildServer` up as just another client. */
async function connectCore(cp: ControlplaneClient): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const core = buildServer(cp);
  const client = new Client(CLIENT_INFO);
  await Promise.all([client.connect(clientTransport), core.connect(serverTransport)]);
  return client;
}

export interface CompositeOptions {
  /** Called once per remote that failed to connect (default: stderr). */
  onRemoteError?: (name: string, error: unknown) => void;
}

/**
 * Build the composite server. `remotes` typically comes from
 * [`fetchRemoteServers`]; pass [] for a core-only server (same tool surface
 * as `buildServer`, just behind the aggregating façade).
 */
export async function buildCompositeServer(
  cp: ControlplaneClient,
  remotes: RemoteMcpServer[],
  opts: CompositeOptions = {},
): Promise<Server> {
  const onRemoteError =
    opts.onRemoteError ??
    ((name, e) => console.error(`[composite] skipping MCP server '${name}':`, e));

  const upstreams: Upstream[] = [{ prefix: "", client: await connectCore(cp) }];
  for (const remote of remotes.filter((r) => r.enabled)) {
    try {
      upstreams.push({ prefix: `${remote.name}_`, client: await connectRemote(remote) });
    } catch (e) {
      onRemoteError(remote.name, e);
    }
  }

  const server = new Server(
    { name: "perfscale-controlplane-composite", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [];
    for (const up of upstreams) {
      try {
        const listed = await up.client.listTools();
        for (const t of listed.tools) {
          tools.push({ ...t, name: `${up.prefix}${t.name}` });
        }
      } catch (e) {
        onRemoteError(up.prefix.replace(/_$/, "") || "core", e);
      }
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    // Longest matching prefix wins, so a remote named "get" cannot shadow
    // core tools by accident; the core upstream ("" prefix) matches last.
    const up = [...upstreams]
      .sort((a, b) => b.prefix.length - a.prefix.length)
      .find((u) => name.startsWith(u.prefix));
    if (!up) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    return (await up.client.callTool({
      name: name.slice(up.prefix.length),
      arguments: args ?? {},
    })) as import("@modelcontextprotocol/sdk/types.js").CallToolResult;
  });

  return server;
}
