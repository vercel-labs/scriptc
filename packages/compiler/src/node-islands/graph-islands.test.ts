// The containment closure: a package only Node islands load is in the island
// set, whichever rule moved its importer and whether or not a rule ever
// looked at the package itself. The answer reads the import graph and the
// set, nothing else.
import { expect, test } from "vitest";
import type { IslandModule, IslandPackage } from "./boundary.js";
import { containedIslands } from "./graph-islands.js";
import type { NodeIslandPolicy } from "./policy.js";
import type { NodeIslandScan, PackageEdge } from "./scan.js";

const ROOT = "/proj";

/** The import `fromFile` → `to` (the target resolves to `ROOT`'s install). */
function edge(fromFile: string, to: string, start = 0, loads = true): PackageEdge {
  const at = fromFile.lastIndexOf("/node_modules/");
  const rest = at < 0 ? [] : fromFile.slice(at + "/node_modules/".length).split("/");
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
    loads,
    loc: { file: fromFile, start, end: start },
  };
}

function file(name: string): string {
  return `${ROOT}/node_modules/${name}/index.js`;
}

function islands(...names: string[]): Map<string, IslandPackage> {
  return new Map(
    names.map((name) => [
      name,
      { name, version: "1.0.0", dir: `${ROOT}/node_modules/${name}`, class: "gap", reason: "" },
    ]),
  );
}

