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
