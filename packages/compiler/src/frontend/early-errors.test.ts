import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflight, loadProgram } from "./program-node.js";

/** The preflight diagnostics of a CommonJS script (sloppy unless it says
 * "use strict"). */
function diagnostics(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-early-errors-"));
  writeFileSync(join(directory, "main.cjs"), source);
  const load = loadProgram(join(directory, "main.cjs"));
  try {
    return checkPreflight(load).map((diagnostic) => diagnostic.code);
  } finally {
    load.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

test.for([
  // A function body's top-level function declarations are var-scoped, so
  // duplicates are legal in strict code too.
  'function outer() { "use strict"; function d() {} function d() {} }\nouter();',
  "class C { static { function s() {} function s() {} } }\nnew C();",
  // Object literal methods and accessors are sloppy unless they say otherwise.
  "var o = { m() { if (true) function f() {} } };\no.m();",
  "var o = { get g() { { function h() {} function h() {} } return 1; } };\no.g;",
  // A function's own directive makes its body strict, not the code declaring it.
  'if (true) function k() { "use strict"; }',
  '{ function z() { "use strict"; } function z() {} }',
])("Node accepts: %s", (source) => {
  expect(diagnostics(source)).toEqual([]);
});

test.for([
  ["function outer() { let d; function d() {} }\nouter();", "SC0006"],
  ['(() => { "use strict"; if (true) function f() {} })();', "SC0007"],
  ["class C { m() { if (true) function f() {} } }\nnew C().m();", "SC0007"],
  ['var o = { m() { "use strict"; { function h() {} function h() {} } } };\no.m();', "SC0005"],
])("Node refuses: %s", ([source, code]) => {
  expect(diagnostics(source!)).toContain(code);
});

test.for([
  // Legal destructuring assignment and for-in/of heads: a variable, a
  // property access, or a pattern of them.
  "var a, b;\n[a, b] = [1, 2];\nconsole.log(a, b);",
  "var o = {};\n({ x: o.y = 1, ...o.rest } = { x: 2 });\nconsole.log(o.y);",
  "var o = {};\n[o.a = 1, ...o.r] = [2];\nconsole.log(o.a);",
  "var a;\nfor ([a] of [[1]]) a;\nfor ({ a } of [{ a: 2 }]) a;\nconsole.log(a);",
  // A rest element and the target of a default hold a pattern as well.
  "var a, b;\n[ ...[a] ] = [[1]];\n[ [b] = [2] ] = [];\nconsole.log(a, b);",
  "var a;\n({ x: [a] = [3] } = {});\nconsole.log(a);",
  // Parentheses are transparent around a target.
  "var a;\n((a)) = 1;\nconsole.log(a);",
  "var a;\n[ ...(a) ] = [1];\nconsole.log(a);",
  // A private name is readable anywhere an enclosing class declares it.
  "class C { #x = 1; m() { return this.#x; } static s() { return new C().#x; } }\nnew C().m();",
  "class C { #x = 1; m() { class D { #x = 2; y = this.#x; } return new D().y; } }\nnew C().m();",
  "class C { #x = 1; m(o) { return #x in o; } }\nnew C().m(new C());",
])("Node accepts (early targets): %s", (source) => {
  expect(diagnostics(source)).toEqual([]);
});

test.for([
  ["import('a', {}, '');", "SC0008"],
  ["import();", "SC0008"],
  ["import('a', {}, {});", "SC0008"],
  ["import('a') -= 1;", "SC0010"],
  ["var f = function () {};\nf() += 1;", "SC0010"],
  ["var a;\n++a.b();", "SC0010"],
  // A pattern never sits inside parentheses, and an object's rest target
  // takes a reference only.
  ["var a;\n[ ([a]) ] = [[1]];", "SC0010"],
  ["var a;\n({ ...[a] } = {});", "SC0010"],
  ["var C = class { m() { this.#x; } };\nnew C().m();", "SC0009"],
  ["class C { #x; }\nnew C().#y;", "SC0009"],
  // `#x in obj` is readable wherever `#x` is in scope (the accepts list
  // above), and `#x` in no class's scope is a SyntaxError.
  ["class C { #x; }\nconsole.log(#x in {});", "SC0009"],
])("Node refuses (early targets): %s", ([source, code]) => {
  expect(diagnostics(source!)).toContain(code);
});
