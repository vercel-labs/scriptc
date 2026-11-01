// The packages a build runs in Node islands because their implementation is
// not in the program are decided from the module graph before the first
// lowering (retry-round analysis, Option A): that lowering then already uses
// them, so a build pays one lowering instead of a discovery round plus a
// retry. Only the lowering can see the rest (a package the program holds
// that refuses to compile), so the retry decision stays.
//
// The white-box tests pin the graph decision's rule; the corpus test compiles
// 6829's island fixture with the internal switch on and off and requires one
// result from both, and the last test compiles a program whose only use of an
// installed package is a require() that never runs.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { outsideGraphIslands } from "../src/node-islands/graph-islands.js";
import type { IslandModule, IslandPackage } from "../src/node-islands/boundary.js";
import type { NodeIslandPolicy } from "../src/node-islands/policy.js";
import type { NodeIslandScan, PackageEdge, ScannedModule } from "../src/node-islands/scan.js";
import { prepareExecutableModule } from "../src/executable/prepare.js";
import { runFrontend, type FrontendFactory } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";

const policy: NodeIslandPolicy = {
  mode: "auto",
  modeSource: "default",
  forcedNode: new Map(),
  forcedNative: new Map(),
  unloaded: new Set(),
  userModules: [],
  node: null,
  strictUserJs: false,
};

function userModule(file: string): ScannedModule {
  return {
    file,
    origin: "user",
    packageDir: null,
    packageName: null,
    markers: [],
    cjsReads: [],
    stripProblem: null,
    dropped: false,
  };
}

function npmModule(file: string, dir: string): ScannedModule {
  return {
    file,
    origin: "npm",
    packageDir: dir,
    packageName: dir.slice(dir.lastIndexOf("/") + 1),
    markers: [],
    cjsReads: [],
    stripProblem: null,
    dropped: false,
  };
}

function edge(
  fromFile: string,
  fromDir: string | null,
  to: string,
  toDir: string | null,
  shim = false,
  loads = true,
): PackageEdge {
  return { fromDir, fromFile, to, toDir, shim, loads, loc: { file: fromFile, start: 0, end: 0 } };
}

function scanOf(modules: ScannedModule[], edges: PackageEdge[]): NodeIslandScan {
  return { modules, edges, refusals: [] };
}

test("the graph proves an island for an installed package the program does not hold", () => {
  const scan = scanOf(
    [
      userModule("/app/src/main.ts"),
      npmModule("/app/node_modules/compiled/index.js", "/app/node_modules/compiled"),
    ],
    [
      edge("/app/src/main.ts", null, "typed", "/app/node_modules/typed"),
      // Its implementation joined the program: the lowering's to compile.
      edge("/app/src/main.ts", null, "compiled", "/app/node_modules/compiled"),
      // A registry shim or builtin alias ships no JavaScript to run.
      edge("/app/src/main.ts", null, "aliased", null, true),
    ],
  );
  const grown = outsideGraphIslands(policy, [], scan, new Map(), new Map());
  expect(grown === null ? null : [...grown.keys()]).toEqual(["typed"]);
  const island = grown!.get("typed")!;
  expect(island.dir).toBe("/app/node_modules/typed");
  expect(island.class).toBe("packaging");
  // The reason the lowering's SC2013 carries at the import site, so the
  // SC8001 note reads the same whether the graph or a retry decided it.
  expect(island.reason).toBe(
    "SC2013: cannot compile npm package 'typed' statically: its implementation is not part of the compiled module graph",
  );
});

test("the decision proves nothing a lazy edge loads", () => {
  // A require() inside a function or a dynamic import() loads its package only
  // when that code runs: a program that never runs it must not get an island.
  const scan = scanOf(
    [userModule("/app/src/main.ts")],
    [
      edge("/app/src/main.ts", null, "lazy", "/app/node_modules/lazy", false, false),
      edge("/app/src/main.ts", null, "loaded", "/app/node_modules/loaded"),
    ],
  );
  const grown = outsideGraphIslands(policy, [], scan, new Map(), new Map());
  expect(grown === null ? null : [...grown.keys()]).toEqual(["loaded"]);
});

