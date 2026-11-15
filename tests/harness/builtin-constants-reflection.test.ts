import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// node:constants is the checked-dynamic object the runtime builds from the
// platform's C tables, so an inline `require("node:constants")` answers that
// object, exactly as binding it first does. The member census leaves this
// namespace to the runtime, and the `in` over it reads the loaded object
// instead of lowering the require value (which has no representation).
test("an inline require of node:constants answers the module object", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-constants-reflection-"));
  const entry = join(outDir, "main.cjs");
  writeFileSync(
    entry,
    `
const bound = require("node:constants");
console.log("O_RDONLY" in bound, "O_RDONLY" in require("node:constants"));
console.log(Object.keys(require("node:constants")).length === Object.keys(bound).length);
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
  expect(stdout).toBe("true true\ntrue\n");
  expect(stderr).toBe("");
});
