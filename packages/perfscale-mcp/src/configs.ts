/**
 * Local test/config YAML management for the OSS MCP server.
 * Classification mirrors perfscale-core's lint::detect_kind: a top-level
 * `steps:` key means a test definition, anything else is a run config.
 */

import { readdir, readFile, stat, unlink, writeFile, access } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { parse as parseYaml } from "yaml";

export type DocKind = "test" | "config" | "invalid";

export interface ConfigEntry {
  path: string;
  kind: DocKind;
}

export function classify(content: string): DocKind {
  try {
    const doc = parseYaml(content);
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return "invalid";
    return "steps" in doc ? "test" : "config";
  } catch {
    return "invalid";
  }
}

const YAML_EXTS = new Set([".yaml", ".yml"]);

export function assertYamlPath(path: string): void {
  if (!YAML_EXTS.has(extname(path).toLowerCase())) {
    throw new Error(`Not a YAML file: ${path} (expected .yaml or .yml)`);
  }
}

/** Recursively list YAML files under `dir`, classified as test/config. */
export async function listConfigs(dir: string): Promise<ConfigEntry[]> {
  const root = resolve(dir);
  const out: ConfigEntry[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(current, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (YAML_EXTS.has(extname(e.name).toLowerCase())) {
        const content = await readFile(full, "utf8");
        out.push({ path: full, kind: classify(content) });
      }
    }
  }

  const st = await stat(root);
  if (!st.isDirectory()) throw new Error(`Not a directory: ${dir}`);
  await walk(root);
  return out;
}

export async function readConfig(path: string): Promise<string> {
  assertYamlPath(path);
  return readFile(path, "utf8");
}

/** Write a YAML file. With mustExist, fails when the file is absent (update semantics). */
export async function writeYaml(path: string, content: string, mustExist = false): Promise<void> {
  assertYamlPath(path);
  if (classify(content) === "invalid") {
    throw new Error("Content is not a valid YAML mapping");
  }
  if (mustExist) {
    try {
      await access(path);
    } catch {
      throw new Error(`File does not exist: ${path} (use write_test/write_config to create)`);
    }
  }
  await writeFile(path, content, "utf8");
}

export async function removeConfig(path: string): Promise<void> {
  assertYamlPath(path);
  await unlink(path);
}
