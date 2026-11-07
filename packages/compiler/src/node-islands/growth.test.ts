// The reachability filter a build's merged island round uses (WP9): a
// package a reload still compiles only when the program reaches it without
// passing through an island. A package reached only through an island leaves
// the compiled graph with it, so the fences and refusals in its modules are
// not a decision the reloaded round can make.
import { expect, test } from "vitest";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { IslandModule, IslandPackage } from "./boundary.js";
import {
  deferredFenceWarnings,
  growIslandSet,
  stillCompiled,
  type IslandGrowthContext,
} from "./growth.js";
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

// One fence rule for every build: a fence that surely fires islands its
// package, and nothing else about the package or the program does.

function fullPolicy(over: Partial<NodeIslandPolicy> = {}): NodeIslandPolicy {
  return {
    mode: "auto",
    modeSource: "default",
    forcedNode: new Map(),
    forcedNative: new Map(),
    unloaded: new Set(),
    userModules: [],
    node: null,
    strictUserJs: false,
    ...over,
  };
}

/** A package module with a pre-scan marker of the object-model class, the
 * kind a failed build used to island a package for. */
function marked(name: string): ScannedModule {
  const module = pkg(name);
  return {
    ...module,
    markers: [
      {
        rule: "R2.3",
        reason: "define-property",
        construct: "'Object.defineProperty()'",
        loc: { file: module.file, start: 10, end: 20 },
      },
    ],
  };
}

function fence(
  name: string,
  moduleInit: boolean,
  message = "a method call form",
  code: ScrDiagnostic["code"] = "SC1090",
): ScrDiagnostic {
  return {
    code,
    message,
    loc: { file: `${ROOT}/node_modules/${name}/index.js`, start: 30, end: 40 },
    ...(moduleInit ? { moduleInit: true as const } : {}),
  };
}

const userError: ScrDiagnostic = {
  code: "SC1090",
  message: "an error in the program's own code",
  loc: { file: `${ROOT}/main.ts`, start: 0, end: 5 },
};

function growthContext(modules: ScannedModule[], names: string[]): IslandGrowthContext {
  return {
    entry: `${ROOT}/main.ts`,
    policy: fullPolicy(),
    scan: {
      modules: [user("main.ts"), ...modules],
      edges: names.map((name) => edge(`${ROOT}/main.ts`, name)),
      refusals: [],
    },
    npm: names.map((name) => ({ package: name, status: "static" as const })),
    npmImportSites: new Map(),
  };
}

test("a pre-scan marker alone islands nothing, whether or not the build fails", () => {
  const ctx = growthContext([marked("markedkit")], ["markedkit"]);
  // A failed lowering with no fence in the package: the marker used to make
  // the package an island for the error in main.ts.
  expect(growIslandSet(ctx, new Map(), { diagnostics: [userError], fences: [] })).toBeNull();
  // The same with a fence inside a function body, which may never run.
  expect(
    growIslandSet(ctx, new Map(), {
      diagnostics: [userError],
      fences: [fence("markedkit", false)],
    }),
  ).toBeNull();
  // And the compiling build agrees.
  expect(
    growIslandSet(ctx, new Map(), { diagnostics: [], fences: [fence("markedkit", false)] }),
  ).toBeNull();
});

test("a fence that surely fires islands its package in a failing and in a compiling build", () => {
  const ctx = growthContext(
    [marked("initkit"), pkg("evalkit"), pkg("plainkit")],
    ["initkit", "evalkit", "plainkit"],
  );
  const fences = [
    // Module-level code: it throws when the module evaluates.
    fence("initkit", true),
    // A fence that needs the runtime itself, wherever it is.
    fence(
      "evalkit",
      false,
      "'eval' is part of the standard library types but has no scriptc lowering yet",
      "SC2020",
    ),
    fence("plainkit", false),
  ];
  const failing = growIslandSet(ctx, new Map(), { diagnostics: [userError], fences });
  const compiling = growIslandSet(ctx, new Map(), { diagnostics: [], fences });
  expect([...(failing ?? new Map()).keys()].sort()).toEqual(["evalkit", "initkit"]);
  expect([...(compiling ?? new Map()).keys()].sort()).toEqual(["evalkit", "initkit"]);
  // The note's class and reason are the report's first reason, as before.
  expect(failing!.get("initkit")).toMatchObject({ class: "object-model" });
});

test("a package kept native with fences the program can reach is reported once", () => {
  const npm = ["gapkit", "initkit", "named"].map((name) => ({
    package: name,
    status: "static" as const,
  }));
  const sites = new Map([["gapkit", { file: `${ROOT}/main.ts`, start: 7, end: 30 }]]);
  const fences = [
    fence("gapkit", false, "first"),
    fence("gapkit", false, "second"),
    // A fence that surely fires is the fence rule's to answer.
    fence("initkit", true),
    // A package the user named in --npm-static asked for its fences.
    fence("named", false),
  ];
  const warnings = deferredFenceWarnings(
    `${ROOT}/main.ts`,
    fullPolicy(),
    npm,
    ["named"],
    sites,
    fences,
    new Map(),
  );
  expect(warnings.map((w) => [w.code, w.loc, w.message])).toEqual([
    [
      "SC6006",
      { file: `${ROOT}/main.ts`, start: 7, end: 30 },
      "npm package 'gapkit' compiles with 2 operations the program can reach that do not compile: each throws when the program reaches it (first SC1090: first)",
    ],
  ]);
  expect(warnings[0]!.hint).toContain("--node-island=gapkit");
  // An island is not compiled: nothing to report.
  expect(
    deferredFenceWarnings(
      `${ROOT}/main.ts`,
      fullPolicy(),
      npm,
      undefined,
      sites,
      [fence("gapkit", false)],
      new Map([["gapkit", island("gapkit")]]),
    ),
  ).toEqual([]);
});

test("a use of an export a compiled package does not provide islands that package", () => {
  const ctx = growthContext([pkg("bindkit"), pkg("otherkit")], ["bindkit", "otherkit"]);
  // The refusal is in the program's own file and names the package whose
  // export it could not bind.
  const unbound: ScrDiagnostic = {
    code: "SC1090",
    message: "the reference to 'parse' (a binding form with no lowering) is not supported yet",
    loc: { file: `${ROOT}/main.ts`, start: 40, end: 45 },
    exportOf: { package: "bindkit", name: "parse" },
  };
  const grown = growIslandSet(ctx, new Map(), { diagnostics: [unbound] });
  expect([...(grown ?? new Map()).keys()]).toEqual(["bindkit"]);
  expect(grown!.get("bindkit")).toEqual({
    name: "bindkit",
    version: null,
    dir: `${ROOT}/node_modules/bindkit`,
    class: "gap",
    reason: "its export 'parse' has no native binding form (used at main.ts)",
    named: true,
  });
  // A package the policy keeps native stays native, and the error stands.
  const kept: IslandGrowthContext = {
    ...ctx,
    policy: fullPolicy({ forcedNative: new Map([["bindkit", "cli"]]) }),
  };
  expect(growIslandSet(kept, new Map(), { diagnostics: [unbound] })).toBeNull();
  // A package the program does not compile is not this rule's.
  expect(
    growIslandSet(ctx, new Map(), {
      diagnostics: [{ ...unbound, exportOf: { package: "elsewhere", name: "parse" } }],
    }),
  ).toBeNull();
});
