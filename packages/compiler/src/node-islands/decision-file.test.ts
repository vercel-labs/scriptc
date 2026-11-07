import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { emptyProjectConfig } from "../project-config.js";
import type { IslandModule, IslandPackage } from "./boundary.js";
import {
  islandDecisionDigest,
  islandDecisionKey,
  readIslandDecision,
  serializeIslandDecision,
  writeIslandDecision,
  type IslandRoundState,
} from "./decision-file.js";
import { nodeIslandPolicy, type NodeIslandOptions } from "./policy.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A project with two installed packages and one user module. */
function project(): { dir: string; entry: string; file: string; state: IslandRoundState } {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-decision-"));
  scratch.push(dir);
  const install = (name: string, version: string): IslandPackage => {
    const at = join(dir, "node_modules", name);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "package.json"), JSON.stringify({ name, version }));
    return {
      name,
      version,
      dir: at.split("\\").join("/"),
      class: "gap",
      reason: `SC1090: ${name} refused`,
    };
  };
  const sdk = install("sdk", "1.2.3");
  const cfg = install("@scope/cfg", "0.1.0");
  mkdirSync(join(dir, "src"), { recursive: true });
  const entry = join(dir, "src", "main.ts");
  writeFileSync(entry, "export {};\n");
  const legacy = join(dir, "src", "legacy.js").split("\\").join("/");
  writeFileSync(legacy, "with ({}) {}\n");
  const module: IslandModule = {
    file: legacy,
    class: "object-model",
    reason: "R2.4 sloppy-mode semantics: a 'with' statement",
    decision: "auto",
  };
  return {
    dir,
    entry,
    file: join(dir, "islands.json"),
    state: {
      packages: new Map([
        [sdk.name, sdk],
        [cfg.name, cfg],
      ]),
      modules: new Map([[module.file, module]]),
      retryFences: false,
    },
  };
}

function policyOf(options: NodeIslandOptions = {}) {
  return nodeIslandPolicy(emptyProjectConfig(), options);
}

const KEY = islandDecisionKey(undefined, undefined, "linux");

test("a recorded decision reads back as the round state it was written from", () => {
  const p = project();
  expect(writeIslandDecision(p.file, p.entry, KEY, policyOf(), p.state)).toBe(true);
  const read = readIslandDecision(p.file, p.entry, KEY, policyOf());
  expect(read).not.toBeNull();
  expect([...read!.packages.values()]).toEqual([...p.state.packages.values()].reverse());
  expect([...read!.modules.values()]).toEqual([...p.state.modules.values()]);
  expect(read!.retryFences).toBe(false);
  // The same decision is the same bytes, so a second write leaves the file.
  expect(writeIslandDecision(p.file, p.entry, KEY, policyOf(), read!)).toBe(false);
});

test("the file spells paths relative to its own directory", () => {
  const p = project();
  const text = serializeIslandDecision(p.file, p.entry, KEY, p.state);
  expect(text).not.toContain(p.dir);
  const parsed = JSON.parse(text) as {
    entry: string;
    packages: { name: string; dir: string }[];
    modules: { file: string }[];
  };
  expect(parsed.entry).toBe("src/main.ts");
  expect(parsed.packages.map((x) => [x.name, x.dir])).toEqual([
    ["@scope/cfg", "node_modules/@scope/cfg"],
    ["sdk", "node_modules/sdk"],
  ]);
  expect(parsed.modules.map((x) => x.file)).toEqual(["src/legacy.js"]);
});

test("a decision recorded for another entry or policy is not replayed", () => {
  const p = project();
  writeIslandDecision(p.file, p.entry, KEY, policyOf(), p.state);
  expect(readIslandDecision(p.file, join(p.dir, "src", "other.ts"), KEY, policyOf())).toBeNull();
  const other = islandDecisionKey({ islands: ["left-pad"] }, undefined, "linux");
  expect(readIslandDecision(p.file, p.entry, other, policyOf())).toBeNull();
  for (const key of [
    islandDecisionKey(undefined, ["sdk"], "linux"),
    islandDecisionKey(undefined, undefined, "darwin"),
  ])
    expect(readIslandDecision(p.file, p.entry, key, policyOf())).toBeNull();
  // Where the decision is kept is not part of what it was decided under.
  expect(islandDecisionKey({ decision: p.file }, undefined, "linux")).toBe(KEY);
});

