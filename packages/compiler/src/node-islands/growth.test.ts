// The reachability filter a build's merged island round uses (WP9): a
// package a reload still compiles only when the program reaches it without
// passing through an island. A package reached only through an island leaves
// the compiled graph with it, so the fences and refusals in its modules are
// not a decision the reloaded round can make.
import { expect, test } from "vitest";
import type { IslandModule, IslandPackage } from "./boundary.js";
import { stillCompiled, type IslandGrowthContext } from "./growth.js";
import type { NodeIslandPolicy } from "./policy.js";
import type { NodeIslandScan, PackageEdge, ScannedModule } from "./scan.js";

const ROOT = "/proj";

function pkg(name: string, file = "index.js", dropped = false): ScannedModule {
  const dir = `${ROOT}/node_modules/${name}`;
  return {
    file: `${dir}/${file}`,
    origin: "npm",
    packageDir: dir,
    packageName: name,
    markers: [],
    cjsReads: [],
    globalReads: [],
    stripProblem: null,
    dropped,
  };
}

function user(file: string): ScannedModule {
  return {
    file: `${ROOT}/${file}`,
    origin: "user",
    packageDir: null,
    packageName: null,
    markers: [],
    cjsReads: [],
    globalReads: [],
    stripProblem: null,
    dropped: false,
  };
}

/** The import `fromFile` → `to` (the target resolves to `ROOT`'s install). */
function edge(fromFile: string, to: string): PackageEdge {
  const at = fromFile.lastIndexOf("/node_modules/");
  const rest = at < 0 ? "" : fromFile.slice(at + "/node_modules/".length).split("/");
  const fromDir =
    at < 0
      ? null
      : rest[0]!.startsWith("@")
        ? `${fromFile.slice(0, at)}/node_modules/${rest[0]}/${rest[1]}`
        : `${fromFile.slice(0, at)}/node_modules/${rest[0]}`;
  return {
    fromDir,
    fromFile,
    to,
    toDir: `${ROOT}/node_modules/${to}`,
    shim: false,
    loads: true,
    loc: { file: fromFile, start: 0, end: 0 },
  };
}

function island(name: string): IslandPackage {
  return { name, version: "1.0.0", dir: `${ROOT}/node_modules/${name}`, class: "gap", reason: "" };
}

function moduleIsland(file: string): IslandModule {
  return { file, class: "object-model", reason: "", decision: "auto" };
}

function context(scan: NodeIslandScan): IslandGrowthContext {
  return {
    entry: `${ROOT}/main.ts`,
    // Only the scan is read by stillCompiled.
    policy: { mode: "auto" } as NodeIslandPolicy,
    scan,
    npm: [],
    npmImportSites: new Map(),
  };
}

test("a package reached only through an island leaves the compiled graph with it", () => {
  const scan: NodeIslandScan = {
    modules: [user("main.ts"), pkg("a"), pkg("b"), pkg("c"), pkg("d"), pkg("e")],
    edges: [
      edge(`${ROOT}/main.ts`, "a"),
      edge(`${ROOT}/main.ts`, "c"),
      edge(`${ROOT}/node_modules/a/index.js`, "b"),
      edge(`${ROOT}/node_modules/c/index.js`, "d"),
      edge(`${ROOT}/node_modules/d/index.js`, "e"),
    ],
    refusals: [],
  };
  const compiled = stillCompiled(context(scan), new Map([["a", island("a")]]), new Map());
  // User code is compiled.
  expect(compiled(`${ROOT}/main.ts`)).toBe(true);
  // `c` is imported by the program itself, and reaches `d` and, through it,
  // `e`.
  expect(compiled(`${ROOT}/node_modules/c/index.js`)).toBe(true);
  expect(compiled(`${ROOT}/node_modules/d/index.js`)).toBe(true);
  expect(compiled(`${ROOT}/node_modules/e/index.js`)).toBe(true);
  // `a` is the island; `b` is what only `a` reaches.
  expect(compiled(`${ROOT}/node_modules/a/index.js`)).toBe(false);
  expect(compiled(`${ROOT}/node_modules/b/index.js`)).toBe(false);
});

test("a shared dependency stays compiled, and a dropped module takes its imports with it", () => {
  const scan: NodeIslandScan = {
    modules: [user("main.ts"), pkg("a"), pkg("b"), pkg("c"), pkg("d", "index.js", true)],
    edges: [
      edge(`${ROOT}/main.ts`, "a"),
      edge(`${ROOT}/main.ts`, "c"),
      edge(`${ROOT}/node_modules/a/index.js`, "b"),
      edge(`${ROOT}/node_modules/c/index.js`, "b"),
      edge(`${ROOT}/node_modules/c/index.js`, "d"),
    ],
    refusals: [],
  };
  const compiled = stillCompiled(context(scan), new Map([["a", island("a")]]), new Map());
  // `b` is reached through the island and through native `c`.
  expect(compiled(`${ROOT}/node_modules/b/index.js`)).toBe(true);
  // `d`'s own module was dropped by the drop-and-reload loop: its import of
  // `d` is not a path.
  expect(compiled(`${ROOT}/node_modules/d/index.js`)).toBe(false);
});

test("a module island's file and its imports are not compiled", () => {
  const scan: NodeIslandScan = {
    modules: [user("main.ts"), user("sloppy.js"), pkg("a")],
    edges: [edge(`${ROOT}/sloppy.js`, "a")],
    refusals: [],
  };
  const compiled = stillCompiled(
    context(scan),
    new Map(),
    new Map([[`${ROOT}/sloppy.js`, moduleIsland(`${ROOT}/sloppy.js`)]]),
  );
  expect(compiled(`${ROOT}/main.ts`)).toBe(true);
  expect(compiled(`${ROOT}/sloppy.js`)).toBe(false);
  expect(compiled(`${ROOT}/node_modules/a/index.js`)).toBe(false);
});

test("@types declarations answer for the package they type", () => {
  const dir = `${ROOT}/node_modules/@types/a`;
  const scan: NodeIslandScan = {
    modules: [
      user("main.ts"),
      {
        file: `${dir}/index.d.ts`,
        origin: "builtin",
        packageDir: dir,
        packageName: "@types/a",
        markers: [],
        cjsReads: [],
        globalReads: [],
        stripProblem: null,
        dropped: false,
      },
    ],
    edges: [],
    refusals: [],
  };
  const compiled = stillCompiled(context(scan), new Map([["a", island("a")]]), new Map());
  expect(compiled(`${dir}/index.d.ts`)).toBe(false);
});
