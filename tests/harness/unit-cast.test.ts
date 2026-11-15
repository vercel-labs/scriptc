/* A value of unknown type asserted to `undefined`, to `void`, or to a type
 * argument instantiated with one of them is a checked cast: it passes for
 * undefined and throws the conversion's TypeError for every other value,
 * null included. Node erases the assertion and goes on, so this is a
 * native-only test; the values that pass are differential
 * (tests/corpus/9521-unit-cast-undefined.ts). */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/fixtures/unit-cast/lying.ts");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/unit-cast");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test(
  "a cast of an unknown value to undefined or void throws when the value is not undefined",
  { timeout: 600_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(entry, { outPath: join(outDir, "lying"), outDir, sanitize });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const pending = execFileAsync(result.binaryPath, [], { cwd: dirname(entry), encoding: "utf8" });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    expect(stdout).toBe(
      "number as undefined TypeError expected null | undefined at $, got number\n" +
        "record as void TypeError expected null | undefined at $, got object\n" +
        "null as undefined TypeError expected undefined at $, got null\n" +
        "string as undefined TypeError expected null | undefined at $, got string\n" +
        "generic void TypeError expected null | undefined at $, got object\n" +
        "generic undefined TypeError expected null | undefined at $, got array\n" +
        "promised void TypeError expected null | undefined at $, got object\n",
    );
  },
);
