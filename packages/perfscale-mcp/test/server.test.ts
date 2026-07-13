import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ExecFn } from "../src/perfscale.js";
import { buildServer } from "../src/server.js";

const EXPECTED_TOOLS = [
  "run_test",
  "lint",
  "get_schema",
  "parse_summary",
  "list_actions",
  "list_configs",
  "read_config",
  "write_test",
  "write_config",
  "update_config",
  "remove_config",
];

const okLintExec: ExecFn = async (_bin, args) => {
  if (args[0] === "lint") return { exitCode: 0, stdout: "✓ ok", stderr: "" };
  return { exitCode: 0, stdout: "{}", stderr: "" };
};

async function connectedClient(exec: ExecFn = okLintExec) {
  const server = buildServer(exec);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "perfscale-mcp-server-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("perfscale OSS MCP server", () => {
  it("registers the full tool surface", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("parse_summary returns structured metrics", async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "parse_summary",
      arguments: {
        text: "http_req_duration......: avg=1ms p(95)=2ms\nhttp_reqs..............: 10 1.00/s\n",
      },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text).summary.p95_ms).toBe(2);
  });

  it("write_test writes the file and lints it", async () => {
    const linted: string[][] = [];
    const exec: ExecFn = async (_bin, args) => {
      linted.push(args);
      return { exitCode: 0, stdout: "✓ ok", stderr: "" };
    };
    const client = await connectedClient(exec);
    const path = join(dir, "t.yaml");
    const res = await client.callTool({
      name: "write_test",
      arguments: { path, content: "steps:\n  - use: std/http@v1\n" },
    });
    expect(res.isError).toBeFalsy();
    expect(linted).toEqual([["lint", path, "--schema", "test"]]);
  });

  it("update_config fails for missing files", async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "update_config",
      arguments: { path: join(dir, "absent.yaml"), content: "vus: 1\n" },
    });
    expect(res.isError).toBe(true);
  });

  it("remove_config deletes and errors are surfaced as isError", async () => {
    const client = await connectedClient();
    const path = join(dir, "c.yaml");
    await writeFile(path, "vus: 1\n");
    const ok = await client.callTool({ name: "remove_config", arguments: { path } });
    expect(ok.isError).toBeFalsy();
    const gone = await client.callTool({ name: "remove_config", arguments: { path } });
    expect(gone.isError).toBe(true);
  });
});
