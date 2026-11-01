import { describe, expect, test } from "vitest";
import { islandPackageOfFile, type IslandPackage, type NodeIslandSet } from "./boundary.js";

function island(name: string, dir: string): IslandPackage {
  return { name, version: null, dir, class: "packaging", reason: "it cannot compile natively" };
}

function set(...packages: IslandPackage[]): NodeIslandSet {
  return { packages: new Map(packages.map((p) => [p.name, p])), modules: new Map() };
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
