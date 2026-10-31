import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// The runtime's conversions, iteration and printing of a typed array, Buffer
// or DataView read these members from the prototype, so defining one on the
// view refuses with a catchable error instead of being ignored.
test("typed array members the runtime reads from the prototype refuse as own properties", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-typed-array-refusals-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(
    entry,
    `
function attempt(define) {
  try { define(); console.log("defined"); } catch (error) { console.log(error.name, error.message); }
}
function run(TA, view) {
  const a = new TA(2);
  attempt(() => { a.toString = () => "x"; });
  attempt(() => { a.valueOf = () => 1; });
  attempt(() => Object.defineProperty(a, "toJSON", { value: () => 1 }));
  attempt(() => { a.join = () => ""; });
  attempt(() => { a[Symbol.iterator] = function* () {}; });
  attempt(() => { a[Symbol.for("nodejs.util.inspect.custom")] = () => "x"; });
  attempt(() => { view.toLocaleString = () => ""; });
  attempt(() => { a.label = "kept"; });
  console.log(a.label, String(a));
}
run(Uint8Array, new DataView(new ArrayBuffer(1)));
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
  const refused = (key: string): string =>
    `Error defining ${key} on a typed array, Buffer or DataView is not supported yet`;
  expect(stdout).toBe(
    [
      refused("toString"),
      refused("valueOf"),
      refused("toJSON"),
      refused("join"),
      refused("Symbol(Symbol.iterator)"),
      refused("Symbol(nodejs.util.inspect.custom)"),
      refused("toLocaleString"),
      "defined",
      "kept 0,0",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});
