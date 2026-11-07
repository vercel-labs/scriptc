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
