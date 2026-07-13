#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ControlplaneClient } from "./client.js";
import { buildServer } from "./server.js";

const server = buildServer(ControlplaneClient.fromEnv());
await server.connect(new StdioServerTransport());
