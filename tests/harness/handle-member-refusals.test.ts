import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// Own properties added to a runtime handle reach a property table keyed by
// the native handle (scr_dyn_handle_props.c). A key that names a class
// member is granted per class and name when the program's JavaScript writes
// it, and the calls, reads, writes and deletes of that name go through the
// checked-dynamic box (handle-properties.ts), so a replaced toString or
// valueOf answers implicit conversions too. A member a builtin algorithm
// reads natively (exec, size, then, lastIndex, …) stays refused, and a typed
// conversion of a handle whose class the program granted the method it reads
// refuses at compile time rather than diverging. A graph walker reaching a
// handle with added properties refuses for the same reason: it cannot see
// the table yet.
async function run(source: string): Promise<{ stdout: string; stderr: string }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-handle-member-refusals-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { stdout: "", stderr: "" };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

test("denied member keys, freeze and the graph walkers refuse a handle's own properties", async () => {
  const { stdout, stderr } = await run(`"use strict";
function attempt(label, run) {
  try { run(); process.stdout.write(label + " no error\\n"); }
  catch (error) { process.stdout.write(label + " " + error.message + "\\n"); }
}
attempt("protocol set", () => { const re = /a/; re.exec = () => null; });
attempt("native set", () => { const m = new Map(); m.size = 1; });
attempt("denied define", () => { const m = new Map(); Object.defineProperty(m, "size", { value: 1 }); });
attempt("inspect", () => { const d = new Date(0); d.x = 1; console.log(d); });
attempt("diamond", () => { const d = new Date(0); d.x = 1; const g = { d }; g.left = g; g.right = g; console.log(g); });
attempt("diamond list", () => { const d = new Date(0); d.x = 1; const g = { d }; g.left = g; g.right = g; console.log("a", g, g); });
attempt("freeze", () => { const r = /a/; r.x = 1; Object.freeze(r); });
`);
  // The write fences carry the source location of the generated program.
  const lines = stdout.split("\n").map((line) => line.replace(/ \[SC1090 at [^\]]*\]$/, ""));
  expect(lines).toEqual([
    "protocol set assignment to non-variables are not supported yet",
    "native set assignment to non-variables are not supported yet",
    "denied define Object.defineProperty of the Map member 'size' is not supported yet",
    "inspect console.log/util.inspect of a Date, RegExp, Map, Set or buffer with added own properties is not supported yet",
    "diamond console.log/util.inspect of a Date, RegExp, Map, Set or buffer with added own properties is not supported yet",
    "diamond list console.log/util.inspect of a Date, RegExp, Map, Set or buffer with added own properties is not supported yet",
    "freeze Object.freeze of a RegExp is not supported yet",
    "",
  ]);
  expect(stderr).toBe("");
});

test("a shadowed member is called through the property table", async () => {
  const { stdout, stderr } = await run(`"use strict";
const d = new Date(0);
d.getTime = () => 42;
console.log(d.getTime(), d.valueOf());
const m = new Map();
m.get = (key) => "own " + key;
console.log(m.get(1));
`);
  expect(stdout).toBe("42 0\nown 1\n");
  expect(stderr).toBe("");
});

test("an optional call of a shadowed member reads the own property", async () => {
  const { stdout, stderr } = await run(`"use strict";
const d = new Date(0);
d.getTime = () => 42;
console.log("call", d?.getTime(), d.getTime?.());
const m = new Map([[1, "one"]]);
m.get = (key) => "own " + key;
console.log("map", m?.get(1));
const none = null;
console.log("nullish", none?.getTime());
`);
  expect(stdout).toBe("call 42 42\nmap own 1\nnullish undefined\n");
  expect(stderr).toBe("");
});

test("members a builtin reads from the native object stay refused per class", async () => {
  const { stdout, stderr } = await run(`"use strict";
function attempt(label, run) {
  try { run(); process.stdout.write(label + " no error\\n"); }
  catch (error) { process.stdout.write(label + " " + error.message.replace(/ \\[SC\\d+ at [^\\]]*\\]$/, "") + "\\n"); }
}
attempt("set has", () => { const s = new Set([1]); s.has = () => true; });
attempt("map keys", () => { const m = new Map(); m.keys = () => []; });
attempt("date toISOString", () => { const d = new Date(0); d.toISOString = () => "own"; });
attempt("set add", () => { const s = new Set([1]); s.add = (value) => "own " + value; console.log("add", s.add(2), s.has(2)); });
`);
  expect(stdout).toBe(
    "set has assignment to non-variables are not supported yet\n" +
      "map keys assignment to non-variables are not supported yet\n" +
      "date toISOString setting 'toISOString' on a dynamic Date is not supported yet\n" +
      "add own 2 false\n" +
      "set add no error\n",
  );
  expect(stderr).toBe("");
});

