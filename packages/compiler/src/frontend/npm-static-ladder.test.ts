// The npm-static ladder's per-build memo: one build loads the frontend more
// than once (the island decision reloads it), and every reload re-walks the
// library fixpoint's rungs from the smallest set. These tests pin the two
// halves of that: a rung the build already walked costs no load, and a rung
// whose answer the island set can change is never taken from the memo.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runFrontend, type Frontend, type ProgramLoader } from "./pipeline.js";
import { loadProgramWithServices } from "./program-node.js";
import { createNodeFrontendServices } from "./services-node.js";
import type { FrontendServices } from "./services.js";

const scratch: string[] = [];
const services: FrontendServices[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const created of services.splice(0)) created.close();
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

/** `outerpkg` (opted in) requires `innerpkg` from its own JavaScript, so the
 * library fixpoint needs a second rung to settle the set. `unrelated` is
 * installed and never imported: an island package outside every rung's
 * reach. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-ladder-"));
  scratch.push(dir);
  writePackage(
    dir,
    "outerpkg",
    'const { half } = require("innerpkg");\nmodule.exports.double = function (n) { return half(n) * 4; };\n',
    "export declare function double(n: number): number;\n",
  );
  writePackage(
    dir,
    "innerpkg",
    "module.exports.half = function (n) { return n / 2; };\n",
    "export declare function half(n: number): number;\n",
  );
  writePackage(
    dir,
    "unrelated",
    "module.exports.nothing = function () { return 1; };\n",
    "export declare function nothing(): number;\n",
  );
  writeFileSync(
    join(dir, "main.ts"),
    'import { double } from "outerpkg";\nconsole.log(double(2));\n',
  );
  return dir;
}

/** The entry's `outerpkg` requires `borrowed`, whose declarations come from
 * another package: a plain opt-in refuses it at the declaration bar, while
 * `outerpkg...` opts in the whole closure without that bar. */
function transitiveFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-ladder-"));
  scratch.push(dir);
  writePackage(
    dir,
    "outerpkg",
    'const { half } = require("innerpkg");\nconst twice = require("borrowed");\nmodule.exports.double = function (n) { return half(twice(n)) * 4; };\n',
    "export declare function double(n: number): number;\n",
  );
  writePackage(
    dir,
    "innerpkg",
    "module.exports.half = function (n) { return n / 2; };\n",
    "export declare function half(n: number): number;\n",
  );
  const donor = join(dir, "node_modules", "typesdonor");
  mkdirSync(donor, { recursive: true });
  writeFileSync(
    join(donor, "package.json"),
    JSON.stringify({ name: "typesdonor", version: "1.0.0", types: "index.d.ts" }),
  );
  writeFileSync(
    join(donor, "index.d.ts"),
    "declare function twice(n: number): number;\nexport = twice;\n",
  );
  const root = join(dir, "node_modules", "borrowed");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "borrowed",
      version: "1.0.0",
      main: "index.js",
      types: "../typesdonor/index.d.ts",
    }),
  );
  writeFileSync(join(root, "index.js"), "module.exports = function (n) { return n * 2; };\n");
  writeFileSync(
    join(dir, "main.ts"),
    'import { double } from "outerpkg";\nconsole.log(double(2));\n',
  );
  return dir;
}

interface Run {
  frontend: Frontend;
  /** The npm-static list of every program load, in load order. */
  loaded: string[][];
  /** How often each load's program was asked for its diagnostics. */
  checked: number[];
  /** The same count for the program the tsc gate reads when the load
   * rewrote user files (the declaration-typed boundary), or null when the
   * load has no such program. */
  gateChecked: (number | null)[];
}

function compile(
  dir: string,
  shared: FrontendServices,
  islandPackages: ReadonlySet<string>,
  optIn: readonly string[] = ["outerpkg"],
): Run {
  const loaded: string[][] = [];
  const checked: number[] = [];
  const gateChecked: (number | null)[] = [];
  const loader: ProgramLoader = (path, options) => {
    const index = loaded.length;
    loaded.push([...(options.npmStatic ?? [])]);
    checked.push(0);
    gateChecked.push(null);
    const load = loadProgramWithServices(path, shared, {
      npmStatic: options.npmStatic ?? [],
      externalTypes: options.externalTypes,
    });
    // Every diagnostics request of the tsc gate starts with the program's
    // own diagnostics.
    const program = load.program;
    const programDiagnostics = program.getProgramDiagnostics.bind(program);
    program.getProgramDiagnostics = () => {
      checked[index] = checked[index]! + 1;
      return programDiagnostics();
    };
    const gate = load.tscWorld?.program;
    if (gate !== undefined) {
      gateChecked[index] = 0;
      const gateDiagnostics = gate.getProgramDiagnostics.bind(gate);
      gate.getProgramDiagnostics = () => {
        gateChecked[index] = gateChecked[index]! + 1;
        return gateDiagnostics();
      };
    }
    return load;
  };
  const frontend = runFrontend(join(dir, "main.ts"), loader, "lib", undefined, optIn, {
    islandPackages,
  });
  return { frontend, loaded, checked, gateChecked };
}

function statuses(run: Run): string[] {
  return run.frontend.npmStatic.map((status) => `${status.package}:${status.status}`);
}

