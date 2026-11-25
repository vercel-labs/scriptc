import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// fill, copyWithin and reverse return their receiver, and concat's result
// starts with it: for a primitive receiver that is its wrapper object, which
// a compiled program has no value for, so these calls refuse with a catchable
// error. A write the String wrapper refuses still throws its TypeError first.
test("Array.prototype methods whose result is a primitive's wrapper refuse", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-array-like-refusals-"));
  const entry = join(outDir, "main.js");
  writeFileSync(
    entry,
    `
function attempt(run) {
  try { run(); console.log("returned"); } catch (error) { console.log(error.name, error.message); }
}
attempt(() => Array.prototype.reverse.call("a"));
attempt(() => Array.prototype.fill.call(5, 0));
attempt(() => Array.prototype.fill.call("ab", "x", 2));
attempt(() => Array.prototype.copyWithin.call(true, 0, 0));
attempt(() => Array.prototype.concat.call("ab", [1]));
attempt(() => Array.prototype.reverse.call("ab"));
attempt(() => Array.prototype.join.call("ab", "-"));
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
  const refused = (method: string): string =>
    `Error Array.prototype.${method} on a primitive receiver is not supported yet`;
  expect(stdout).toBe(
    [
      refused("reverse"),
      refused("fill"),
      refused("fill"),
      refused("copyWithin"),
      refused("concat"),
      "TypeError Cannot assign to read only property '0' of object '[object String]'",
      "returned",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});