test("only the automatic policy keeps or replays a decision", () => {
  const p = project();
  const explicit = policyOf({ mode: "explicit" });
  expect(writeIslandDecision(p.file, p.entry, KEY, explicit, p.state)).toBe(false);
  writeIslandDecision(p.file, p.entry, KEY, policyOf(), p.state);
  expect(readIslandDecision(p.file, p.entry, KEY, explicit)).toBeNull();
  expect(readIslandDecision(p.file, p.entry, KEY, policyOf({ mode: "off" }))).toBeNull();
});

test("an entry that no longer holds is dropped and the fence rules run again", () => {
  const p = project();
  writeIslandDecision(p.file, p.entry, KEY, policyOf(), p.state);
  // A new version of one package: that package is decided again.
  writeFileSync(
    join(p.dir, "node_modules", "sdk", "package.json"),
    JSON.stringify({ name: "sdk", version: "2.0.0" }),
  );
  const bumped = readIslandDecision(p.file, p.entry, KEY, policyOf());
  expect([...bumped!.packages.keys()]).toEqual(["@scope/cfg"]);
  expect(bumped!.modules.size).toBe(1);
  expect(bumped!.retryFences).toBe(true);
  // A package the policy now keeps native, and a module that is gone.
  rmSync(join(p.dir, "src", "legacy.js"));
  const native = readIslandDecision(
    p.file,
    p.entry,
    islandDecisionKey({ native: ["@scope/cfg"] }, undefined, "linux"),
    policyOf({ native: ["@scope/cfg"] }),
  );
  expect(native).toBeNull(); // another policy key
  const gone = readIslandDecision(p.file, p.entry, KEY, policyOf());
  expect(gone!.modules.size).toBe(0);
  rmSync(join(p.dir, "node_modules", "@scope"), { recursive: true });
  const removed = readIslandDecision(p.file, p.entry, KEY, policyOf());
  expect(removed!.packages.size).toBe(0);
  expect(removed!.retryFences).toBe(true);
});

test("a file this compiler does not read is ignored, not an error", () => {
  const p = project();
  expect(readIslandDecision(p.file, p.entry, KEY, policyOf())).toBeNull();
  writeFileSync(p.file, "not json");
  expect(readIslandDecision(p.file, p.entry, KEY, policyOf())).toBeNull();
  const text = serializeIslandDecision(p.file, p.entry, KEY, p.state);
  writeFileSync(p.file, text.replace('"format": 1', '"format": 2'));
  expect(readIslandDecision(p.file, p.entry, KEY, policyOf())).toBeNull();
  writeFileSync(p.file, text.replace('"name": "sdk"', '"name": 7'));
  expect(readIslandDecision(p.file, p.entry, KEY, policyOf())).toBeNull();
  // The next build overwrites it.
  expect(writeIslandDecision(p.file, p.entry, KEY, policyOf(), p.state)).toBe(true);
  expect(readFileSync(p.file, "utf8")).toBe(text);
});

test("the cache key follows the file's bytes", () => {
  const p = project();
  expect(islandDecisionDigest(undefined)).toBe("");
  expect(islandDecisionDigest(p.file)).toBe("#none");
  writeIslandDecision(p.file, p.entry, KEY, policyOf(), p.state);
  const first = islandDecisionDigest(p.file);
  expect(first).toMatch(/^#[0-9a-f]{64}$/);
  writeIslandDecision(p.file, p.entry, KEY, policyOf(), { ...p.state, retryFences: true });
  expect(islandDecisionDigest(p.file)).not.toBe(first);
});
