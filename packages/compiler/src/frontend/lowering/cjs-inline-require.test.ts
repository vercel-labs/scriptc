import { afterAll, expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import { cjsTableExportNamesOf } from "./cjs-inline-require.js";

afterAll(closeSourceParser);

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
