import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkPreflight, loadProgram } from "./program-node.js";

const fixtureRoot = join(import.meta.dirname, "../../../../tests/fixtures/npm-static");

function moduleOrder(
  entry: string,
  packages: string | string[],
): { files: string[]; diagnostics: string[] } {
  const load = loadProgram(join(fixtureRoot, entry), {
    npmStatic: typeof packages === "string" ? [packages] : packages,
  });
  try {
    const diagnostics = checkPreflight(load);
    return {
      files: load.moduleOrder.map((sf) => sf.fileName),
      diagnostics: diagnostics.map((d) => d.code),
    };
  } finally {
    load.dispose();
  }
}

describe("npm static namespace re-export pruning", () => {
  test("the named package's sideEffects declaration skips unused namespace exports through a nested ESM scope", () => {
    const { files, diagnostics } = moduleOrder("purebarrel-cli.ts", "purebarrel");
    expect(diagnostics).toEqual([]);
    expect(files.some((file) => file.endsWith("/purebarrel/dist/esm/feature.js"))).toBe(true);
    expect(files.some((file) => file.endsWith("/purebarrel/dist/esm/spare.js"))).toBe(false);
  });

  test("a requested namespace retains its module edge", () => {
    const { files, diagnostics } = moduleOrder("purebarrel-spare-cli.ts", "purebarrel");
    // The edge is the point: the requested namespace is not pruned. The
    // spare module's `export * from "picocolors"` is a package star
    // re-export, which lowers now, so the old SC1014 fence is gone.
    expect(files.some((file) => file.endsWith("/purebarrel/dist/esm/spare.js"))).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  test("a package without sideEffects metadata retains unused module initialization", () => {
    const { files, diagnostics } = moduleOrder("statefulbarrel-cli.ts", "statefulbarrel");
    expect(diagnostics).toEqual([]);
    expect(files.some((file) => file.endsWith("/statefulbarrel/spare.js"))).toBe(true);
  });

  test("an empty named import still requests module initialization", () => {
    const { files, diagnostics } = moduleOrder("statefulbarrel-empty-cli.ts", "statefulbarrel");
    expect(diagnostics).toEqual([]);
    expect(files.some((file) => file.endsWith("/statefulbarrel/index.js"))).toBe(true);
    expect(files.some((file) => file.endsWith("/statefulbarrel/spare.js"))).toBe(true);
  });

  test("a dependency cycle inherits an impure sibling before pruning a namespace re-export", () => {
    const { files, diagnostics } = moduleOrder("cycle-cli.ts", [
      "cycle-a",
      "cycle-b",
      "cycle-impure",
    ]);
    expect(diagnostics).toEqual([]);
    expect(files.some((file) => file.endsWith("/cycle-b/spare.js"))).toBe(true);
    expect(files.some((file) => file.endsWith("/cycle-impure/index.js"))).toBe(true);
  });
  test("per-file sideEffects patterns retain initialization through imports and cycles", () => {
    const { files, diagnostics } = moduleOrder("selectivebarrel-cli.ts", "selectivebarrel");
    expect(diagnostics).toEqual([]);
    expect(files.some((file) => file.endsWith("/selectivebarrel/spare.js"))).toBe(false);
    for (const name of [
      "feature.js",
      "effects/start.js",
      "bridge.js",
      "loop-a.js",
      "loop-b.js",
      "nested/custom.init.js",
      "braced/a.js",
    ]) {
      expect(
        files.some((file) => file.endsWith(`/selectivebarrel/${name}`)),
        name,
      ).toBe(true);
    }
  });
});
