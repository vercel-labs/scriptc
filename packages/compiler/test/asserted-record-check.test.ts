/* A record type assertion the copy rules cannot honour is a CHECKED
 * conversion, not an erasure: every claimed field is validated member by
 * member and a value outside the claimed shape throws the catchable
 * TypeError the lying-assertion stance promises (divergence 38). Node erases
 * the assertion, so a lying program intentionally diverges and is not a
 * corpus case; the conforming shape is pinned by tests/corpus/
 * 8622-record-index-assertion.ts. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<ReturnType<typeof spawnSync>> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-asserted-checks-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const built = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!built.ok) throw new Error(built.diagnostics.map((d) => d.message).join("\n"));
    return spawnSync(built.binaryPath, [], { timeout: 30_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// An index-signature record asserted to a closed record: the claimed fields
// are validated, the value's own keys survive, and an absent claimed field
// throws a TypeError the program can catch.
test.skipIf(process.platform === "win32")(
  "an index-signature record asserted to a closed record converts checked",
  async () => {
    const result = await run(`
type Colors = { accent: number | string; border: number | string };
function held(source: Record<string, number | string>): Colors {
  return source as Colors;
}
function missing(source: Record<string, number | string>): Colors {
  return source as Colors;
}
console.log(JSON.stringify(held({ accent: "red", border: 3 })));
try {
  missing({ border: 3 });
  console.log("unreachable");
} catch (err) {
  console.log("threw", (err as Error).name);
}
console.log("survived");
`);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe(
      '{"accent":"red","border":3}\nthrew TypeError\nsurvived\n',
    );
  },
);