test("the decision adds nothing an island loads, a round grew, or the policy pins", () => {
  const islandPackage: IslandPackage = {
    name: "islandpkg",
    version: null,
    dir: "/app/island",
    class: "packaging",
    reason: "r",
  };
  const islandModule: IslandModule = {
    file: "/app/module.mjs",
    class: "object-model",
    reason: "r",
    decision: "auto",
  };
  const pinned: NodeIslandPolicy = {
    ...policy,
    forcedNative: new Map([["pinned", "config"]]),
    unloaded: new Set(["unloaded"]),
  };
  const scan = scanOf(
    [userModule("/app/src/main.ts")],
    [
      edge("/app/src/main.ts", null, "grew", "/app/node_modules/grew"),
      edge("/app/src/main.ts", null, "pinned", "/app/node_modules/pinned"),
      edge("/app/src/main.ts", null, "unloaded", "/app/node_modules/unloaded"),
      // An island module's own imports load in Node: nothing to decide.
      edge("/app/module.mjs", null, "fromModule", "/app/node_modules/frommodule"),
      // A package already islanded imports in Node too.
      edge("/app/island/other.js", "/app/island", "fromIsland", "/app/node_modules/fromisland"),
    ],
  );
  const grown = outsideGraphIslands(
    pinned,
    [],
    scan,
    new Map([[islandModule.file, islandModule]]),
    new Map([
      ["islandpkg", islandPackage],
      ["grew", islandPackage],
    ]),
  );
  expect(grown).toBeNull();
});

test("the graph decides nothing under an explicit policy or over the retry's budget", () => {
  const scan = scanOf(
    [userModule("/app/src/main.ts")],
    [edge("/app/src/main.ts", null, "typed", "/app/node_modules/typed")],
  );
  expect(outsideGraphIslands({ ...policy, mode: "explicit" }, [], scan, new Map(), new Map())).toBe(
    null,
  );
  // The retry grows at most 16 packages (loweringIslands); a graph that
  // proves more stays the discovery round it is today.
  const many = scanOf(
    [userModule("/app/src/main.ts")],
    Array.from({ length: 17 }, (_, i) =>
      edge("/app/src/main.ts", null, `pkg-${i}`, `/app/node_modules/pkg-${i}`),
    ),
  );
  expect(outsideGraphIslands(policy, [], many, new Map(), new Map())).toBeNull();
});

const repoRoot = join(import.meta.dirname, "../../..");
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function build(preDerive: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-graph-"));
  scratch.push(dir);
  cpSync(
    join(repoRoot, "tests/corpus/6829-node-island-declared-types/node_modules"),
    join(dir, "node_modules"),
    { recursive: true },
  );
  writeFileSync(
    join(dir, "main.ts"),
    [
      'import { Arr, Num, check } from "schemakit";',
      "const [lo, hi] = [1, 4];",
      'console.log(check(Arr(Num()), [lo, hi]) ? "in range" : "out of range");',
      "",
    ].join("\n"),
  );
  let firstLoads = 0;
  let reloads = 0;
  let lowerings = 0;
  const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) => {
    if (options?.islandPackages === undefined && options?.islandModules === undefined) firstLoads++;
    else reloads++;
    const fe = runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
    const lower = fe.lower;
    fe.lower = (lowerOpts, valid) => {
      lowerings++;
      return lower.call(fe, lowerOpts, valid);
    };
    return fe;
  };
  const result = prepareExecutableModule(
    join(dir, "main.ts"),
    { outPath: join(dir, "main"), outDir: dir },
    null,
    process.platform,
    factory,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { preDeriveIslands: preDerive },
  );
  // Paths differ per temp dir: compare diagnostics and IR with the
  // directory replaced everywhere it appears (loc.file, message frames).
  const normalized = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).split(dir).join("<dir>"));
  return {
    ok: result.ok,
    diagnostics: normalized(result.ok ? [] : result.diagnostics),
    ir: result.ok ? JSON.stringify(normalized(result.mod)) : null,
    firstLoads,
    reloads,
    lowerings,
  };
}

