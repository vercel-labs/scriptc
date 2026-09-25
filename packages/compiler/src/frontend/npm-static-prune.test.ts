import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkPreflight, loadProgram } from "./program.js";

const fixtureRoot = join(import.meta.dirname, "../../../../tests/fixtures/npm-static");

function moduleOrder(entry: string, packages: string | string[]): { files: string[]; diagnostics: string[] } {
  const load = loadProgram(join(fixtureRoot, entry), { npmStatic: typeof packages === "string" ? [packages] : packages });
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

  test("a requested namespace retains its module edge and its preflight fence", () => {
    const { files, diagnostics } = moduleOrder("purebarrel-spare-cli.ts", "purebarrel");
    expect(files.some((file) => file.endsWith("/purebarrel/dist/esm/spare.js"))).toBe(true);
    expect(diagnostics).toContain("SC1014");
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
    const { files, diagnostics } = moduleOrder("cycle-cli.ts", ["cycle-a", "cycle-b", "cycle-impure"]);
    expect(diagnostics).toEqual([]);
    expect(files.some((file) => file.endsWith("/cycle-b/spare.js"))).toBe(true);
    expect(files.some((file) => file.endsWith("/cycle-impure/index.js"))).toBe(true);
  });
});
