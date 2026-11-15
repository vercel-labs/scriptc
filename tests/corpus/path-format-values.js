// path.format from a JavaScript source with values that are not a record
// the compiler can read statically: the runtime reads root, dir, base,
// name and ext as Node's _format does, answers a non-object argument with
// Node's TypeError, and passes a non-string base (joined with the dir as
// Node's template does) through. Both families answer the same way.
import * as path from "node:path";

const describe = (value) =>
  [typeof value, Array.isArray(value), String(value)].join(" ");

/** @type {(label: string, fn: () => unknown) => void} */
function attempt(label, fn) {
  try {
    console.log(label, "ok", describe(fn()));
  } catch (error) {
    console.log(label, "throw", error.name, error.code, error.message);
  }
}

const empty = {};
const bare = Object.create(null);
const noDir = { base: "b.txt" };
const dirBase = { dir: "/a", base: "b.txt" };
const dirNameExt = { dir: "/a", name: "b", ext: ".txt" };
const rootName = { root: "/", name: "b" };
const dirEmptyString = { dir: "", base: "a" };
const winDirBase = { dir: "C:\\a", name: "b", ext: ".txt" };
const partial = { root: "/", dir: "", name: "n", ext: ".e" };

// Records whose fields are strings take the direct path.
for (const [label, value] of [
  ["empty", empty],
  ["bare", bare],
  ["noDir", noDir],
  ["dirBase", dirBase],
  ["dirNameExt", dirNameExt],
  ["rootName", rootName],
  ["dirEmptyString", dirEmptyString],
  ["winDirBase", winDirBase],
  ["partial", partial],
]) {
  attempt(`posix ${label}`, () => path.posix.format(value));
  attempt(`win32 ${label}`, () => path.win32.format(value));
  attempt(`bare ${label}`, () => path.format(value));
}

// A non-object argument is Node's ERR_INVALID_ARG_TYPE naming pathObject.
for (const [label, arg] of [
  ["null", null],
  ["number", 7],
  ["string", "a"],
  ["boolean", true],
  ["array", ["a"]],
  ["boxed", new String("a")],
  ["null prototype", Object.create(null)],
]) {
  attempt(`posix ${label}`, () => path.posix.format(arg));
  attempt(`win32 ${label}`, () => path.win32.format(arg));
}
attempt("posix missing", () => path.posix.format());
attempt("win32 missing", () => path.win32.format());

// A held function takes the same path as the direct call.
const held = path.posix.format;
const heldWin = path.win32.format;
attempt("held empty", () => held(empty));
attempt("held win dir", () => heldWin(winDirBase));

// Node's _format reads each field with `||`, so a truthy non-string value
// reaches the template as it is. These go through an untyped call, which
// hands the value to the same runtime entry a compiled record does.
const call = (family, value) => Reflect.apply(family.format, undefined, [value]);
for (const [label, value] of [
  ["baseNumber", { base: 1 }],
  ["dirNumber", { dir: 1, base: "a" }],
  ["rootNumber", { root: 1, base: "a" }],
  ["nameNumber", { name: 1 }],
  ["extNumber", { ext: 1, name: "a" }],
  ["baseBoxed", { base: new String("a") }],
  ["baseBuffer", { base: ["a"] }],
  ["extBoxed", { ext: new String(".x"), name: "a" }],
  ["dirTrue", { dir: true, base: "a" }],
]) {
  attempt(`call posix ${label}`, () => call(path.posix, value));
  attempt(`call win32 ${label}`, () => call(path.win32, value));
}

// The same untyped lane validates a non-object argument with Node's error.
attempt("call posix number", () => call(path.posix, 7));
attempt("call posix null", () => call(path.posix, null));
attempt("call win32 array", () => call(path.win32, ["x"]));
attempt("call win32 string", () => call(path.win32, "a"));
attempt("call posix empty", () => call(path.posix, empty));
