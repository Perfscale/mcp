import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ExecFn } from "../src/perfscale.js";
import { readConfig } from "../src/configs.js";
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

  it("run_test builds perfscale argv and shapes the result", async () => {
    const seen: string[][] = [];
    const exec: ExecFn = async (_bin, args) => {
      seen.push(args);
      return { exitCode: 2, stdout: "out", stderr: "err" };
    };
    const client = await connectedClient(exec);
    const res = await client.callTool({
      name: "run_test",
      arguments: { file: "t.yaml", config: "c.yaml" },
    });
    expect(res.isError).toBeFalsy();
    expect(seen[0].slice(0, 5)).toEqual(["run", "-f", "t.yaml", "-c", "c.yaml"]);
    expect(seen[0]).toContain("--summary-export");
    const result = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(result.exitCode).toBe(2);
    expect(result.export).toBeNull();
    expect(result.stdoutTail).toBe("out");
    expect(result.stderrTail).toBe("err");
  });

  it("run_test with zero or two targets is an isError, not an exec", async () => {
    let execCalls = 0;
    const exec: ExecFn = async () => {
      execCalls++;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const client = await connectedClient(exec);

    const none = await client.callTool({ name: "run_test", arguments: {} });
    expect(none.isError).toBe(true);
    expect((none.content as Array<{ text: string }>)[0].text).toContain("exactly one");

    const two = await client.callTool({
      name: "run_test",
      arguments: { k6: "a.js", locust: "b.py" },
    });
    expect(two.isError).toBe(true);

    const nativeWithoutConfig = await client.callTool({
      name: "run_test",
      arguments: { file: "t.yaml" },
    });
    expect(nativeWithoutConfig.isError).toBe(true);
    expect((nativeWithoutConfig.content as Array<{ text: string }>)[0].text).toContain(
      "require a config",
    );

    expect(execCalls).toBe(0);
  });

  it("lint forwards files and schema and returns exitCode/output", async () => {
    const seen: string[][] = [];
    const exec: ExecFn = async (_bin, args) => {
      seen.push(args);
      return { exitCode: 1, stdout: "✗ bad.yaml", stderr: "" };
    };
    const client = await connectedClient(exec);
    const res = await client.callTool({
      name: "lint",
      arguments: { files: ["bad.yaml"], schema: "config" },
    });
    expect(res.isError).toBeFalsy();
    expect(seen[0]).toEqual(["lint", "bad.yaml", "--schema", "config"]);
    const result = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("bad.yaml");
  });

  it("lint with an empty file list is rejected by the schema", async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: "lint", arguments: { files: [] } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("Invalid arguments");
  });

  it("get_schema returns the parsed schema and surfaces CLI failures", async () => {
    const exec: ExecFn = async (_bin, args) => {
      if (args[1] === "test") return { exitCode: 0, stdout: '{"type":"object"}', stderr: "" };
      return { exitCode: 2, stdout: "", stderr: "unknown subcommand" };
    };
    const client = await connectedClient(exec);

    const ok = await client.callTool({ name: "get_schema", arguments: { kind: "test" } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse((ok.content as Array<{ text: string }>)[0].text)).toEqual({
      type: "object",
    });

    const old = await client.callTool({ name: "get_schema", arguments: { kind: "config" } });
    expect(old.isError).toBe(true);
    expect((old.content as Array<{ text: string }>)[0].text).toContain("self-update");
  });

  it("parse_summary reports when no HTTP metrics are found", async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "parse_summary",
      arguments: { text: "vus....................: 1 min=1 max=1\n" },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toEqual({
      summary: null,
      note: "No HTTP metrics found in output",
    });
  });

  it("list_actions returns the std/* catalog", async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: "list_actions", arguments: {} });
    const { actions } = JSON.parse((res.content as Array<{ text: string }>)[0].text) as {
      actions: Array<{ id: string }>;
    };
    expect(actions.map((a) => a.id)).toContain("std/http@v1");
    expect(actions.map((a) => a.id)).toContain("std/check@v1");
  });

  it("list_configs scans and classifies a directory", async () => {
    await writeFile(join(dir, "t.yaml"), "steps:\n  - use: std/http@v1\n");
    await writeFile(join(dir, "c.yaml"), "vus: 5\n");
    const client = await connectedClient();
    const res = await client.callTool({ name: "list_configs", arguments: { dir } });
    expect(res.isError).toBeFalsy();
    const entries = JSON.parse((res.content as Array<{ text: string }>)[0].text) as Array<{
      path: string;
      kind: string;
    }>;
    const kinds = Object.fromEntries(entries.map((e) => [e.path.split("/").pop(), e.kind]));
    expect(kinds).toEqual({ "t.yaml": "test", "c.yaml": "config" });
  });

  it("read_config returns path/kind/content and rejects non-yaml paths", async () => {
    const path = join(dir, "t.yaml");
    await writeFile(path, "steps:\n  - use: std/http@v1\n");
    const client = await connectedClient();

    const ok = await client.callTool({ name: "read_config", arguments: { path } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse((ok.content as Array<{ text: string }>)[0].text)).toEqual({
      path,
      kind: "test",
      content: "steps:\n  - use: std/http@v1\n",
    });

    const bad = await client.callTool({
      name: "read_config",
      arguments: { path: join(dir, "x.js") },
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as Array<{ text: string }>)[0].text).toContain("Not a YAML");
  });

  it("write_config lints against the config schema", async () => {
    const linted: string[][] = [];
    const exec: ExecFn = async (_bin, args) => {
      linted.push(args);
      return { exitCode: 0, stdout: "✓ ok", stderr: "" };
    };
    const client = await connectedClient(exec);
    const path = join(dir, "c.yaml");
    const res = await client.callTool({
      name: "write_config",
      arguments: { path, content: "vus: 10\n" },
    });
    expect(res.isError).toBeFalsy();
    expect(linted).toEqual([["lint", path, "--schema", "config"]]);
  });

  it("update_config detects the schema from content", async () => {
    const linted: string[][] = [];
    const exec: ExecFn = async (_bin, args) => {
      linted.push(args);
      return { exitCode: 0, stdout: "✓ ok", stderr: "" };
    };
    const client = await connectedClient(exec);
    const path = join(dir, "t.yaml");
    await writeFile(path, "steps:\n  - use: std/sleep@v1\n");

    const res = await client.callTool({
      name: "update_config",
      arguments: { path, content: "steps:\n  - use: std/http@v1\n" },
    });
    expect(res.isError).toBeFalsy();
    expect(linted).toEqual([["lint", path, "--schema", "test"]]);
  });

  it("update_config rejects non-mapping content before touching disk", async () => {
    const path = join(dir, "t.yaml");
    await writeFile(path, "vus: 1\n");
    const client = await connectedClient();
    const res = await client.callTool({
      name: "update_config",
      arguments: { path, content: "- a list\n" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("not a valid YAML");
    // Original file untouched.
    expect(await readConfig(path)).toBe("vus: 1\n");
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
