import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const sanitize = process.env["SCRIPTC_SAN"] === "1";

// Static member calls (`Math.abs(x)`) do not read the namespace objects, so
// a change to a function member's value that the build cannot see (the
// object and the key arrive as values) fences at run time (SC1090) instead
// of leaving those calls with the original; the spellings the build can see
// are refused there (SC1092, tests/diagnostics/builtin-member-write*). New
// properties and attribute-only changes behave as in Node (corpus 7188).
test("replacing or deleting a namespace member fences", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-namespace-fences-"));
  try {
    const entry = join(dir, "main.js");
    writeFileSync(
      entry,
      `
function set(object, key, value) { object[key] = value; }
function define(object, key, descriptor) { return Object.defineProperty(object, key, descriptor) === object; }
function copy(object, source) { return Object.assign(object, source) === object; }
function remove(object, key) { return delete object[key]; }
function read(object, key) { return object[key]; }
function attempt(label, run) {
  try { console.log(label, run()); } catch (error) { console.log(label, error.code); }
}
attempt("write", () => { set(Math, "abs", () => 0); return "replaced"; });
attempt("computed", () => { set(Math, ["m", "ax"].join(""), () => 0); return "replaced"; });
attempt("define", () => define(Math, "min", { value: () => 0 }));
attempt("same", () => Object.defineProperty(Math, "min", { value: Math.min, enumerable: true }) === Math);
attempt("reflect", () => Reflect.set(JSON, ["par", "se"].join(""), () => 0));
attempt("assign", () => copy(Math, { floor: 1 }));
attempt("delete", () => remove(Math, "ceil"));
attempt("added", () => { set(Math, "extra", 5); return read(Math, "extra"); });
console.log(Math.abs(-1), Math.max(1, 2), Math.min(1, 2), JSON.parse("[3]")[0], Math.floor(1.5), Math.ceil(1.5));
console.log(Object.keys(Math).join(","));
`,
    );
    const result = await compile(entry, {
      backend: "llvm",
      sanitize,
      outDir: dir,
      outPath: join(dir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(
      [
        "write SC1090",
        "computed SC1090",
        "define SC1090",
        "same true",
        "reflect SC1090",
        "assign SC1090",
        "delete SC1090",
        "added 5",
        "1 2 1 3 1 2",
        "min,extra",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A member added to a built-in prototype is read only by arrays: an untyped
// array consults Array.prototype, and no other built-in's values look at
// their prototype object. Node answers 7 for every line below; a compiled
// program would answer undefined for all but the array, so the write is
// refused (SC1093, a run-time fence in a JavaScript source), directly and
// through a `const` alias of the prototype.
test("adding a member to a built-in prototype is refused unless arrays read it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-prototype-adds-"));
  try {
    const entry = join(dir, "main.js");
    writeFileSync(
      entry,
      `
function attempt(label, run) {
  try { console.log(label, run()); } catch (error) { console.log(label, /\\[(SC\\d{4}) at/.exec(error.message)?.[1] ?? error.message); }
}
attempt("array", () => { Array.prototype.added = 7; return [1].added; });
attempt("array alias", () => { const p = Array.prototype; p.viaAlias = 7; return [1].viaAlias; });
attempt("map", () => { Map.prototype.added = 7; return new Map().added; });
attempt("map alias", () => { const p = Map.prototype; p.added = 7; return new Map().added; });
attempt("set define", () => { Object.defineProperty(Set.prototype, "added", { value: 7 }); return new Set().added; });
attempt("weakmap", () => { WeakMap.prototype.added = 7; return new WeakMap().added; });
attempt("number", () => { Number.prototype.added = 7; return (1).added; });
attempt("function", () => { Function.prototype.added = 7; return (function () {}).added; });
attempt("date alias", () => { const p = Date.prototype; p.added = 7; return new Date(0).added; });
function read(object, key) { return object[key]; }
attempt("namespace", () => { Math.added = 7; return read(Math, "added"); });
attempt("constructor", () => { Array.added = 7; return read(Array, "added"); });
`,
    );
    const result = await compile(entry, {
      backend: "llvm",
      sanitize,
      outDir: dir,
      outPath: join(dir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(
      [
        "array 7",
        "array alias 7",
        "map SC1093",
        "map alias SC1093",
        "set define SC1093",
        "weakmap SC1093",
        "number SC1093",
        "function SC1093",
        "date alias SC1093",
        "namespace 7",
        "constructor 7",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
