import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { IrModule } from "../ir/ir.js";
import { finalizeDeferredIslands, probeHostDirectory, type ProbeOutput } from "./snapshot.js";

const saved = { ...process.env };
const made: string[] = [];
afterEach(() => {
  for (const key of ["SCRIPTC_CACHE_DIR", "SCRIPTC_NO_CACHE"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-probe-dir-")));
  made.push(dir);
  return dir;
}

function probeDir(hash: string): { dir: string; kept: boolean } {
  const result = probeHostDirectory(hash);
  if (!result.kept) made.push(result.dir);
  return result;
}

describe.skipIf(process.platform === "win32")("the probe host's directory", () => {
  test("is kept in the user's private build cache", () => {
    const cache = scratch();
    process.env["SCRIPTC_CACHE_DIR"] = cache;
    const { dir, kept } = probeDir("0123456789abcdef");
    expect(kept).toBe(true);
    expect(dir).toBe(join(cache, "node-island-probe", "0123456789abcdef"));
    expect(statSync(dir).mode & 0o077).toBe(0);
  });

  test("never comes from a cache another user can write", () => {
    const cache = scratch();
    chmodSync(cache, 0o777);
    process.env["SCRIPTC_CACHE_DIR"] = cache;
    const { dir, kept } = probeDir("0123456789abcdef");
    expect(kept).toBe(false);
    expect(dir.startsWith(cache)).toBe(false);
    expect(statSync(dir).mode & 0o077).toBe(0);
    // A second probe gets its own directory: nothing is reused.
    expect(probeDir("0123456789abcdef").dir).not.toBe(dir);
  });

  test("is a fresh private directory without a build cache", () => {
    process.env["SCRIPTC_NO_CACHE"] = "1";
    const { dir, kept } = probeDir("0123456789abcdef");
    expect(kept).toBe(false);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });
});

/** A project whose entry imports the island module `dep` (one deferred
 * island load), and a stand-in for the probe whose recorded load of the
 * module read `env` and exported `{ url }`. */
function deferredProject(scriptc: unknown, env: [string, string | null][], url: string) {
  const root = scratch();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", scriptc }));
  const file = join(root, "node_modules", "dep", "index.js");
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "package.json"), '{ "name": "dep" }');
  writeFileSync(file, "module.exports = { url: process.env.DB_URL };\n");
  const call = {
    kind: "libCall",
    fn: "nodeIsland.defer",
    args: [
      { kind: "strLit", value: file },
      { kind: "strLit", value: "" },
    ],
  };
  const mod = { functions: [{ body: [call] }], globals: [] } as unknown as IrModule;
  const probe: ProbeOutput = {
    results: [
      {
        path: file,
        root: 1,
        inputs: [],
        volatile: [],
        effects: [],
        mutations: [],
        env,
        tty: [],
        files: [file],
      },
    ],
    objects: { "1": { f: 0, p: false, m: [["url", { s: url }]] } },
  };
  const decisions = finalizeDeferredIslands(mod, join(root, "main.ts"), root, () => probe);
  return { decisions, call, text: JSON.stringify(mod) };
}

describe("environment boot guards", () => {
  test("a load that read a variable outside publicEnv stays eager and records no value", () => {
    const secret = "postgres://admin:hunter2@db.internal/prod";
    const { decisions, call, text } = deferredProject({}, [["DB_URL", secret]], secret);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.deferred).toBe(false);
    expect(decisions[0]!.reason).toContain("DB_URL");
    expect(call.fn).toBe("nodeIsland.require");
    expect(text).not.toContain("hunter2");
  });

  test('"evaluate": "lazy" does not record a variable outside publicEnv', () => {
    const secret = "sk-live-0123456789";
    const { decisions, text } = deferredProject(
      { packages: { dep: { evaluate: "lazy" } } },
      [["API_KEY", secret]],
      "https://api.example.com",
    );
    expect(decisions[0]!.deferred).toBe(false);
    expect(text).not.toContain(secret);
  });

  test("a load that read only publicEnv variables defers, guarded by their values", () => {
    const { decisions, call, text } = deferredProject(
      { nodeIslands: { publicEnv: ["NODE_ENV"] } },
      [["NODE_ENV", "production"]],
      "https://example.com",
    );
    expect(decisions[0]!.deferred).toBe(true);
    expect(call.fn).toBe("nodeIsland.defer");
    expect(text).toContain("E 8:NODE_ENV 1 10:production");
  });
});
