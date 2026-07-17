/**
 * Library entry — everything the dashboard (ASK AI chat route, the platform
 * MCP endpoint) embeds in-process. The `index.ts` bin wires the same pieces
 * to stdio for desktop MCP clients.
 */

export {
  buildCompositeServer,
  fetchRemoteServers,
  type CompositeOptions,
  type RemoteMcpServer,
} from "./aggregator.js";
export { ControlplaneClient, ControlplaneError, type ClientOptions } from "./client.js";
export { buildServer } from "./server.js";
