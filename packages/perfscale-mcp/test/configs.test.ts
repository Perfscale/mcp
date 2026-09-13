import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classify,
  listConfigs,
  readConfig,
  removeConfig,
  writeYaml,
} from "../src/configs.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "perfscale-mcp-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("classify", () => {
  it("detects test definitions by top-level steps", () => {
    expect(classify("steps:\n  - use: std/http@v1\n")).toBe("test");
  });
  it("treats other mappings as configs", () => {
    expect(classify("vus: 10\nduration: 30s\n")).toBe("config");
  });
  it("flags non-mapping YAML as invalid", () => {
    expect(classify("- just\n- a list\n")).toBe("invalid");
    expect(classify(": : :")).toBe("invalid");
  });
  it("flags scalar and empty YAML as invalid", () => {
    expect(classify("just a string")).toBe("invalid");
    expect(classify("42")).toBe("invalid");
    expect(classify("")).toBe("invalid");
  });
});

describe("listConfigs", () => {
  it("recursively finds and classifies yaml files", async () => {
    await writeFile(join(dir, "test.yaml"), "steps:\n  - use: std/http@v1\n");
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "load.yml"), "vus: 5\n");
    await writeFile(join(dir, "ignore.txt"), "not yaml");

    const entries = await listConfigs(dir);
    const kinds = Object.fromEntries(entries.map((e) => [e.path.split("/").pop(), e.kind]));
    expect(entries).toHaveLength(2);
    expect(kinds["test.yaml"]).toBe("test");
    expect(kinds["load.yml"]).toBe("config");
  });

  it("rejects non-directories", async () => {
    const f = join(dir, "x.yaml");
    await writeFile(f, "a: 1\n");
    await expect(listConfigs(f)).rejects.toThrow(/Not a directory/);
  });

  it("skips dotfiles, dot-directories, and node_modules", async () => {
    await writeFile(join(dir, ".hidden.yaml"), "vus: 1\n");
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "hooks.yaml"), "vus: 1\n");
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "node_modules", "dep.yaml"), "vus: 1\n");
    await writeFile(join(dir, "visible.yaml"), "vus: 1\n");

    const entries = await listConfigs(dir);
    expect(entries.map((e) => e.path.split("/").pop())).toEqual(["visible.yaml"]);
  });
});

describe("writeYaml / readConfig / removeConfig", () => {
  it("writes and reads back yaml", async () => {
    const p = join(dir, "cfg.yaml");
    await writeYaml(p, "vus: 10\n");
    expect(await readConfig(p)).toBe("vus: 10\n");
  });

  it("update semantics require the file to exist", async () => {
    const p = join(dir, "cfg.yaml");
    await expect(writeYaml(p, "vus: 10\n", true)).rejects.toThrow(/does not exist/);
    await writeYaml(p, "vus: 10\n");
    await writeYaml(p, "vus: 20\n", true);
    expect(await readConfig(p)).toBe("vus: 20\n");
  });

  it("rejects invalid yaml content", async () => {
    await expect(writeYaml(join(dir, "bad.yaml"), "- a list\n")).rejects.toThrow(/mapping/);
  });

  it("rejects non-yaml extensions everywhere", async () => {
    await expect(writeYaml(join(dir, "x.txt"), "a: 1\n")).rejects.toThrow(/Not a YAML/);
    await expect(readConfig(join(dir, "x.js"))).rejects.toThrow(/Not a YAML/);
    await expect(removeConfig(join(dir, "x.sh"))).rejects.toThrow(/Not a YAML/);
  });

  it("accepts uppercase .YAML/.YML extensions", async () => {
    const p = join(dir, "SUITE.YAML");
    await writeYaml(p, "vus: 10\n");
    expect(await readConfig(p)).toBe("vus: 10\n");
    await writeYaml(join(dir, "other.YML"), "vus: 5\n");
  });

  it("removes files", async () => {
    const p = join(dir, "cfg.yaml");
    await writeYaml(p, "vus: 10\n");
    await removeConfig(p);
    await expect(readConfig(p)).rejects.toThrow();
  });
});
