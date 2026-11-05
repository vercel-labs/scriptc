/* Static-object specialization (shape-inference/static-objects.ts) keeps two
 * reads dynamic when the facts it would fold on can change:
 * - a member stored after a statement that can run code (a coercion such as
 *   `+` can call toString or valueOf) keeps its read in functions, which
 *   that code could call before the store (the statements checked are all
 *   the file's top-level statements before the store);
 * - a table call whose key parameter the function rebinds (destructuring,
 *   a loop target, another parameter's default or a `var` redeclaration)
 *   keeps reading the table for other keys, though every caller passes one
 *   of the table's keys;
 * - so does one whose function is called through `call` or `apply`, where
 *   the first argument is the this value and not the key.
 * The checks read the rewritten package text SCRIPTC_DEBUG_SHAPE_OVERLAY
 * prints. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compile } from "../src/index.js";

const packageSource = `var quiet = quiet || {};
quiet.cfg = { U: 1 };
quiet.read = function () {
  return quiet.cfg.V;
};
quiet.label = quiet.cfg.U;
quiet.cfg.V = 6;

var late = late || {};
late.cfg = { U: 1 };
late.read = function () {
  return late.cfg.V;
};
late.label = "v" + late.cfg.U;
late.cfg.V = 5;

var t = t || {};
t.ops = {
  a: function (v) {
    return v + 1;
  },
  b: function (v) {
    return v * 2;
  },
};
t.plain = function (op, v) {
  return t.ops[op](v);
};
t.pattern = function (op, v) {
  [op] = ["c"];
  return t.ops[op](v);
};
t.loop = function (op, v) {
  for (op of ["c"]);
  return t.ops[op](v);
};
t.initializer = function (op, v, w = (op = "c")) {
  return t.ops[op](v);
};
t.redeclared = function (op, v) {
  var op = "c";
  return t.ops[op](v);
};
t.viaCall = function (op, v) {
  return t.ops[op](v);
};
t.viaApply = function (op, v) {
  return t.ops[op](v);
};
module.exports = { late, quiet, t };
`;

const consumer = `const { late, quiet, t } = require("guard-fixture");
console.log(late.read(), late.label, quiet.read(), quiet.label);
const tryCall = (call) => {
  try {
    return call();
  } catch (e) {
    return e.name;
  }
};
console.log(t.plain("a", 1), t.plain("b", 2));
console.log(tryCall(() => t.pattern("a", 1)), tryCall(() => t.loop("b", 2)));
console.log(tryCall(() => t.initializer("a", 1)), tryCall(() => t.redeclared("b", 2)));
console.log(tryCall(() => t.viaCall.call("a", "c", 1)), tryCall(() => t.viaApply.apply("b", ["c", 2])));
`;

let dir = "";
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scriptc-static-guards-"));
  const pkg = join(dir, "node_modules/guard-fixture");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "guard-fixture", version: "1.0.0", main: "index.js" }),
  );
  await writeFile(join(pkg, "index.js"), packageSource);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { "guard-fixture": "1.0.0" } }),
  );
  await writeFile(join(dir, "main.cjs"), consumer);
  for (const k of ["SCRIPTC_SHAPE_OVERLAY", "SCRIPTC_DEBUG_SHAPE_OVERLAY", "SCRIPTC_NO_CACHE"])
    saved[k] = process.env[k];
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The package text after the structural rewrites. */
async function rewrittenPackage(): Promise<string> {
  process.env["SCRIPTC_SHAPE_OVERLAY"] = "1";
  process.env["SCRIPTC_DEBUG_SHAPE_OVERLAY"] = "1";
  process.env["SCRIPTC_NO_CACHE"] = "1";
  let text = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  });
  const result = await compile(join(dir, "main.cjs"), {
    outDir: dir,
    outPath: join(dir, "main.ir.json"),
    outputKind: "ir",
    npmStatic: ["guard-fixture"],
  });
  vi.restoreAllMocks();
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  const start = text.indexOf("[static-objects] ");
  const end = text.indexOf("[shape-overlay] ", start);
  return start < 0 ? "" : text.slice(start, end < 0 ? undefined : end);
}

/** The body of the function the rewritten text assigns to or hoists as `name`. */
function body(text: string, name: string): string {
  const at = text.search(new RegExp(`function [\\w$]*${name}\\b|${name} = function`));
  return at < 0 ? "" : text.slice(at, text.indexOf("\n}", at));
}

test("a store after code that can run keeps the read; a quiet prefix folds it", async () => {
  const text = await rewrittenPackage();
  expect(body(text, "quiet_read")).toMatch(/return \(.*\b6\);/);
  expect(body(text, "late_read")).toContain("return late.cfg.V");
});

test("a table call whose key parameter is rebound keeps reading the table", async () => {
  const text = await rewrittenPackage();
  // Every caller passes "a" or "b": the plain call needs no arm for other keys.
  expect(body(text, "t_plain")).not.toContain("t.ops[op](v)");
  for (const name of ["t_pattern", "t_loop", "t_initializer", "t_redeclared"])
    expect(body(text, name), name).toContain("t.ops[op](v)");
});

test("a table call whose function is called through call or apply keeps reading the table", async () => {
  // The first argument of those calls, a key of the table, is the this
  // value; the key each call passes, "c", is not one.
  const text = await rewrittenPackage();
  for (const name of ["t_viaCall", "t_viaApply"])
    expect(body(text, name), name).toContain("t.ops[op](v)");
});
