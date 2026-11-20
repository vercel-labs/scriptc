import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { DYN_HANDLE_KINDS } from "../../ir/ir.js";
import { type IslandModule, nodeIslandSet } from "../../node-islands/boundary.js";
import { ISLAND_EXPORTED_HANDLE_TAGS, islandModuleFile } from "./lower-node-island.js";

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

// The runtime decides which native values the island export table holds:
// scr_ni_exportable (scr_node_island_export.c). A native value outside it
// dies at the crossing with "this native object cannot cross into a Node
// island yet", so the compiler refuses a statically typed I/O handle by
// name (SC8010, unexportedNative). The runtime function is the source of
// truth: this reads it, so the compiler's list cannot drift from it.
const source = readFileSync(
  new URL("../../../../runtime/src/scr_node_island_export.c", import.meta.url),
  "utf8",
);
const body = /\nbool scr_ni_exportable\(const ScrDyn \*v\) \{\n([\s\S]*?)\n\}\n/.exec(source)![1]!;

test("the handle tags the runtime exports are the ones the compiler lets cross", () => {
  const tags = [...body.matchAll(/v->v\.handle\.tag == (SCR_DYNH_[A-Z0-9_]+)/g)].map(
    ([, tag]) => tag!,
  );
  expect(tags.length).toBeGreaterThan(0);
  expect(tags.sort()).toEqual([...ISLAND_EXPORTED_HANDLE_TAGS].sort());
});

test("no I/O handle kind is exported, so each is refused at build time", () => {
  // A handle kind the runtime starts to export joins ISLAND_EXPORTED_HANDLE_TAGS
  // (the test above asks for it) and stops being refused; until then every
  // kind of DYN_HANDLE_KINDS is one the crossing refuses.
  const exported = [...DYN_HANDLE_KINDS.values()].filter(({ tag }) =>
    ISLAND_EXPORTED_HANDLE_TAGS.has(tag),
  );
  expect(exported).toEqual([]);
});

test("the runtime exports the checked-dynamic kinds the island lowering relies on", () => {
  const kinds = [...body.matchAll(/case (SCR_DYN_[A-Z_]+):/g)].map(([, kind]) => kind);
  expect(kinds).toEqual([
    "SCR_DYN_FUNC",
    "SCR_DYN_PROMISE",
    "SCR_DYN_OBJ",
    "SCR_DYN_ARR",
    "SCR_DYN_TYPED_REF",
    "SCR_DYN_PROXY",
    "SCR_DYN_HANDLE",
  ]);
});