test("a reload takes a rung the build already walked without loading it", () => {
  const dir = fixture();
  const shared = createNodeFrontendServices();
  services.push(shared);
  const first = compile(dir, shared, new Set());
  // Scout, then the opted-in set, then the set with the dependency it found.
  expect(first.loaded).toEqual([[], ["outerpkg"], ["outerpkg", "innerpkg"]]);
  expect(statuses(first)).toEqual(["outerpkg:static", "innerpkg:static"]);

  // The island reload: a package no rung consults leaves every answer the
  // same, so the rung `["outerpkg"]` comes from the memo — the reload skips
  // its load and lands on the converged set directly.
  const reload = compile(dir, shared, new Set(["unrelated"]));
  expect(reload.loaded).toEqual([[], ["outerpkg", "innerpkg"]]);
  expect(statuses(reload)).toEqual(statuses(first));
  expect(reload.frontend.npmImportSites).toEqual(first.frontend.npmImportSites);
  first.frontend.dispose();
  reload.frontend.dispose();
});

test("an island package a rung judges is a changed answer, not a memo hit", () => {
  const dir = fixture();
  const shared = createNodeFrontendServices();
  services.push(shared);
  const first = compile(dir, shared, new Set());
  expect(statuses(first)).toEqual(["outerpkg:static", "innerpkg:static"]);

  // `innerpkg` became an island: the fixpoint must not grow it, so the rung
  // `["outerpkg"]` answers differently and the memo may not stand in for it.
  const reload = compile(dir, shared, new Set(["innerpkg"]));
  expect(reload.loaded).toEqual([[], ["outerpkg"]]);
  expect(statuses(reload)).toEqual(["outerpkg:static"]);
  first.frontend.dispose();
  reload.frontend.dispose();
});

test("a `pkg...` selection does not take a rung walked for a plain `pkg`", () => {
  const dir = transitiveFixture();
  const shared = createNodeFrontendServices();
  services.push(shared);
  const plain = compile(dir, shared, new Set());
  expect(statuses(plain)).toEqual(["borrowed:refused", "outerpkg:refused", "innerpkg:static"]);

  // Same services, same entry, same npm-static list: only the trailing `...`
  // differs, and it opts in the package's whole closure — `borrowed` with it.
  // The first frontend's rung refused it, so its answer is no answer for this
  // walk: taken from the memo, the dependency `outerpkg...` asked for would
  // be silently missing.
  const closure = compile(dir, shared, new Set(), ["outerpkg..."]);
  expect(statuses(closure)).toEqual(["outerpkg:static", "innerpkg:static", "borrowed:static"]);
  plain.frontend.dispose();
  closure.frontend.dispose();
});

test("a build without a reload walks every rung once", () => {
  const dir = fixture();
  const shared = createNodeFrontendServices();
  services.push(shared);
  const only = compile(dir, shared, new Set());
  expect(only.loaded).toEqual([[], ["outerpkg"], ["outerpkg", "innerpkg"]]);
  only.frontend.dispose();
});

test("a scout that selects packages is walked for its order and never checked", () => {
  const dir = fixture();
  const shared = createNodeFrontendServices();
  services.push(shared);
  // The scout's program is replaced by the opted-in set's: nothing reads its
  // diagnostics, so nothing asks the checker for them.
  const selecting = compile(dir, shared, new Set());
  expect(selecting.loaded[0]).toEqual([]);
  expect(selecting.checked[0]).toBe(0);
  expect(selecting.frontend.preflight).toEqual([]);
  selecting.frontend.dispose();
});

test("a scout that selects nothing is the frontend's program, diagnostics included", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-ladder-"));
  scratch.push(dir);
  writeFileSync(join(dir, "main.ts"), 'const n: number = "one";\nconsole.log(n);\n');
  const shared = createNodeFrontendServices();
  services.push(shared);
  const plain = compile(dir, shared, new Set(), []);
  // One load: the scout is retained, and its type error is reported.
  expect(plain.loaded).toEqual([[]]);
  expect(plain.checked[0]).toBeGreaterThan(0);
  expect(plain.frontend.preflight.map((d) => d.code)).toEqual(["SC0001"]);
  plain.frontend.dispose();
});

test("a rung nobody reports on never asks the tsc gate's program for diagnostics", () => {
  // `outerpkg` declares a data shape its JavaScript only produces through
  // JSON.parse, so every load that compiles it rewrites main.ts at the
  // declaration-typed boundary and keeps the program as written for the tsc
  // gate. The first rung selects `innerpkg` and is replaced; only the
  // converged rung's report is read.
  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-ladder-"));
  scratch.push(dir);
  writePackage(
    dir,
    "outerpkg",
    'const { half } = require("innerpkg");\nmodule.exports.read = function () { return JSON.parse(\'{"n":\' + half(4) + "}"); };\n',
    "export declare function read(): { n: number };\n",
  );
  writePackage(
    dir,
    "innerpkg",
    "module.exports.half = function (n) { return n / 2; };\n",
    "export declare function half(n: number): number;\n",
  );
  writeFileSync(
    join(dir, "main.ts"),
    'import { read } from "outerpkg";\nconst shape = read();\nconsole.log(shape.n + 1);\n',
  );
  const shared = createNodeFrontendServices();
  services.push(shared);
  const run = compile(dir, shared, new Set());
  expect(run.loaded).toEqual([[], ["outerpkg"], ["outerpkg", "innerpkg"]]);
  // The scout compiles no package, so it rewrites nothing.
  expect(run.gateChecked[0]).toBeNull();
  expect(run.gateChecked[1]).toBe(0);
  expect(run.gateChecked[2]).toBeGreaterThan(0);
  expect(run.frontend.preflight).toEqual([]);
  run.frontend.dispose();
});
