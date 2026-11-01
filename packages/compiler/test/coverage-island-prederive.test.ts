// Coverage lowers a program with the island set a build would use, and it used
// to learn that set the way a build did: a discovery lowering, reload of the
// frontend with the packages the discovery refused, then a second lowering of
// the whole program (frontend/analysis.ts's grownIslands retry). On a large
// program that retry is the whole cost of the analysis — on pi the discovery
// lowering and the retry lowering are ~35 min each.
//
// A value import of an installed package whose implementation the first load
// did not put in the program is exactly the SC2013 refusal the discovery
// lowering reports, so the module graph proves it before any lowering runs
// (node-islands/graph-islands.ts). These tests pin the analysis side of that
// decision with a stubbed island scan: the first lowering already carries the
// proven island, the analysis reloads nothing, and it scans the program once.
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

test("coverage lowers once, with the island the module graph proves", () => {
  const dir = program();
  const counts = run(dir, { mode: "auto" }, scanWith(dir, "innerpkg"));
  expect(counts.lowerings).toBe(1);
  expect(counts.reloads).toBe(0);
  // One scan answers every island question: the lowering set, the graph
  // proof, and the final report.
  expect(counts.scans).toBe(1);
  expect(counts.sets).toEqual([["innerpkg"]]);
}, 600_000);

test("a require() the analysis lowers decides its island too", () => {
  // A require() in a function body or under a condition loads its package
  // only when that code runs, so a build leaves it to its retry. The analysis
  // lowers that site either way, so the same refusal is due and the discovery
  // lowering carries the island (node-islands/graph-islands.ts's `deferred`).
  const dir = program();
  const counts = run(dir, { mode: "auto" }, scanWith(dir, "innerpkg", false));
  expect(counts.lowerings).toBe(1);
  expect(counts.sets).toEqual([["innerpkg"]]);
}, 600_000);

test("the graph decision leaves --node-islands=off alone", () => {
  const dir = program();
  const counts = run(dir, { mode: "off" }, scanWith(dir, "innerpkg"));
  expect(counts.lowerings).toBe(1);
  expect(counts.sets).toEqual([null]);
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