test("a Date toJSON refuses the conversion members Node reads through it", async () => {
  const refused = async (shadow: string, member: string) => {
    const { stdout, stderr } = await run(`"use strict";
const d = new Date(0);
${shadow}
try { console.log(d.toJSON()); }
catch (error) { console.log(error.message.replace(/ \\[SC\\d+ at [^\\]]*\\]$/, "")); }
`);
    expect(stderr).toBe("");
    expect(stdout).toBe(
      `toJSON conversion of a Date whose ${member} the program replaces (read the property itself, or delete it first) are not supported yet\n`,
    );
  };
  await refused("d.valueOf = () => 5;", "valueOf");
  await refused('d.toString = () => "own";', "toString");
  // An own property that is not a conversion member leaves toJSON native.
  const { stdout, stderr } = await run(`"use strict";
const d = new Date(0);
d.label = "x";
console.log("plain", d.toJSON());
`);
  expect(stdout).toBe("plain 1970-01-01T00:00:00.000Z\n");
  expect(stderr).toBe("");
});

test("an untyped Date toJSON converts through the own conversion members", async () => {
  // Date.prototype.toJSON is ToPrimitive(this, number), null for a
  // non-finite number, then toISOString. A call through an untyped helper
  // still reads the own valueOf/toString the table carries.
  const { stdout, stderr } = await run(`"use strict";
const d = new Date(0);
d.valueOf = () => NaN;
function toJson(x) {
  return x.toJSON();
}
console.log("valueOf", toJson(d));
d.valueOf = () => 5;
console.log("finite", toJson(d));
d.valueOf = () => ({});
d.toString = () => "text";
console.log("toString", toJson(d));
delete d.valueOf;
delete d.toString;
console.log("restored", toJson(d));
const bad = new Date(NaN);
bad.valueOf = () => 1;
try {
  console.log("invalid", toJson(bad));
} catch (error) {
  console.log("invalid", error.message);
}
`);
  expect(stdout).toBe(
    "valueOf null\n" +
      "finite 1970-01-01T00:00:00.000Z\n" +
      "toString 1970-01-01T00:00:00.000Z\n" +
      "restored 1970-01-01T00:00:00.000Z\n" +
      "invalid Invalid time value\n",
  );
  expect(stderr).toBe("");
});

test("an untyped Date toJSON skips a conversion member that is not callable", async () => {
  // ToPrimitive reads each conversion member and skips one that is not
  // callable, so a valueOf the program set to a non-function falls through to
  // toString instead of throwing "valueOf is not a function".
  const { stdout, stderr } = await run(`"use strict";
function toJson(x) {
  return x.toJSON();
}
const d = new Date(0);
d.valueOf = 5;
console.log("data", toJson(d));
d.toString = 7;
try {
  console.log("both", toJson(d));
} catch (error) {
  console.log("both", error.message);
}
const object = new Date(0);
object.valueOf = { toString() { return 5; } };
console.log("object", toJson(object));
const restored = new Date(0);
restored.valueOf = 5;
delete restored.valueOf;
restored.toString = 7;
console.log("restored", toJson(restored));
`);
  expect(stdout).toBe(
    "data 1970-01-01T00:00:00.000Z\n" +
      "both Cannot convert object to primitive value\n" +
      "object 1970-01-01T00:00:00.000Z\n" +
      "restored 1970-01-01T00:00:00.000Z\n",
  );
  expect(stderr).toBe("");
});

test("implicit conversions of a shadowed Date method read the own property", async () => {
  const { stdout, stderr } = await run(`"use strict";
const d = new Date(0);
d.toString = () => "own";
d.valueOf = () => 42;
console.log("text", \`\${d}\`, String(d), d == "own");
console.log("number", Number(d), +d, -d, d < new Date(1));
delete d.valueOf;
console.log("restored", Number(d));
`);
  expect(stdout).toBe("text own own true\nnumber 42 42 -42 false\nrestored 0\n");
  expect(stderr).toBe("");
});

test("a typed conversion in a mixed program refuses a member the JavaScript replaces", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-handle-member-refusals-"));
  // The grant is whole-program: a JavaScript file shadows Date's toString, so
  // the typed Date conversion in the TypeScript entry cannot stay native.
  writeFileSync(
    join(outDir, "side.js"),
    `export function shadow() {\n  const d = new Date(0);\n  d.toString = () => "own";\n  return d;\n}\n`,
  );
  const entry = join(outDir, "main.ts");
  writeFileSync(
    entry,
    `import { shadow } from "./side.js";\nconst own = new Date(0);\nshadow();\nconsole.log(String(own));\n`,
  );
  const result = await compile(entry, {
    backend: "llvm",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(
    result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`),
  ).toEqual([
    "SC1090 string conversion of a Date whose toString the program replaces (read the property itself, or delete it first) are not supported yet",
  ]);
});

test("a program without handle writes keeps the integrity fence", async () => {
  const { stderr } = await run(`"use strict";
function f(o) { return Object.isExtensible(o); }
console.log(f(new Date(0)));
`);
  expect(stderr).toContain("Object.isExtensible of a Date is not supported yet");
});
