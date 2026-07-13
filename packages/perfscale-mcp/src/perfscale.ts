/**
 * Thin wrapper around the locally installed `perfscale` binary.
 * The binary path can be overridden with PERFSCALE_BIN.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (bin: string, args: string[]) => Promise<ExecResult>;

export function perfscaleBin(): string {
  return process.env.PERFSCALE_BIN ?? "perfscale";
}

/** Default exec: never throws on non-zero exit — callers read exitCode. */
export const defaultExec: ExecFn = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const anyErr = err as (Error & { code?: number | string }) | null;
      const exitCode =
        anyErr == null ? 0 : typeof anyErr.code === "number" ? anyErr.code : 127;
      resolve({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });

export interface RunTestInput {
  k6?: string;
  locust?: string;
  file?: string;
  config?: string;
  host?: string;
}

/** Build the argv for `perfscale run` from tool input. */
export function buildRunArgs(input: RunTestInput, summaryExport: string): string[] {
  const args = ["run"];
  if (input.k6) args.push("--k6", input.k6);
  if (input.locust) args.push("--locust", input.locust);
  if (input.file) args.push("-f", input.file);
  if (input.config) args.push("-c", input.config);
  if (input.host) args.push("--host", input.host);
  args.push("--quiet", "--summary-export", summaryExport, "--summary-format", "json");
  return args;
}

export interface RunTestResult {
  exitCode: number;
  /** Parsed --summary-export JSON, if the run produced one. */
  export: unknown | null;
  stdoutTail: string;
  stderrTail: string;
}

const TAIL_LINES = 60;

function tail(text: string): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join("\n");
}

export async function runTest(input: RunTestInput, exec: ExecFn = defaultExec): Promise<RunTestResult> {
  const targets = [input.k6, input.locust, input.file].filter(Boolean);
  if (targets.length !== 1) {
    throw new Error("Provide exactly one of: k6, locust, file");
  }
  if (input.file && !input.config) {
    throw new Error("Native tests (file) require a config");
  }

  const dir = await mkdtemp(join(tmpdir(), "perfscale-mcp-"));
  const exportPath = join(dir, "summary.json");
  try {
    const res = await exec(perfscaleBin(), buildRunArgs(input, exportPath));
    let exported: unknown | null = null;
    try {
      exported = JSON.parse(await readFile(exportPath, "utf8"));
    } catch {
      exported = null;
    }
    return {
      exitCode: res.exitCode,
      export: exported,
      stdoutTail: tail(res.stdout),
      stderrTail: tail(res.stderr),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface LintResult {
  exitCode: number;
  output: string;
}

export async function lintFiles(
  files: string[],
  schema: "auto" | "test" | "config" = "auto",
  exec: ExecFn = defaultExec,
): Promise<LintResult> {
  if (files.length === 0) throw new Error("Provide at least one file to lint");
  const args = ["lint", ...files];
  if (schema !== "auto") args.push("--schema", schema);
  const res = await exec(perfscaleBin(), args);
  return { exitCode: res.exitCode, output: (res.stdout + res.stderr).trim() };
}

export async function getSchema(
  kind: "test" | "config",
  exec: ExecFn = defaultExec,
): Promise<unknown> {
  const res = await exec(perfscaleBin(), ["schema", kind]);
  if (res.exitCode !== 0) {
    throw new Error(
      `perfscale schema ${kind} failed (exit ${res.exitCode}): ${res.stderr.trim()}. ` +
        "Requires perfscale >= 0.5 — run `perfscale self-update`.",
    );
  }
  return JSON.parse(res.stdout);
}
