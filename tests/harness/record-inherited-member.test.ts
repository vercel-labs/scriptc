/* Object.prototype's methods on typed records (frontend/lowering/
 * record-inherited.ts): a dot read of a prototype-named member answers the
 * built-in when the record has no own entry, and throws the checked
 * conversion's TypeError when its own entry is a function of another
 * signature than the member's, which the program's types claimed. Node reads
 * the own function there, so the program cannot be a corpus case. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { OTHER_ARM_FAILURE_MESSAGE } from "../../packages/compiler/src/frontend/lowering/coercions/unions.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/fixtures/record-inherited/member-signature.ts");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/record-inherited-member");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test(
  "a prototype-named member read with an own function of another signature throws",
  { timeout: 300_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(entry, { outPath: join(outDir, "main"), outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    expect(stdout).toBe(`function\ntrue ${OTHER_ARM_FAILURE_MESSAGE}\n`);
  },
);
