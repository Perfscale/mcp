#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildCompositeServer, fetchRemoteServers } from "./aggregator.js";
import { ControlplaneClient } from "./client.js";
import { buildServer } from "./server.js";

const cp = ControlplaneClient.fromEnv();

// Composite by default: core tools + the workspace's attached MCP servers
// (Settings → AI → MCP Servers; admin tokens only — others get core-only).
// PERFSCALE_MCP_COMPOSITE=off forces the plain core server.
if (process.env.PERFSCALE_MCP_COMPOSITE === "off") {
  const server = buildServer(cp);
  await server.connect(new StdioServerTransport());
} else {
  let remotes: Awaited<ReturnType<typeof fetchRemoteServers>> = [];
  try {
    remotes = await fetchRemoteServers(cp);
  } catch (e) {
    console.error("[composite] could not resolve attached MCP servers:", e);
  }
  const server = await buildCompositeServer(cp, remotes);
  await server.connect(new StdioServerTransport());
}
