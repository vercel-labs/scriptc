import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { checkPreflight, loadProgram } from "../program-node.js";
import * as ts from "../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import { Lowerer } from "./lowerer.js";
import {
  cjsNamespaceTargetOf,
  cjsRequireSnapshotBindingsOf,
  cjsTableExportNamesOf,
} from "./cjs-inline-require.js";
import { cjsExportCallIgnoresThis } from "./cjs-exports-object.js";
import { cjsAccessorSnapshotStores } from "./lower-exprs.js";

afterAll(closeSourceParser);

function withProgram(
  files: Record<string, string>,
  run: (lowerer: Lowerer) => void,
  entry = "main.cjs",
): void {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-cjs-table-"));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  const load = loadProgram(join(dir, entry));
  try {
    checkPreflight(load);
    run(new Lowerer(load.program, load.entry, load.moduleOrder));
  } finally {
    load.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("table re-export resolution does not rescan modules for each member lookup", () => {
  withProgram(
    {
      "main.cjs": 'var lib; lib = require("./lib.cjs"); module.exports = lib;',
      "lib.cjs": "exports.n = 7;",
    },
    (lowerer) => {
      const target = cjsNamespaceTargetOf(lowerer, lowerer.entry);
      expect(target?.fileName).toBe(join(lowerer.entry.fileName, "../lib.cjs"));
      const symbols = vi.spyOn(lowerer.checker, "getSymbolAtLocation");
      try {
        for (let i = 0; i < 20; i++) {
          expect(cjsNamespaceTargetOf(lowerer, lowerer.entry)).toBe(target);
          expect(cjsNamespaceTargetOf(lowerer, target!)).toBe(target);
        }
        expect(symbols).not.toHaveBeenCalled();
      } finally {
        symbols.mockRestore();
      }
    },
  );
});

test("table re-export chains have no arbitrary wrapper-count limit", () => {
  const files: Record<string, string> = { "leaf.cjs": "exports.n = 7;" };
  for (let i = 0; i < 40; i++) {
    const next = JSON.stringify(i === 39 ? "./leaf.cjs" : `./wrap${i + 1}.cjs`);
    files[i === 0 ? "main.cjs" : `wrap${i}.cjs`] =
      i % 3 === 0
        ? `var lib; lib = require(${next}); module.exports = lib;`
        : i % 3 === 1
          ? `const lib = require(${next}); module.exports = lib;`
          : `module.exports = require(${next});`;
  }
  withProgram(files, (lowerer) => {
    expect(cjsNamespaceTargetOf(lowerer, lowerer.entry)?.fileName).toBe(
      join(lowerer.entry.fileName, "../leaf.cjs"),
    );
  });
});

test("table re-export member calls reuse their receiver proof", () => {
  withProgram(
    {
      "main.cjs": 'var lib; lib = require("./lib.cjs"); module.exports = lib;',
      "lib.cjs": "exports.read = function () { return 7; };",
    },
    (lowerer) => {
      expect(cjsExportCallIgnoresThis(lowerer, lowerer.entry, "read")).toBe(true);
      const symbols = vi.spyOn(lowerer.checker, "getSymbolAtLocation");
      try {
        for (let i = 0; i < 20; i++) {
          expect(cjsExportCallIgnoresThis(lowerer, lowerer.entry, "read")).toBe(true);
        }
        expect(symbols.mock.calls.length).toBe(0);
      } finally {
        symbols.mockRestore();
      }
    },
  );
});

test("table re-export cycles have no terminal table", () => {
  withProgram(
    {
      "main.cjs": 'module.exports = require("./other.cjs");',
      "other.cjs": 'module.exports = require("./main.cjs");',
    },
    (lowerer) => {
      expect(cjsNamespaceTargetOf(lowerer, lowerer.entry)).toBeNull();
      const symbols = vi.spyOn(lowerer.checker, "getSymbolAtLocation");
      try {
        expect(cjsNamespaceTargetOf(lowerer, lowerer.entry)).toBeNull();
        expect(symbols).not.toHaveBeenCalled();
      } finally {
        symbols.mockRestore();
      }
    },
  );
});

test("table re-export snapshots exclude stable exports", () => {
  withProgram(
    {
      "main.cjs": 'const { n, stable, fn } = require("./lib.cjs");',
      "lib.cjs": `exports.n = 1;
exports.stable = 1;
exports.stable = 2;
exports.fn = function () { return 7; };
exports.bump = function () { exports.n = 2; };
`,
    },
    (lowerer) => {
      const statement = lowerer.entry.statements.nodes[0]!;
      if (!ts.isVariableStatement(statement)) throw new Error("expected a declaration");
      const decl = statement.declarationList.declarations.nodes[0]!;
      const snapshot = cjsRequireSnapshotBindingsOf(lowerer, decl);
      expect(snapshot).not.toBeNull();
      expect([...snapshot!.bindings.values()].map((binding) => binding.key)).toEqual(["n"]);
    },
  );
});

test.for([
  ["named re-export", 'export { n } from "./lib.cjs";'],
  ["star re-export", 'export * from "./lib.cjs";'],
] as const)("ES-module %s links copies of changing CommonJS exports", ([, reexport]) => {
  withProgram(
    {
      "main.mjs": 'import { n } from "./mid.mjs";\nconsole.log(n);',
      "mid.mjs": reexport,
      "lib.cjs": "exports.n = 7;\nexports.bump = function () { exports.n = exports.n + 1; };",
    },
    (lowerer) => {
      const mid = lowerer.program.getSourceFiles().find((sf) => sf.fileName.endsWith("mid.mjs"))!;
      const lib = lowerer.program.getSourceFiles().find((sf) => sf.fileName.endsWith("lib.cjs"))!;
      lowerer.collectProgram(lowerer.splitFiles());
      expect(cjsAccessorSnapshotStores(lowerer, lib, mid.statements.nodes[0]!)).toHaveLength(1);
    },
    "main.mjs",
  );
});

/** Parses one CommonJS source file of a fixture program. */
function parse(name: string, source: string): ts.SourceFile {
  return parseSourceFile(`/p/${name}`, source, "js");
}

/** Names a program module this fixture's `require("<spec>")` call
 * re-exports: a stub for the resolver the lowering path supplies. */
function reExports(
  ...targets: [string, ts.SourceFile][]
): (expr: ts.Expression) => ts.SourceFile | null {
  return (expr) => {
    let e = expr;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return null;
    if (e.expression.text !== "require" || e.arguments.nodes.length !== 1) return null;
    const spec = e.arguments.nodes[0]!;
    if (!ts.isStringLiteralLike(spec)) return null;
    return targets.find(([name]) => name === spec.text)?.[1] ?? null;
  };
}

test("attaches members written through module.exports after a re-export", () => {
  const inner = parse("y.cjs", `module.exports = { a: 1, b: 2 };`);
  const outer = parse("x.cjs", `module.exports = require("./y.cjs");\nmodule.exports.extra = 3;\n`);
  expect(cjsTableExportNamesOf(outer, 0, reExports(["./y.cjs", inner]))).toEqual([
    "a",
    "b",
    "extra",
  ]);
});

test("keeps the re-export chain when the assignment rebinds exports", () => {
  const inner = parse("y.cjs", `module.exports = { c: 5 };`);
  const outer = parse(
    "z.cjs",
    `exports = module.exports = require("./y.cjs");\nexports.more = 4;\n`,
  );
  expect(cjsTableExportNamesOf(outer, 0, reExports(["./y.cjs", inner]))).toEqual(["c", "more"]);
});

test("drops an exports.f write the re-export's assignment detached", () => {
  // `exports` still names the replaced object, so Node never shows the
  // member: the names must not either.
  const inner = parse("y.cjs", `module.exports = { a: 1 };`);
  const outer = parse("x.cjs", `module.exports = require("./y.cjs");\nexports.dropped = 2;\n`);
  expect(cjsTableExportNamesOf(outer, 0, reExports(["./y.cjs", inner]))).toEqual(["a"]);
});

test("a literal table keeps its keys and the members attached after it", () => {
  const outer = parse("t.cjs", `module.exports = { x: 1 };\nmodule.exports.y = 2;\n`);
  expect(cjsTableExportNamesOf(outer, 0, reExports())).toEqual(["x", "y"]);
});

test("a member that repeats a re-exported key keeps its first position", () => {
  const inner = parse("y.cjs", `module.exports = { a: 1, b: 2 };`);
  const outer = parse(
    "x.cjs",
    `module.exports = require("./y.cjs");\nmodule.exports.a = 9;\nmodule.exports.c = 3;\n`,
  );
  expect(cjsTableExportNamesOf(outer, 0, reExports(["./y.cjs", inner]))).toEqual(["a", "b", "c"]);
});

test("an unresolved re-export has no statically known keys", () => {
  const outer = parse("x.cjs", `module.exports = require("./missing.cjs");\n`);
  expect(cjsTableExportNamesOf(outer, 0, reExports())).toBeNull();
});