test("the graph decision compiles the discovery round's island one lowering earlier", () => {
  const off = build(false);
  const on = build(true);
  expect(off.ok).toBe(true);
  expect(on.ok).toBe(true);
  // Same program either way: the graph only decides it earlier.
  expect(on.diagnostics).toEqual(off.diagnostics);
  expect(on.ir).toEqual(off.ir);
  expect(on.lowerings).toBeLessThanOrEqual(off.lowerings);
  expect(on.firstLoads).toBeLessThanOrEqual(off.firstLoads);
  expect(on.reloads).toBe(off.reloads);
}, 600_000);

// An installed package whose only use is a require() that never runs — a
// shadowed binding, or a call inside a function nothing calls — is not a
// package the program loads. Islanding it would refuse a program that
// replaces process.stdout.write (SC8020) over a package it never touches.
function writePackage(dir: string, name: string, js: string, dts: string): void {
  const root = join(dir, "node_modules", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js", types: "index.d.ts" }),
  );
  writeFileSync(join(root, "index.js"), js);
  writeFileSync(join(root, "index.d.ts"), dts);
}

function buildStdoutPatchProgram(lazyUse: string, okJs?: string) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-graph-lazy-"));
  scratch.push(dir);
  // A package the program compiles, so the scan collects package edges.
  writePackage(
    dir,
    "okpkg",
    okJs ?? "module.exports.add = function (a, b) { return a + b; };\n",
    "export declare function add(a: number, b: number): number;\n",
  );
  // One the program only names in code that never runs.
  writePackage(
    dir,
    "lazypkg",
    "module.exports.thing = 1;\n",
    "export declare const thing: number;\n",
  );
  writeFileSync(
    join(dir, "main.ts"),
    [
      'import { add } from "okpkg";',
      "const original = process.stdout.write.bind(process.stdout);",
      "process.stdout.write = ((chunk: string) => {",
      "  original(chunk);",
      "  return true;",
      "}) as typeof process.stdout.write;",
      lazyUse,
      "console.log(add(1, 2));",
      "",
    ].join("\n"),
  );
  const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) =>
    runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
  return prepareExecutableModule(
    join(dir, "main.ts"),
    { outPath: join(dir, "main"), outDir: dir },
    null,
    process.platform,
    factory,
  );
}

test("a require() that never runs decides no island", () => {
  const shadowed = buildStdoutPatchProgram(
    "export function load(require: (spec: string) => unknown): unknown { return require('lazypkg'); }",
  );
  expect(shadowed.ok ? [] : shadowed.diagnostics.map((d) => d.code)).toEqual([]);
  const uncalled = buildStdoutPatchProgram(
    "export function loadAny(): unknown { return require('lazypkg'); }",
  );
  expect(uncalled.ok ? [] : uncalled.diagnostics.map((d) => d.code)).toEqual([]);
  // An expression-bodied arrow the program hands to a call as a callback: its
  // require() sits in an expression, but the arrow runs only when something
  // calls it. A package file holds it because a user TypeScript module's own
  // require() has no lowering.
  const callback = buildStdoutPatchProgram(
    "",
    [
      "module.exports.add = function (a, b) { return a + b; };",
      "function keep(f) { return f; }",
      "keep(() => require('lazypkg'));",
      "",
    ].join("\n"),
  );
  expect(callback.ok ? [] : callback.diagnostics.map((d) => d.code)).toEqual([]);
}, 600_000);

test("an arrow called where it is written still decides its island", () => {
  // The callback rule stops the walk at an arrow the module hands over; one
  // the module invokes right there loads its package with the module, so the
  // graph proves the island and the stream patch is SC8020 as before.
  const called = buildStdoutPatchProgram(
    "",
    [
      "module.exports.add = function (a, b) { return a + b; };",
      "(() => require('lazypkg'))();",
      "",
    ].join("\n"),
  );
  expect(called.ok ? [] : called.diagnostics.map((d) => d.code)).toEqual(["SC8020"]);
}, 600_000);
