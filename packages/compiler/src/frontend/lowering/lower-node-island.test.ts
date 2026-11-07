import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { type IslandModule, nodeIslandSet } from "../../node-islands/boundary.js";
import { islandModuleFile } from "./lower-node-island.js";

// A workspace member exported as TypeScript source, with one file for the
// import edge and another for the require edge:
//   <root>/main.ts
//   <root>/node_modules/@probe/reader -> ../../packages/reader
//   <root>/packages/reader/src/utils/env.ts   ("import")
//   <root>/packages/reader/src/utils/env.cts  ("require")
const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-island-file-")));
const member = join(root, "packages", "reader");
const importFile = join(member, "src", "utils", "env.ts");
const requireFile = join(member, "src", "utils", "env.cts");
const from = join(root, "main.ts");

mkdirSync(join(member, "src", "utils"), { recursive: true });
mkdirSync(join(root, "node_modules", "@probe"), { recursive: true });
writeFileSync(
  join(root, "package.json"),
  JSON.stringify({ name: "island-file-root", private: true, workspaces: ["packages/*"] }),
);
writeFileSync(
  join(member, "package.json"),
  JSON.stringify({
    name: "@probe/reader",
    private: true,
    type: "module",
    exports: {
      "./utils/*": {
        types: "./src/utils/*.ts",
        import: "./src/utils/*.ts",
        require: "./src/utils/*.cts",
      },
    },
  }),
);
writeFileSync(importFile, 'export const edge: string = "import";\n');
writeFileSync(requireFile, 'export const edge: string = "require";\n');
writeFileSync(from, 'import { edge } from "@probe/reader/utils/env";\nconsole.log(edge);\n');
symlinkSync(join("..", "..", "packages", "reader"), join(root, "node_modules", "@probe", "reader"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function islandModules(...files: string[]) {
  const modules = files.map((file): IslandModule => ({
    file,
    class: "runtime",
    reason: "test",
    decision: "auto",
  }));
  return nodeIslandSet(new Map(), new Map(modules.map((m) => [m.file, m])));
}

describe("islandModuleFile: a source-only workspace package", () => {
  const spec = "@probe/reader/utils/env";

  test("an import of the bare subpath names the island module's source file", () => {
    expect(islandModuleFile(islandModules(importFile), from, spec, "import")).toBe(importFile);
  });

  test("a require of the same subpath does not bind to the import edge's island", () => {
    // Node's require conditions name env.cts here, never env.ts: answering
    // the import's file would run the wrong module.
    expect(islandModuleFile(islandModules(importFile), from, spec, "require")).toBeNull();
    expect(
      islandModuleFile(islandModules(importFile, requireFile), from, spec, "require"),
    ).not.toBe(importFile);
  });

  test("an import of a file no island owns stays native", () => {
    expect(islandModuleFile(islandModules(requireFile), from, spec, "import")).toBeNull();
  });
});
