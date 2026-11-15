import { describe, expect, test } from "vitest";
import {
  islandModuleOfFile,
  islandOfModuleName,
  islandOwnerOfFile,
  islandPackageOfFile,
  type IslandModule,
  type IslandPackage,
  type NodeIslandSet,
  nodeIslandSet,
} from "./boundary.js";

function island(name: string, dir: string): IslandPackage {
  return { name, version: null, dir, class: "packaging", reason: "it cannot compile natively" };
}

function set(...packages: IslandPackage[]): NodeIslandSet {
  return nodeIslandSet(new Map(packages.map((p) => [p.name, p])), new Map());
}

function pkg(name: string): IslandPackage {
  return { name, version: "1.0.0", dir: `/p/node_modules/${name}`, class: "gap", reason: "test" };
}

function module(file: string): IslandModule {
  return { file, class: "runtime", reason: "test", decision: "marked" };
}

function islands(packages: IslandPackage[], modules: IslandModule[] = []): NodeIslandSet {
  return nodeIslandSet(
    new Map(packages.map((p) => [p.name, p])),
    new Map(modules.map((m) => [m.file, m])),
  );
}

describe("islandPackageOfFile", () => {
  test("names the island package from the file's node_modules path", () => {
    const islands = set(island("plain", "/p/node_modules/plain"));
    expect(islandPackageOfFile(islands, "/p/node_modules/plain/lib/index.js")?.name).toBe("plain");
  });

  test("types an @types declaration with the package it declares", () => {
    const islands = set(island("@scope/pkg", "/p/node_modules/@scope/pkg"));
    expect(islandPackageOfFile(islands, "/p/node_modules/@types/scope__pkg/index.d.ts")?.name).toBe(
      "@scope/pkg",
    );
  });

  test("finds an island installed outside node_modules by its directory", () => {
    // A workspace link's realpath elides the node_modules segment: the
    // file path names no package, and the island's own directory is the
    // only identity it has.
    const islands = set(island("wsunclean", "/p/workspace/wsunclean"));
    expect(islandPackageOfFile(islands, "/p/workspace/wsunclean/dist/index.js")?.name).toBe(
      "wsunclean",
    );
    expect(islandPackageOfFile(islands, "/p/workspace/wsunclean")?.name).toBe("wsunclean");
  });

  test("does not claim a dependency installed inside the island's node_modules", () => {
    // A workspace island's own directory is its identity, but a package
    // installed under that directory is a separate package: it is found by
    // name when it is an island too, and its declarations must not read as
    // this island's.
    const islands = set(island("wsunclean", "/p/workspace/wsunclean"));
    expect(
      islandPackageOfFile(islands, "/p/workspace/wsunclean/node_modules/native-dep/index.js"),
    ).toBeNull();
    expect(
      islandPackageOfFile(
        islands,
        "/p/workspace/wsunclean/node_modules/@scope/native-dep/index.d.ts",
      ),
    ).toBeNull();
    expect(
      islandPackageOfFile(
        islands,
        "/p/workspace/wsunclean/node_modules/.pnpm/native-dep@1.0.0/node_modules/native-dep/index.js",
      ),
    ).toBeNull();
    // The dependency's own package directory, as the resolver spells it.
    expect(
      islandPackageOfFile(islands, "/p/workspace/wsunclean/node_modules/native-dep"),
    ).toBeNull();
    // The island module link uses the same owner: a require inside island
    // code for the nested dependency is not island code to load in Node.
    expect(
      islandOwnerOfFile(islands, "/p/workspace/wsunclean/node_modules/native-dep/index.js"),
    ).toBeNull();
    // The island's own files beside node_modules keep the island.
    expect(islandPackageOfFile(islands, "/p/workspace/wsunclean/dist/index.js")?.name).toBe(
      "wsunclean",
    );
  });

  test("does not claim a sibling whose path merely shares a prefix", () => {
    const islands = set(island("wsunclean", "/p/workspace/wsunclean"));
    expect(islandPackageOfFile(islands, "/p/workspace/wsunclean-twin/dist/index.js")).toBeNull();
  });

  test("answers nothing for a file outside every island", () => {
    const islands = set(island("plain", "/p/node_modules/plain"));
    expect(islandPackageOfFile(islands, "/p/src/main.ts")).toBeNull();
    expect(islandPackageOfFile(set(), "/p/workspace/wsunclean/dist/index.js")).toBeNull();
  });

  test("a declaration inside an island package belongs to it", () => {
    const leftPad = pkg("left-pad");
    const set = islands([leftPad]);
    expect(islandPackageOfFile(set, "/p/node_modules/left-pad/index.js")).toBe(leftPad);
    expect(islandPackageOfFile(set, "/p/node_modules/left-pad/lib/deep.d.ts")).toBe(leftPad);
  });

  test("a package that is not an island answers null", () => {
    const set = islands([pkg("left-pad")]);
    expect(islandPackageOfFile(set, "/p/node_modules/right-pad/index.js")).toBeNull();
    expect(islandPackageOfFile(set, "/p/src/main.ts")).toBeNull();
  });

  test("@types/<name> twins type the package <name>, including a scoped one", () => {
    const pad = pkg("left-pad");
    const scoped = pkg("@scope/thing");
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
    const first = pkg("left-pad");
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

describe("the island a `declare module` block's name belongs to", () => {
  test("the package's own name, a subpath, and a scoped package", () => {
    const set = islands([pkg("plain"), pkg("@scope/pkg")]);
    expect(islandOfModuleName(set, "plain")?.name).toBe("plain");
    expect(islandOfModuleName(set, "plain/lib/core.js")?.name).toBe("plain");
    expect(islandOfModuleName(set, "@scope/pkg")?.name).toBe("@scope/pkg");
    expect(islandOfModuleName(set, "@scope/pkg/sub")?.name).toBe("@scope/pkg");
  });

  test("a pattern names modules of the package its first segments spell", () => {
    const set = islands([pkg("plain")]);
    expect(islandOfModuleName(set, "plain/lib/languages/*.js")?.name).toBe("plain");
    expect(islandOfModuleName(set, "*.css")).toBeNull();
    expect(islandOfModuleName(set, "*")).toBeNull();
  });

  test("another package, a longer name, and a relative module are not the island", () => {
    const set = islands([pkg("plain")], [module("/p/src/legacy.js")]);
    expect(islandOfModuleName(set, "other")).toBeNull();
    expect(islandOfModuleName(set, "plain-extras")).toBeNull();
    expect(islandOfModuleName(set, "@scope/plain")).toBeNull();
    expect(islandOfModuleName(set, "./legacy.js")).toBeNull();
    expect(islandOfModuleName(set, "../plain")).toBeNull();
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
    const set = islands([pkg("left-pad")]);
    expect(islandModuleOfFile(set, "/p/tools/run.js")).toBeNull();
  });
});

describe("the island owner of a file", () => {
  test("modules first, then packages", () => {
    const tool = module("/p/tools/run.js");
    const leftPad = pkg("left-pad");
    const set = islands([leftPad], [tool]);
    expect(islandOwnerOfFile(set, "/p/tools/run.js")).toBe(tool);
    expect(islandOwnerOfFile(set, "/p/node_modules/left-pad/index.js")).toBe(leftPad);
    expect(islandOwnerOfFile(set, "/p/src/main.ts")).toBeNull();
  });
});
