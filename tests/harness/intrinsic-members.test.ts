import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// A member the table installs is the runtime's function, so calling it
// through the prototype and through a receiver runs the same operation; the
// primitive wrappers' prototypes are the objects `new String/Number/
// Boolean(v)` instances inherit from, so their members are the same values
// and the prototype object is the value of the kind it wraps.
test("intrinsic prototype members are the runtime's functions", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-intrinsic-members-"));
  const entry = join(outDir, "main.cjs");
  writeFileSync(
    entry,
    `
console.log(Array.prototype.push === [].push);
console.log(Map.prototype.get === new Map().get);
console.log(Object.prototype.hasOwnProperty === {}.hasOwnProperty);
// The prototype's constructor is the program's own X value for the
// primitive wrappers, Symbol and Date as it is for Object: the table's
// constructor member is the graph's twin of that interface, a different
// object.
console.log(
  [
    Symbol.prototype.constructor === Symbol,
    Number.prototype.constructor === Number,
    Boolean.prototype.constructor === Boolean,
    String.prototype.constructor === String,
    BigInt.prototype.constructor === BigInt,
    Date.prototype.constructor === Date,
  ].join(" "),
);
const numberToFixed = Number.prototype.toFixed;
const stringSlice = String.prototype.slice;
const booleanValueOf = Boolean.prototype.valueOf;
console.log(
  [
    new Number(1).toFixed === numberToFixed,
    new String("s").slice === stringSlice,
    new Boolean(true).valueOf === booleanValueOf,
    Object.getPrototypeOf(5) === Number.prototype,
    Number.prototype == 0,
  ].join(" "),
);
const size = Object.getOwnPropertyDescriptor(Map.prototype, "size");
const map = new Map();
map.set("a", 1);
const read = size.get;
console.log(typeof read, typeof read === "function" ? read.call(map) : "none");
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
  expect(stdout).toBe(
    [
      "true",
      "true",
      "true",
      "true true true true true true",
      "true true true true true",
      "function 1",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});
