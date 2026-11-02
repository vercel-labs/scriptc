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
