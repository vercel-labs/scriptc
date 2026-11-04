import { describe, expect, test } from "vitest";
import {
  islandModuleOfFile,
  islandOwnerOfFile,
  islandPackageOfFile,
  type IslandModule,
  type IslandPackage,
  type NodeIslandSet,
} from "./boundary.js";

function island(name: string): IslandPackage {
  return { name, version: "1.0.0", dir: `/p/node_modules/${name}`, class: "gap", reason: "test" };
}

function module(file: string): IslandModule {
  return { file, class: "runtime", reason: "test", decision: "marked" };
}

function islands(packages: IslandPackage[], modules: IslandModule[] = []): NodeIslandSet {
  return {
    packages: new Map(packages.map((p) => [p.name, p])),
    modules: new Map(modules.map((m) => [m.file, m])),
  };
}

describe("the island package of a file", () => {
  test("a declaration inside an island package belongs to it", () => {
    const leftPad = island("left-pad");
    const set = islands([leftPad]);
    expect(islandPackageOfFile(set, "/p/node_modules/left-pad/index.js")).toBe(leftPad);
    expect(islandPackageOfFile(set, "/p/node_modules/left-pad/lib/deep.d.ts")).toBe(leftPad);
  });

  test("a package that is not an island answers null", () => {
    const set = islands([island("left-pad")]);
    expect(islandPackageOfFile(set, "/p/node_modules/right-pad/index.js")).toBeNull();
    expect(islandPackageOfFile(set, "/p/src/main.ts")).toBeNull();
  });

  test("@types/<name> twins type the package <name>, including a scoped one", () => {
    const pad = island("left-pad");
    const scoped = island("@scope/thing");
    const set = islands([pad, scoped]);
    expect(islandPackageOfFile(set, "/p/node_modules/@types/left-pad/index.d.ts")).toBe(pad);
    expect(islandPackageOfFile(set, "/p/node_modules/@types/scope__thing/index.d.ts")).toBe(scoped);
    expect(islandPackageOfFile(set, "/p/node_modules/@types/other/index.d.ts")).toBeNull();
  });

  test("no island packages at all answers null without walking the path", () => {
    const set = islands([], [module("/p/tool.js")]);
    expect(islandPackageOfFile(set, "/p/node_modules/left-pad/index.js")).toBeNull();
  });

  test("one set's answer never answers for another set", () => {
    const first = island("left-pad");
    const file = "/p/node_modules/left-pad/index.js";
    const a = islands([first]);
    const b = islands([]);
    // Ask `a` first so its memo is warm, then `b`: the file is an island of
    // one set and not of the other, and each set keeps its own answer.
    expect(islandPackageOfFile(a, file)).toBe(first);
    expect(islandPackageOfFile(b, file)).toBeNull();
    expect(islandPackageOfFile(a, file)).toBe(first);
    // The third answer repeats the first set's memo, and the first set's
    // entry is the island object itself.
  });
});

describe("the island module of a file", () => {
  test("a marked module, under either path separator", () => {
    const tool = module("/p/tools/run.js");
    const set = islands([], [tool]);
    expect(islandModuleOfFile(set, "/p/tools/run.js")).toBe(tool);
    expect(islandModuleOfFile(set, "/p\\tools\\run.js")).toBe(tool);
    expect(islandModuleOfFile(set, "/p/tools/other.js")).toBeNull();
  });

  test("no island modules at all answers null", () => {
    const set = islands([island("left-pad")]);
    expect(islandModuleOfFile(set, "/p/tools/run.js")).toBeNull();
  });
});

describe("the island owner of a file", () => {
  test("modules first, then packages", () => {
    const tool = module("/p/tools/run.js");
    const leftPad = island("left-pad");
    const set = islands([leftPad], [tool]);
    expect(islandOwnerOfFile(set, "/p/tools/run.js")).toBe(tool);
    expect(islandOwnerOfFile(set, "/p/node_modules/left-pad/index.js")).toBe(leftPad);
    expect(islandOwnerOfFile(set, "/p/src/main.ts")).toBeNull();
  });
});
