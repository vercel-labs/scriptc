// Coverage lowers a program with the island set a build uses, and decides it
// the way a build does: round by round, from what each lowering saw
// (frontend/analysis.ts, node-islands/decide.ts and growth.ts). For a while
// the analysis also seeded its set from the module graph alone, a value
// import of an installed package the first load did not put in the program,
// which a build did not do; the two then named different islands (a package
// a build carries inside another island was an island of its own in the
// report). These tests pin that the graph alone islands nothing in the
// analysis, with a stubbed island scan, and what the scan says a load is:
// the facts a decision made before lowering, for a build and the analysis
// alike, would read.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { analyzeWithFrontend } from "../src/frontend/analysis.js";
import { runFrontend, type FrontendFactory } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";
import type { NodeIslandOptions } from "../src/node-islands/policy.js";
import type { NodeIslandScan } from "../src/node-islands/scan.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

/** A program that imports one package's values, plus a second installed
 * package it never imports. */
function program(): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-coverage-islands-"));
  scratch.push(dir);
  writePackage(
    dir,
    "outerpkg",
    "module.exports.double = function (n) { return n * 2; };\n",
    "export declare function double(n: number): number;\n",
  );
  writePackage(
    dir,
    "innerpkg",
    "module.exports.half = function (n) { return n / 2; };\n",
    "export declare function half(n: number): number;\n",
  );
  writeFileSync(
    join(dir, "main.ts"),
    'import { double } from "outerpkg";\nconsole.log(double(2));\n',
  );
  return dir;
}

/** A program importing `outerpkg`, plus the packages named `[js, d.ts]` and
 * whatever they require. */
function pkgs(spec: Record<string, [string, string]>): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-coverage-islands-"));
  scratch.push(dir);
  for (const name of Object.keys(spec)) {
    const pair = spec[name]!;
    writePackage(dir, name, pair[0], pair[1]);
  }
  writeFileSync(
    join(dir, "main.ts"),
    'import { double } from "outerpkg";\nconsole.log(double(2));\n',
  );
  return dir;
}

/** The scan the analysis should see, with one package edge the program's real
 * module graph does not hold: the shape a package the first load did not
 * compile presents to the analysis. */
function scanWith(dir: string, pkg: string, loads = true): NodeIslandScan {
  const fromFile = join(dir, "main.ts");
  const toDir = join(dir, "node_modules", pkg);
  return {
    modules: [],
    edges: [
      {
        fromFile,
        fromDir: null,
        to: pkg,
        toDir,
        shim: false,
        loads,
        loc: { file: fromFile, start: 0, end: 1 },
      },
    ],
    refusals: [],
  };
}

function run(
  dir: string,
  nodeIslands: NodeIslandOptions,
  scan: NodeIslandScan | null,
): { lowerings: number; reloads: number; scans: number; sets: (string[] | null)[] } {
  let reloads = 0;
  let lowerings = 0;
  let scans = 0;
  const sets: (string[] | null)[] = [];
  const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) => {
    if (options?.islandPackages !== undefined || options?.islandModules !== undefined) reloads++;
    const fe = runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
    if (scan !== null) fe.nodeIslandScan = () => scan;
    const scanIslands = fe.nodeIslandScan;
    if (scanIslands !== undefined)
      fe.nodeIslandScan = (opts) => {
        scans++;
        return scanIslands(opts);
      };
    const lower = fe.lower;
    fe.lower = (lowerOpts, valid) => {
      lowerings++;
      sets.push(
        lowerOpts.nodeIslands === undefined
          ? null
          : [...lowerOpts.nodeIslands.packages.keys()].sort(),
      );
      return lower.call(fe, lowerOpts, valid);
    };
    return fe;
  };
  analyzeWithFrontend(join(dir, "main.ts"), { nodeIslands }, process.platform, factory);
  return { lowerings, reloads, scans, sets };
}

test("a package edge of the graph alone islands nothing, as in a build", () => {
  // The scan holds an edge to a package the program never imports. A build
  // islands a package for what its load or its lowering refuses, and this
  // program refuses nothing, so the analysis lowers it once with no island
  // and reloads nothing.
  const dir = program();
  for (const loads of [true, false]) {
    const counts = run(dir, { mode: "auto" }, scanWith(dir, "innerpkg", loads));
    expect(counts.lowerings).toBe(1);
    expect(counts.reloads).toBe(0);
    expect(counts.sets).toEqual([null]);
  }
}, 600_000);

test("--node-islands=off decides nothing", () => {
  const dir = program();
  const counts = run(dir, { mode: "off" }, scanWith(dir, "innerpkg"));
  expect(counts.lowerings).toBe(1);
  expect(counts.sets).toEqual([null]);
}, 600_000);

