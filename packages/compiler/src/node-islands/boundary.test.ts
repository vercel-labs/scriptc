import { describe, expect, test } from "vitest";
import {
  islandOwnerOfFile,
  islandPackageOfFile,
  nodeIslandSet,
  type IslandPackage,
  type NodeIslandSet,
} from "./boundary.js";

function island(name: string, dir: string): IslandPackage {
  return { name, version: null, dir, class: "packaging", reason: "it cannot compile natively" };
}

function set(...packages: IslandPackage[]): NodeIslandSet {
  return nodeIslandSet(new Map(packages.map((p) => [p.name, p])), new Map());
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
});
