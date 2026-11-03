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

/** The preflight diagnostics of an ES module (`.mjs`), the goal symbol the
 * [Await] and top-level-`using` rules differ under. */
function moduleDiagnostics(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-early-errors-"));
  writeFileSync(join(directory, "main.mjs"), source);
  const load = loadProgram(join(directory, "main.mjs"));
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

/* `await` is a ReservedWord in the contexts whose grammar passes [Await]
 * down: an async function's body and parameters, a class static block, a
 * module's top level — and an arrow's PARAMETERS inherit that, while an
 * arrow's BODY and a class field initializer reset it. Node is the oracle
 * for every row below. */
test.for([
  // [Await] false: a plain function's parameter default, an arrow body, a
  // field initializer, and the IdentifierName slots.
  "function f(a = await) { return a; }\nconsole.log(f(2));",
  "async function f() { (() => { var await = 1; return await; })(); }\nf();",
  "async function f() { function g() { return 1; } return g(); }\nf();",
  "class C { x = await2; }\nnew C();",
  "class C { static { var o = { await: 1 }; console.log(o.await); } }\nnew C();",
  "class C { await() { return 1; } }\nconsole.log(new C().await());",
  // A member's computed name is evaluated where the member is defined, so an
  // async method's own [Await] does not reach its name.
  "function outer() { var await = 'm'; class C { async [await]() {} } return new C(); }\nconsole.log(outer());",
  "function outer() { var await = 'k'; return { async [await]() { return 1; } }; }\nconsole.log(outer());",
  // `let`/`const` at the top level of a script are ordinary declarations:
  // the Using bit is what SC0013 reads, and Const carries its own bit.
  "const a = 1;\nlet b = 2;\nconsole.log(a + b);",
])("Node accepts (await as an identifier): %s", (source) => {
  expect(diagnostics(source)).toEqual([]);
});

test.for([
  // The checker already refuses these two with its own diagnostic; the
  // early-error pass names the same site under the rule it belongs to.
  ["async function f() { var await = 1; }\nf();", "SC0011"],
  ["async function f(await) {}\nf();", "SC0011"],
  // tsc accepts these two, and Node does not.
  ["class C { static { ((x = await) => 0); } }\nnew C();", "SC0011"],
  ["async () => { (a = await) => 0; };", "SC0011"],
])("Node refuses (await as an identifier): %s", ([source, code]) => {
  expect(diagnostics(source!)).toContain(code);
});

test.for([
  // A module's top level is an [Await] context, but a destructuring rename's
  // property name is an IdentifierName there, not a binding.
  "const { await: renamed } = { await: 1 };\nconsole.log(renamed);",
  "function f({ await: renamed }) { return renamed; }\nconsole.log(f({ await: 2 }));",
])("Node accepts (await as an IdentifierName in a module): %s", (source) => {
  expect(moduleDiagnostics(source)).toEqual([]);
});

test.for([
  // The binding side of the same pattern is a BindingIdentifier, and in a
  // module that is the reserved word.
  ["var await = 1;\nconsole.log(await);", "SC0011"],
  ["const { await } = { await: 1 };\nconsole.log(await);", "SC0011"],
])("Node refuses (await as a binding in a module): %s", ([source, code]) => {
  expect(moduleDiagnostics(source!)).toContain(code);
});

test.for([
  // ContainsArguments stops at a function expression and never sees a
  // method's own arguments or a computed element name.
  "class C { x = function () { return arguments.length; }; }\nnew C().x();",
  "class C { m() { return arguments.length; } }\nnew C().m();",
  "class C { [arguments2] = 1; }\nnew C();",
])("Node accepts (arguments outside a field initializer): %s", (source) => {
  expect(diagnostics(source)).toEqual([]);
});

test.for([
  ["class C { x = arguments; }\nnew C();", "SC0012"],
  ["class C { static x = arguments; }\nnew C();", "SC0012"],
  ["class C { x = (() => arguments); }\nnew C().x();", "SC0012"],
  ["class C { static { arguments; } }\nnew C();", "SC0012"],
])("Node refuses (arguments in a field initializer): %s", ([source, code]) => {
  expect(diagnostics(source!)).toContain(code);
});

test.for([
  // A block, a function body, and a class static block all admit `using`.
  "{ class R { [Symbol.dispose]() {} } using r = new R(); }",
  "function f() { class R { [Symbol.dispose]() {} } using r = new R(); }\nf();",
  "class C { static { class R { [Symbol.dispose]() {} } using r = new R(); } }\nnew C();",
])("Node accepts (nested using): %s", (source) => {
  expect(diagnostics(source)).toEqual([]);
});

test.for([
  ["class R { [Symbol.dispose]() {} }\nusing r = new R();", "SC0013"],
  ["class R { [Symbol.dispose]() {} }\nawait using r = new R();", "SC0013"],
])("Node refuses (script-top-level using): %s", ([source, code]) => {
  expect(diagnostics(source!)).toContain(code);
});

test.for([
  // Strict mode narrows the assignment target: `eval` and `arguments` stay
  // ordinary names in sloppy code and as property names.
  "var [eval2] = [1];\nconsole.log(eval2);",
  "var o = {};\no.eval = 1;\nconsole.log(o.eval);",
])("Node accepts (sloppy eval/arguments targets): %s", (source) => {
  expect(diagnostics(source)).toEqual([]);
});

test.for([
  ['"use strict";\narguments = 1;', "SC0014"],
  ['"use strict";\n([eval] = [1]);', "SC0014"],
  ['"use strict";\nfor (arguments of [1]) break;', "SC0014"],
])("Node refuses (strict eval/arguments targets): %s", ([source, code]) => {
  expect(diagnostics(source!)).toContain(code);
});

test.for([
  // A `var` in the catch block is Annex B's, and a nested block is a
  // different Block.
  "try {} catch (e) { var e; }\nconsole.log(typeof e);",
  "try { throw 1; } catch (e) { { function e() {} } }",
])("Node accepts (catch block declarations): %s", (source) => {
  expect(diagnostics(source)).toEqual([]);
});

test.for([
  ["try {} catch (e) { function e() {} }", "SC0015"],
  ['"use strict";\ntry {} catch (e) { function e() {} }', "SC0015"],
  ["try {} catch ([e]) { function e() {} }", "SC0015"],
])("Node refuses (catch parameter redeclared): %s", ([source, code]) => {
  expect(diagnostics(source!)).toContain(code);
});
