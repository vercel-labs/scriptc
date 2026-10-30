import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// JSON, util.inspect, structuredClone and deep equality cannot read a
// wrapper's [[PrimitiveValue]] slot yet, so a wrapper anywhere in their
// argument refuses with a catchable error instead of a silently wrong
// answer, including one 100 levels deep or under a graph that shares its
// objects. Values without a wrapper keep working in the same program, and
// the search reaches each object once, so a cyclic value is checked in
// linear time.
test("graph-walking consumers refuse primitive wrapper objects", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-wrapper-refusals-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(
    entry,
    `
import util from "node:util";
function attempt(label, run) {
  try { run(); process.stdout.write(label + " ok\\n"); } catch (error) { process.stdout.write(label + " " + error.message + "\\n"); }
}
attempt("json", () => JSON.stringify({ v: new Number(3) }));
attempt("log", () => console.log([new String("a")]));
attempt("clone", () => structuredClone([new Boolean(true)]));
attempt("plain json", () => JSON.stringify({ v: 3 }));
attempt("plain clone", () => structuredClone([true]));
let deep = new String("deep");
for (let i = 0; i < 100; i++) deep = { next: deep };
attempt("deep clone", () => structuredClone(deep));
let shared = [new Number(1)];
for (let i = 0; i < 40; i++) shared = { left: shared, right: shared };
attempt("shared log", () => console.log(shared));
const cyclic = JSON.parse('{ "name": "cyclic" }');
cyclic.self = cyclic;
cyclic.again = cyclic;
attempt("cyclic inspect", () => util.inspect(cyclic));
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
  const refused = (consumer: string): string =>
    `${consumer} of a primitive wrapper object (new String/Number/Boolean or Object(primitive)) is not supported yet`;
  expect(stdout).toBe(
    [
      `json ${refused("JSON.stringify")}`,
      `log ${refused("console.log/util.inspect")}`,
      `clone ${refused("structuredClone")}`,
      "plain json ok",
      "plain clone ok",
      `deep clone ${refused("structuredClone")}`,
      `shared log ${refused("console.log/util.inspect")}`,
      "cyclic inspect ok",
      "",
    ].join("\n"),
  );
});
