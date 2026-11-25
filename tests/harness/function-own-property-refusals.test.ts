import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// A function value answers hasOwnProperty from its dynamic view, which holds
// a function's `prototype` only once something has created the closure's
// property table, and never holds a generator's. Answering `false` there
// would be wrong for every function declaration, so that one key refuses
// with a catchable error, whether the source spells it or a variable holds
// it; every other key keeps its answer.
test("hasOwnProperty('prototype') on a function value refuses", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-function-own-refusals-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(
    entry,
    `
function declared() {}
function* generator() {}
function attempt(run) {
  try { console.log(run()); } catch (error) { console.log(error.name, error.code, error.message.split(" [")[0]); }
}
attempt(() => declared.hasOwnProperty("name"));
attempt(() => declared.hasOwnProperty("prototype"));
attempt(() => generator.hasOwnProperty("prototype"));
for (const key of ["length", "prototype", "caller"]) attempt(() => declared.hasOwnProperty(key));
`,
  );
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  const refused =
    "Error SC2020 'Object.prototype.hasOwnProperty(\"prototype\") over a () => void receiver' is part of the standard library types but has no scriptc lowering yet";
  expect(stdout).toBe(
    [
      "true",
      refused,
      refused.replace("() => void", "() => Generator<void, void, unknown>"),
      "true",
      refused,
      "false",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

// `fn.constructor = value` in a JavaScript source is the ordinary assignment
// with the function as its receiver (corpus 9412 to 9414). The writes the
// function's chain refuses keep the runtime's refusal of the name: Node
// answers them with a TypeError that prints the function's source text, in
// strict code, and with nothing in sloppy code. The chain is read through
// the functions on it, so the refusal holds at any depth; a function that
// only refuses new properties gets Node's own error, which names no source.
test("a write of 'constructor' that the function's chain refuses keeps its refusal", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-function-constructor-refusals-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(
    entry,
    `
function attempt(label, run) {
  try {
    run();
    console.log(label, "written");
  } catch (error) {
    console.log(label, error.name, error.code, error.message.split(" [")[0]);
  }
}
const getterOnly = {
  get constructor() {
    return "fixed";
  },
};
const readOnly = Object.freeze({ constructor: "fixed" });
function viaGetter() {}
Object.setPrototypeOf(viaGetter, getterOnly);
function viaReadOnly() {}
Object.setPrototypeOf(viaReadOnly, readOnly);
const direct = () => 1;
Object.setPrototypeOf(direct, getterOnly);
const through = () => 2;
Object.setPrototypeOf(through, viaGetter);
const frozenAbove = () => 3;
Object.setPrototypeOf(frozenAbove, viaReadOnly);
const frozen = () => 4;
frozen.constructor = "mine";
Object.freeze(frozen);
const closed = () => 5;
Object.preventExtensions(closed);
const free = () => 6;
attempt("direct", () => {
  direct.constructor = 1;
});
attempt("through", () => {
  through.constructor = 2;
});
attempt("frozenAbove", () => {
  frozenAbove.constructor = 3;
});
attempt("frozen", () => {
  frozen.constructor = 4;
});
attempt("closed", () => {
  closed.constructor = 5;
});
attempt("free", () => {
  free.constructor = 6;
});
console.log([direct, through, frozenAbove, closed, free].map((fn) => Object.hasOwn(fn, "constructor")).join(" "));
`,
  );
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  const refused = "Error SC2020 scriptc: overriding builtin function properties is not supported";
  expect(stdout).toBe(
    [
      `direct ${refused}`,
      `through ${refused}`,
      `frozenAbove ${refused}`,
      `frozen ${refused}`,
      "closed TypeError undefined Cannot add property constructor, object is not extensible",
      "free written",
      "false false false false true",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});
