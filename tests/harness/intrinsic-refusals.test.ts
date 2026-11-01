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
// object. Every other intrinsic takes the write as before this table existed
// (t262-da §4.3 item 5, narrowed; refusing those as well is the open DA-2
// decision).
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
