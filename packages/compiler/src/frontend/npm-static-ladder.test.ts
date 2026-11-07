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
}

function compile(
  dir: string,
  shared: FrontendServices,
  islandPackages: ReadonlySet<string>,
  optIn: readonly string[] = ["outerpkg"],
): Run {
  const loaded: string[][] = [];
  const loader: ProgramLoader = (path, options) => {
    loaded.push([...(options.npmStatic ?? [])]);
    return loadProgramWithServices(path, shared, {
      npmStatic: options.npmStatic ?? [],
      externalTypes: options.externalTypes,
    });
  };
  const frontend = runFrontend(join(dir, "main.ts"), loader, "lib", undefined, optIn, {
    islandPackages,
  });
  return { frontend, loaded };
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

test("an island reload beside a static package loads the opted-in set once", () => {
  // `hljs` is on the npm-static list and runs in a Node island: the island
  // decision wins, the list the reload compiles is the list minus the
  // island, and the program type-checks against the island's declarations.
  // So the reload is the scout and ONE load of the remaining set. When the
  // island's shipped JS reached the authored project world, the check there
  // failed in user code, and the last-resort attribution reloaded the
  // program once per remaining package and for the bare baseline (on pi,
  // fourteen loads and a 14-minute reload) before refusing the innocent
  // package.
  const dir = join(import.meta.dirname, "../../../../tests/corpus/8826-island-typed-beside-static");
  const shared = createNodeFrontendServices();
  services.push(shared);
  const loaded: string[][] = [];
  const loader: ProgramLoader = (path, options) => {
    loaded.push([...(options.npmStatic ?? [])]);
    return loadProgramWithServices(path, shared, {
      npmStatic: options.npmStatic ?? [],
      externalTypes: options.externalTypes,
    });
  };
  const frontend = runFrontend(
    join(dir, "main.ts"),
    loader,
    "lib",
    undefined,
    ["hljs", "plainpkg"],
    {
      islandPackages: new Set(["hljs"]),
      islandTypeRoots: [join(dir, "node_modules/hljs/types/index.d.ts")],
    },
  );
  try {
    expect(loaded).toEqual([[], ["plainpkg"]]);
    expect(frontend.npmStatic.map((status) => `${status.package}:${status.status}`)).toEqual([
      "plainpkg:static",
    ]);
    expect(frontend.preflight.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  } finally {
    frontend.dispose();
  }
});