function policy(over: Partial<NodeIslandPolicy> = {}): NodeIslandPolicy {
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

function scanOf(edges: PackageEdge[], insideEdges?: PackageEdge[]): NodeIslandScan {
  return { modules: [], edges, refusals: [], ...(insideEdges ? { insideEdges } : {}) };
}

function names(contained: ReadonlyMap<string, unknown>): string[] {
  return [...contained.keys()].sort();
}

test("what only an island loads is contained, through every level and around a cycle", () => {
  const scan = scanOf([
    edge(`${ROOT}/main.ts`, "a"),
    edge(`${ROOT}/main.ts`, "n"),
    edge(file("a"), "b"),
    edge(file("b"), "c"),
    // `c` and `d` import each other: neither has a native importer.
    edge(file("c"), "d"),
    edge(file("d"), "c"),
    edge(file("n"), "m"),
  ]);
  const contained = containedIslands(policy(), scan, islands("a"), new Map());
  expect(names(contained)).toEqual(["b", "c", "d"]);
  expect(contained.get("b")).toMatchObject({
    name: "b",
    dir: `${ROOT}/node_modules/b`,
    class: "packaging",
    reason: "only 'a', which runs in a Node island, loads it",
  });
  expect(contained.get("c")!.reason).toBe(
    "only code that runs in a Node island loads it ('b', 'd')",
  );
  // The native side keeps what it reaches without an island.
  expect(contained.has("n")).toBe(false);
  expect(contained.has("m")).toBe(false);
});

test("a package native code can also load is not contained, nor is what it loads", () => {
  const scan = scanOf([
    edge(`${ROOT}/main.ts`, "a"),
    edge(`${ROOT}/main.ts`, "n"),
    edge(file("a"), "shared"),
    edge(file("n"), "shared"),
    edge(file("shared"), "below"),
    // A deferred native import (an import() in a function) is an importer
    // too: native code may load the package.
    edge(file("a"), "lazy"),
    edge(`${ROOT}/main.ts`, "lazy", 40, false),
  ]);
  expect(names(containedIslands(policy(), scan, islands("a"), new Map()))).toEqual([]);
});

test("the answer does not depend on which packages a rule already islanded", () => {
  const scan = scanOf([edge(`${ROOT}/main.ts`, "a"), edge(file("a"), "b"), edge(file("b"), "c")]);
  // `b` named by a rule of its own (it refused before `a` was an island)…
  const early = containedIslands(policy(), scan, islands("a", "b"), new Map());
  // …or never looked at, because `a` was an island first.
  const late = containedIslands(policy(), scan, islands("a"), new Map());
  // Either way `b` and `c` are described as what only an island loads, and
  // `a`, which native code imports, keeps its own reason.
  expect(names(early)).toEqual(["b", "c"]);
  expect(names(late)).toEqual(["b", "c"]);
  expect(early.get("b")).toEqual(late.get("b"));
  expect(early.get("c")).toEqual(late.get("c"));
});

test("a package whose importer is an island only because of it keeps its own reason", () => {
  // `bridge` is an island because its ES module imports the CommonJS island
  // `zoo`: without `zoo` it would compile and its import would be native.
  const scan = scanOf([
    edge(`${ROOT}/main.ts`, "bridge"),
    edge(file("bridge"), "zoo"),
    edge(file("zoo"), "below"),
  ]);
  const set = islands("bridge", "zoo");
  set.set("bridge", { ...set.get("bridge")!, follows: "zoo" });
  // `zoo` is the reason for both, so it is not described as contained; what
  // only it loads is.
  expect(names(containedIslands(policy(), scan, set, new Map()))).toEqual(["below"]);
  // The same graph with `bridge` an island for a reason of its own: `zoo`
  // is inside it.
  expect(names(containedIslands(policy(), scan, islands("bridge", "zoo"), new Map()))).toEqual([
    "below",
    "zoo",
  ]);
  // A follower that is itself inside an island follows nothing native code
  // reaches: both are contained.
  const inside = scanOf([
    edge(`${ROOT}/main.ts`, "outer"),
    edge(file("outer"), "bridge"),
    edge(file("bridge"), "zoo"),
  ]);
  const nested = islands("outer", "bridge", "zoo");
  nested.set("bridge", { ...nested.get("bridge")!, follows: "zoo" });
  expect(names(containedIslands(policy(), inside, nested, new Map()))).toEqual(["bridge", "zoo"]);
});

test("a package the policy marks keeps its marking, and what it loads is contained", () => {
  const scan = scanOf([
    edge(`${ROOT}/main.ts`, "a"),
    edge(file("a"), "marked"),
    edge(file("marked"), "below"),
  ]);
  const contained = containedIslands(
    policy({ forcedNode: new Map([["marked", "cli"]]) }),
    scan,
    islands("a", "marked"),
    new Map(),
  );
  expect(names(contained)).toEqual(["below"]);
});

test("an island module's imports are an island's, and a native module's are not", () => {
  const sloppy = `${ROOT}/sloppy.js`;
  const scan = scanOf([edge(sloppy, "a"), edge(file("a"), "b"), edge(`${ROOT}/main.ts`, "n")]);
  const modules = new Map<string, IslandModule>([
    [sloppy, { file: sloppy, class: "object-model", reason: "", decision: "auto" }],
  ]);
  const contained = containedIslands(policy(), scan, new Map(), modules);
  expect(names(contained)).toEqual(["a", "b"]);
  expect(contained.get("a")!.reason).toBe(
    `only '${sloppy}', which runs in a Node island, loads it`,
  );
});

test("the imports below a package the load refused are read from insideEdges", () => {
  const scan = scanOf(
    [edge(`${ROOT}/main.ts`, "refused"), edge(file("refused"), "b")],
    [edge(file("b"), "c"), edge(file("c"), "d")],
  );
  expect(names(containedIslands(policy(), scan, islands("refused"), new Map()))).toEqual([
    "b",
    "c",
    "d",
  ]);
});

test("shims, unresolved imports and the policy's native and unloaded packages are left alone", () => {
  const shim = { ...edge(file("a"), "shimmed"), shim: true };
  const missing = { ...edge(file("a"), "missing"), toDir: null };
  const scan = scanOf([
    edge(`${ROOT}/main.ts`, "a"),
    shim,
    missing,
    edge(file("a"), "kept"),
    edge(file("a"), "skipped"),
    edge(file("kept"), "under-kept"),
  ]);
  const contained = containedIslands(
    policy({ forcedNative: new Map([["kept", "cli"]]), unloaded: new Set(["skipped"]) }),
    scan,
    islands("a"),
    new Map(),
  );
  expect(names(contained)).toEqual([]);
});

test("no islands, or islands off, contain nothing", () => {
  const scan = scanOf([edge(`${ROOT}/main.ts`, "a"), edge(file("a"), "b")]);
  expect(names(containedIslands(policy(), scan, new Map(), new Map()))).toEqual([]);
  expect(names(containedIslands(policy({ mode: "off" }), scan, islands("a"), new Map()))).toEqual(
    [],
  );
});