test("a require() a source binding shadows loads nothing", () => {
  // A parameter or a variable the file declares under the name `require`
  // shadows Node's loader: the call runs that value, so the package it names
  // never loads, and the scan names no package for it (node-islands/scan.ts).
  const dir = pkgs({
    outerpkg: [
      "module.exports.double = function (n) { return n * 2; };\n",
      "export declare function double(n: number): number;\n",
    ],
    shadowpkg: [
      "module.exports.half = function (n) { return n / 2; };\n",
      "export declare function half(n: number): number;\n",
    ],
  });
  writeFileSync(
    join(dir, "main.ts"),
    'import { double } from "outerpkg";\nfunction load(require: (spec: string) => number): number {\n  return require("shadowpkg");\n}\nconsole.log(double(2) + load(() => 0));\n',
  );
  // The scan names no package for the shadowed call.
  const fe = runFrontend(join(dir, "main.ts"), loadProgram, undefined, undefined, undefined, {
    nodeIslands: true,
  });
  try {
    expect(fe.nodeIslandScan).toBeDefined();
    const scan = fe.nodeIslandScan!({ userJs: false });
    expect(scan.edges.map((e) => e.to)).not.toContain("shadowpkg");
  } finally {
    fe.dispose();
  }
  // The analysis lowers once, with no island for it.
  const counts = run(dir, { mode: "auto" }, null);
  expect(counts.lowerings).toBe(1);
  expect(counts.sets).toEqual([null]);
}, 600_000);

test("a createRequire() binding is a loader, at the top level and below it", () => {
  // The binding is the file's own variable, but createRequire() made it a
  // loader: `const up = require("upperpkg")` loads upperpkg whenever the
  // module evaluates, and the same call in a function body loads it when
  // that code runs. Only a binding no loader made (a parameter, a plain
  // variable, an import) names nothing.
  const dir = pkgs({
    outerpkg: [
      "module.exports.double = function (n) { return n * 2; };\n",
      "export declare function double(n: number): number;\n",
    ],
    upperpkg: [
      "module.exports.twice = function (n) { return n * 2; };\n",
      "export declare function twice(n: number): number;\n",
    ],
    latepkg: [
      "module.exports.half = function (n) { return n / 2; };\n",
      "export declare function half(n: number): number;\n",
    ],
  });
  writeFileSync(
    join(dir, "main.mjs"),
    'import { createRequire } from "node:module";\nimport { double } from "outerpkg";\nconst require = createRequire(import.meta.url);\nconst up = require("upperpkg");\nfunction later() { return require("latepkg"); }\nconsole.log(double(2) + up.twice(1) + later() * 0);\n',
  );
  const fe = runFrontend(join(dir, "main.mjs"), loadProgram, undefined, undefined, undefined, {
    nodeIslands: true,
  });
  try {
    expect(fe.nodeIslandScan).toBeDefined();
    const scan = fe.nodeIslandScan!({ userJs: false });
    const loads = new Map(scan.edges.map((e) => [e.to, e.loads]));
    expect(loads.get("upperpkg")).toBe(true);
    expect(loads.get("latepkg")).toBe(false);
  } finally {
    fe.dispose();
  }
}, 600_000);

test("a top-level require() is a load, one inside a function is not", () => {
  // The graph proves a package only when the importing module loads it
  // whenever it evaluates: `const up = require("upperpkg")` at a module's
  // top level runs on evaluation (the declaration and its statement are part
  // of the chain), a require() inside a function body does not. pi's
  // discovery refusals are all the first shape.
  const dir = pkgs({
    outerpkg: [
      'var up = require("upperpkg");\nfunction later() { return require("latepkg"); }\nmodule.exports.double = function (n) { return up.twice(n) + later() * 0; };\n',
      "export declare function double(n: number): number;\n",
    ],
    upperpkg: [
      "module.exports.twice = function (n) { return n * 2; };\n",
      "export declare function twice(n: number): number;\n",
    ],
    latepkg: [
      "module.exports.half = function (n) { return n / 2; };\n",
      "export declare function half(n: number): number;\n",
    ],
  });
  const fe = runFrontend(join(dir, "main.ts"), loadProgram, undefined, undefined, undefined, {
    nodeIslands: true,
  });
  try {
    expect(fe.nodeIslandScan).toBeDefined();
    const scan = fe.nodeIslandScan!({ userJs: false });
    const loads = new Map(scan.edges.map((e) => [e.to, e.loads]));
    expect(loads.get("upperpkg")).toBe(true);
    expect(loads.get("latepkg")).toBe(false);
  } finally {
    fe.dispose();
  }
}, 600_000);
