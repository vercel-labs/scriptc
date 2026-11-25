import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// A static member of a builtin constructor read through an untyped value has
// Node's name and length. One the program holds no function value for throws
// SC1090 when called, and the members with function values run.
test("static members of untyped builtin constructor values without a function value refuse when called", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-builtin-static-refusals-"));
  const entry = join(outDir, "main.cjs");
  writeFileSync(
    entry,
    `
function constructorNamed(name) {
  return globalThis[name];
}
function attempt(run) {
  try { console.log(run()); } catch (error) { console.log(error.name, error.code, error.message); }
}
const promise = constructorNamed("Promise");
const string = constructorNamed("String");
const object = constructorNamed("Object");
console.log(promise.resolve.name, promise.resolve.length, string.raw.length);
attempt(() => promise.resolve(1));
attempt(() => string.raw({ raw: ["a"] }));
attempt(() => object.keys({ a: 1 }).join());
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
  const refused = (name: string): string =>
    `Error SC1090 '${name}' as a function value (call it directly) is not supported yet [SC1090]`;
  expect(stdout).toBe(
    ["resolve 1 1", refused("Promise.resolve"), refused("String.raw"), "a", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

// A function global's interned value models its own name and length. The
// ECMAScript intrinsic functions own exactly those two keys, while a
// lib-declared function such as setTimeout also owns a prototype the value
// does not model, so asking about that key refuses.
test("own-key probes on function global values model name and length and refuse the prototype", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-builtin-static-refusals-"));
  const entry = join(outDir, "main.cjs");
  writeFileSync(
    entry,
    `
function attempt(run) {
  try { return String(run()); } catch (error) { return error.name + " " + error.code; }
}
const own = (run) => attempt(run);
console.log(own(() => Object.prototype.hasOwnProperty.call(parseInt, "name")), own(() => Object.prototype.hasOwnProperty.call(parseInt, "length")), own(() => Object.prototype.hasOwnProperty.call(parseInt, "prototype")));
console.log(own(() => Object.prototype.hasOwnProperty.call(setTimeout, "name")), own(() => Object.prototype.hasOwnProperty.call(setTimeout, "length")), own(() => Object.prototype.hasOwnProperty.call(setTimeout, "prototype")));
console.log(own(() => Object.prototype.hasOwnProperty.call(atob, "name")), own(() => Object.prototype.hasOwnProperty.call(setTimeout, String("prototype"))));
console.log(attempt(() => Object.prototype.toString.call(setTimeout)));
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
      "true true false",
      "true true Error SC2020",
      "true Error SC2020",
      "[object Function]",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

// A module function with a direct-call lowering and no function value keeps
// loading when it is only stored: reading util.getCallSites answers Node's
// function (typeof, identity and length), and calling that value is the
// deferred refusal.
test("storing util.getCallSites answers a callable and refuses only when it is called", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-builtin-static-refusals-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(
    entry,
    `
import { getCallSites } from "node:util";
const stored = getCallSites;
console.log(typeof stored, stored === getCallSites, stored.length);
try {
  stored();
  console.log("no throw");
} catch (error) {
  const e = error as { code?: string };
  console.log("caught", e.code);
}
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
  expect(stdout).toBe("function true 0\ncaught SC2020\n");
  expect(stderr).toBe("");
});
