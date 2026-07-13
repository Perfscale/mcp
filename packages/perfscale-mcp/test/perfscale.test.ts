import { describe, expect, it } from "vitest";

import {
  buildRunArgs,
  getSchema,
  lintFiles,
  runTest,
  type ExecFn,
} from "../src/perfscale.js";

const okExec =
  (stdout = "", exitCode = 0, stderr = ""): ExecFn =>
  async () => ({ exitCode, stdout, stderr });

describe("buildRunArgs", () => {
  it("builds k6 args with summary export", () => {
    const args = buildRunArgs({ k6: "load.js" }, "/tmp/s.json");
    expect(args).toEqual([
      "run", "--k6", "load.js",
      "--quiet", "--summary-export", "/tmp/s.json", "--summary-format", "json",
    ]);
  });

  it("builds native args with config and host", () => {
    const args = buildRunArgs({ file: "t.yaml", config: "c.yaml", host: "http://x" }, "/tmp/s.json");
    expect(args.slice(0, 7)).toEqual(["run", "-f", "t.yaml", "-c", "c.yaml", "--host", "http://x"]);
  });
});

describe("runTest", () => {
  it("rejects zero or multiple targets", async () => {
    await expect(runTest({}, okExec())).rejects.toThrow(/exactly one/);
    await expect(runTest({ k6: "a.js", locust: "b.py" }, okExec())).rejects.toThrow(/exactly one/);
  });

  it("rejects native file without config", async () => {
    await expect(runTest({ file: "t.yaml" }, okExec())).rejects.toThrow(/require a config/);
  });

  it("returns exit code and output tails when no export file was produced", async () => {
    const res = await runTest({ k6: "load.js" }, okExec("all good", 0));
    expect(res.exitCode).toBe(0);
    expect(res.export).toBeNull();
    expect(res.stdoutTail).toBe("all good");
  });
});

describe("lintFiles", () => {
  it("passes schema override and combines output", async () => {
    let seen: string[] = [];
    const exec: ExecFn = async (_bin, args) => {
      seen = args;
      return { exitCode: 1, stdout: "✗ bad.yaml", stderr: "" };
    };
    const res = await lintFiles(["bad.yaml"], "config", exec);
    expect(seen).toEqual(["lint", "bad.yaml", "--schema", "config"]);
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain("bad.yaml");
  });

  it("requires at least one file", async () => {
    await expect(lintFiles([], "auto", okExec())).rejects.toThrow(/at least one/);
  });
});

describe("getSchema", () => {
  it("parses schema JSON from stdout", async () => {
    const schema = await getSchema("test", okExec('{"$schema": "x", "type": "object"}'));
    expect(schema).toEqual({ $schema: "x", type: "object" });
  });

  it("explains when the installed CLI lacks the schema command", async () => {
    await expect(getSchema("test", okExec("", 2, "unknown subcommand"))).rejects.toThrow(
      /self-update/,
    );
  });
});
