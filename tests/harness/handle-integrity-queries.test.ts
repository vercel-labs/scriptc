import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// Object.isExtensible and Object.isSealed of a checked-dynamic value answer
// from the state the runtime models (a plain object, array, function, class
// instance, Map or Set) and refuse for a native handle or a promise, whose
// integrity state scriptc does not track: Object.preventExtensions and
// Object.seal do not change it and Object.freeze refuses, so any answer
// would be invented where Node answers true/false. These queries answered
// false/true for every handle, a silently wrong result. Object.isFrozen
// already refused for the unmodeled kinds.
test("integrity queries refuse an unmodeled native handle", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-integrity-queries-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(
    entry,
    `
function isExtensible(value) { return Object.isExtensible(value); }
function isSealed(value) { return Object.isSealed(value); }
function attempt(label, run) {
  try { process.stdout.write(label + " " + run() + "\\n"); }
  catch (error) { process.stdout.write(label + " " + error.message + "\\n"); }
}
attempt("date extensible", () => Object.isExtensible(new Date(0)));
attempt("date sealed", () => Object.isSealed(new Date(0)));
attempt("regexp extensible", () => isExtensible(/a/));
attempt("regexp sealed", () => isSealed(/a/));
attempt("buffer extensible", () => Object.isExtensible(new ArrayBuffer(1)));
attempt("weakmap extensible", () => Object.isExtensible(new WeakMap()));
attempt("weakmap sealed", () => Object.isSealed(new WeakMap()));
attempt("promise extensible", () => isExtensible(Promise.resolve(1)));
attempt("promise sealed", () => isSealed(Promise.resolve(1)));
attempt("date frozen", () => Object.isFrozen(new Date(0)));
attempt("promise frozen", () => Object.isFrozen(Promise.resolve(1)));
attempt("object extensible", () => isExtensible({ a: 1 }));
attempt("object sealed", () => isSealed({ a: 1 }));
attempt("array sealed", () => isSealed([1]));
attempt("function sealed", () => Object.isSealed(function named() {}));
attempt("map extensible", () => Object.isExtensible(new Map()));
attempt("set extensible", () => Object.isExtensible(new Set([1])));
class Point { x = 1; }
attempt("instance sealed", () => Object.isSealed(new Point()));
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
  const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  const refused = (what: string, cls: string): string => `${what} of a ${cls} is not supported yet`;
  expect(stdout).toBe(
    [
      `date extensible ${refused("Object.isExtensible", "Date")}`,
      `date sealed ${refused("Object.isSealed", "Date")}`,
      `regexp extensible ${refused("Object.isExtensible", "RegExp")}`,
      `regexp sealed ${refused("Object.isSealed", "RegExp")}`,
      `buffer extensible ${refused("Object.isExtensible", "ArrayBuffer")}`,
      `weakmap extensible ${refused("Object.isExtensible", "WeakMap")}`,
      `weakmap sealed ${refused("Object.isSealed", "WeakMap")}`,
      `promise extensible ${refused("Object.isExtensible", "Promise")}`,
      `promise sealed ${refused("Object.isSealed", "Promise")}`,
      "date frozen Object.isFrozen of this native value has no lowering",
      "promise frozen Object.isFrozen of this native value has no lowering",
      "object extensible true",
      "object sealed false",
      "array sealed false",
      "function sealed false",
      "map extensible true",
      "set extensible true",
      "instance sealed false",
      "",
    ].join("\n"),
  );
});
