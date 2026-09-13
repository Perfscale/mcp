import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRunArgs,
  defaultExec,
  getSchema,
  lintFiles,
  perfscaleBin,
  runTest,
  type ExecFn,
} from "../src/perfscale.js";

const okExec =
  (stdout = "", exitCode = 0, stderr = ""): ExecFn =>
  async () => ({ exitCode, stdout, stderr });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("perfscaleBin", () => {
  it("defaults to 'perfscale' when PERFSCALE_BIN is unset", () => {
    const saved = process.env.PERFSCALE_BIN;
    delete process.env.PERFSCALE_BIN;
    try {
      expect(perfscaleBin()).toBe("perfscale");
    } finally {
      if (saved !== undefined) process.env.PERFSCALE_BIN = saved;
    }
  });

  it("honors PERFSCALE_BIN", () => {
    vi.stubEnv("PERFSCALE_BIN", "/opt/perfscale/bin/perfscale");
    expect(perfscaleBin()).toBe("/opt/perfscale/bin/perfscale");
  });
});

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

  it("builds locust args", () => {
    const args = buildRunArgs({ locust: "swarm.py" }, "/tmp/s.json");
    expect(args.slice(0, 3)).toEqual(["run", "--locust", "swarm.py"]);
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

  it("parses the --summary-export JSON the run produced", async () => {
    const summary = { avg_ms: 1.5, p95_ms: 4, error_rate: 0, total_requests: 100 };
    const exec: ExecFn = async (_bin, args) => {
      const exportPath = args[args.indexOf("--summary-export") + 1];
      await writeFile(exportPath, JSON.stringify(summary));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const res = await runTest({ k6: "load.js" }, exec);
    expect(res.export).toEqual(summary);
  });

  it("keeps a failing run's exit code and stderr, tails stdout to 60 lines", async () => {
    const stdout = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const res = await runTest({ k6: "load.js" }, okExec(stdout, 1, "boom"));
    expect(res.exitCode).toBe(1);
    expect(res.stderrTail).toBe("boom");
    expect(res.stdoutTail.split("\n")).toHaveLength(60);
    expect(res.stdoutTail.startsWith("line 41")).toBe(true);
    expect(res.stdoutTail.endsWith("line 100")).toBe(true);
  });

  it("does not swallow exec errors", async () => {
    const exec: ExecFn = async () => {
      throw new Error("spawn failed");
    };
    await expect(runTest({ k6: "load.js" }, exec)).rejects.toThrow("spawn failed");
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

  it("auto schema adds no --schema flag", async () => {
    let seen: string[] = [];
    const exec: ExecFn = async (_bin, args) => {
      seen = args;
      return { exitCode: 0, stdout: "✓ ok", stderr: "" };
    };
    await lintFiles(["a.yaml", "b.yaml"], "auto", exec);
    expect(seen).toEqual(["lint", "a.yaml", "b.yaml"]);
  });
});

describe("defaultExec", () => {
  it("captures stdout on success", async () => {
    const res = await defaultExec(process.execPath, ["-e", "console.log('hi')"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hi");
  });

  it("maps numeric exit codes without throwing", async () => {
    const res = await defaultExec(process.execPath, ["-e", "process.exit(3)"]);
    expect(res.exitCode).toBe(3);
  });

  it("maps a missing binary to 127", async () => {
    const res = await defaultExec("/nonexistent/perfscale-bin", ["run"]);
    expect(res.exitCode).toBe(127);
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
