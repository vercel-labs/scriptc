import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// Object.prototype and Error.prototype refuse mutation outside the object
// model build, and the intrinsic fill keeps that boundary: their existing
// members still refuse a write, delete or redefinition with SC1090, and a key
// the table does not name is an ordinary property of the now extensible
// object. The other intrinsic prototypes take the write as before this table
// existed, except the wrappers and Date (the next test; t262-da A2): replacing
// an Array or Map member is still the open DA-2 decision.
test("the filled Object.prototype and Error.prototype keep their mutation fence", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-intrinsic-refusals-"));
  const entry = join(outDir, "main.cjs");
  writeFileSync(
    entry,
    `
function attempt(label, run) {
  try { console.log(label, run()); } catch (error) { console.log(label, error.name, error.code, error.message); }
}
attempt("object-write", () => { Object.prototype.hasOwnProperty = function () { return "x"; }; return "wrote"; });
attempt("object-delete", () => { delete Object.prototype.isPrototypeOf; return "deleted"; });
attempt("object-define", () => { Object.defineProperty(Object.prototype, "toString", { value: 1 }); return "defined"; });
attempt("error-delete", () => { delete Error.prototype.toString; return "deleted"; });
attempt("new-key", () => { Object.prototype.added = 7; return Object.prototype.added; });
attempt("array-write", () => { Array.prototype.join = function () { return "x"; }; return "wrote"; });
console.log("new-own", Object.hasOwn(Object.prototype, "added"));
console.log("array-member", typeof Array.prototype.join, Array.prototype.join());
console.log("members-intact", [1, 2].join("-"), typeof [].join, Object.prototype.hasOwnProperty.call([1], "0"));
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
  const refused = (label: string): string =>
    `${label} Error SC1090 replacing a builtin prototype or constructor member is not supported yet`;
  const lines = stdout.trimEnd().split("\n");
  expect(lines.slice(0, 3)).toEqual([
    refused("object-write"),
    refused("object-delete"),
    refused("object-define"),
  ]);
  // Error.prototype keeps the refusal its own lowering gives it.
  expect(lines[3]).toMatch(
    /^error-delete Error SC1090 prototype data on .* are not supported yet \[SC1090 at /,
  );
  expect(lines.slice(4)).toEqual([
    "new-key 7",
    "array-write wrote",
    "new-own true",
    "array-member function x",
    "members-intact 1-2 function true",
  ]);
  expect(stderr).toBe("");
});

// The wrapper prototypes and Date are the write fence's other half (t262-da
// A2): a compiled call site reaches their builtin members natively, so a
// write that replaced one would never be observed, and is refused by name
// instead — as is replacing the prototype itself or writing a key the fence
// cannot read. A new key stays an ordinary property of the prototype object,
// which later reads and reflection answer as in Node.
test("the wrapper prototypes and Date refuse a member write by name", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-intrinsic-wrapper-refusals-"));
  const entry = join(outDir, "main.cjs");
  writeFileSync(
    entry,
    `
function attempt(label, run) {
  try { console.log(label, run()); } catch (error) { console.log(label, error.name, error.code, error.message.split(" [")[0]); }
}
attempt("number-write", () => { Number.prototype.toFixed = function () { return "x"; }; return (1).toFixed(1); });
attempt("boolean-write", () => { Boolean.prototype.toString = function () { return "x"; }; return true.toString(); });
attempt("string-delete", () => { delete String.prototype.slice; return "abc".slice(1); });
attempt("symbol-define", () => { Object.defineProperty(Symbol.prototype, "toString", { value: 1 }); return Symbol("s").toString(); });
attempt("bigint-write", () => { BigInt.prototype.toString = function () { return "x"; }; return (1n).toString(); });
attempt("date-write", () => { Date.prototype.getTime = function () { return 42; }; return new Date(0).getTime(); });
attempt("prototype-replace", () => { Number.prototype = {}; return 1; });
attempt("dynamic-key", () => { const key = "toFixed"; Number.prototype[key] = 1; return 1; });
attempt("globalThis-write", () => { globalThis.Number.prototype.toFixed = function () { return "x"; }; return (1.5).toFixed(1); });
attempt("globalThis-date", () => { globalThis.Date.prototype.getTime = function () { return 0; }; return new Date(0).getTime(); });
attempt("number-new-key", () => { Number.prototype.added = 7; return Number.prototype.added; });
attempt("date-new-key", () => { Date.prototype.added = 8; return Date.prototype.added; });
console.log("natives", (1.25).toFixed(1), "abc".slice(1), true.toString(), Symbol("s").toString(), (1n).toString(), new Date(0).getTime());
console.log("added-own", Object.hasOwn(Number.prototype, "added"), Object.hasOwn(Date.prototype, "added"));
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
  const refused = (label: string, target: string): string =>
    `${label} Error SC1090 writing '${target}' (a compiled call site calls the native member, so the replacement would never be observed) is not supported yet`;
  expect(stdout.trimEnd().split("\n")).toEqual([
    refused("number-write", "Number.prototype.toFixed"),
    refused("boolean-write", "Boolean.prototype.toString"),
    refused("string-delete", "String.prototype.slice"),
    refused("symbol-define", "Symbol.prototype.toString"),
    refused("bigint-write", "BigInt.prototype.toString"),
    refused("date-write", "Date.prototype.getTime"),
    refused("prototype-replace", "Number.prototype"),
    refused("dynamic-key", "Number.prototype"),
    refused("globalThis-write", "Number.prototype.toFixed"),
    refused("globalThis-date", "Date.prototype.getTime"),
    "number-new-key 7",
    "date-new-key 8",
    "natives 1.3 bc true Symbol(s) 1 0",
    "added-own true true",
  ]);
  expect(stderr).toBe("");
});
