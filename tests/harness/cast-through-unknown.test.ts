/* Assertions through `unknown` (`value as unknown as T`) are checked when
 * they run, and their failures are attributable: the TypeError names the
 * cast, where it is, and the expression it applies to. A cast whose target
 * layout the source's static type cannot have is also named at build time
 * (SC6016), because Node erases the assertion and the program can only fail
 * later.
 *
 * These cannot be corpus programs: Node passes the value through, while the
 * compiled program throws the checked cast's TypeError. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const outDir = join(
  import.meta.dirname,
  "../../node_modules/.cache/scriptc-tests/cast-through-unknown",
);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface ProgramResult {
  readonly stdout: string;
  readonly warnings: readonly { code: string; loc: { start: number }; message: string }[];
}

async function runProgram(name: string, source: string): Promise<ProgramResult> {
  mkdirSync(outDir, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), `scriptc-cast-unknown-${name}-`));
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, source);
  try {
    const outPath = join(outDir, name);
    const result = await compile(file, { outPath, outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const warnings = "warnings" in result ? (result.warnings ?? []) : [];
    const run = await execFileAsync(outPath, [], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    return { stdout: run.stdout, warnings };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a failing assertion through unknown names the cast and its source", async () => {
  const { stdout, warnings } = await runProgram(
    "named-cast",
    `interface Row { a: number }
function helper(value: unknown): Row[] { return value as unknown as Row[]; }
const wrong: unknown = { not: "an array" };
try { helper(wrong); console.log("no throw"); }
catch (error) {
  console.log(error instanceof TypeError);
  console.log((error as Error).message);
}
`,
  );
  const lines = stdout.split("\n");
  expect(lines[0]).toBe("true");
  expect(lines[1]).toBe("expected array at $, got object");
  expect(lines[2]).toMatch(
    /^ {4}the cast 'value as unknown as Row\[\]' \(named-cast\.ts:2:\d+\) applies to 'value'$/,
  );
  // The source is a dynamic value: no build-time warning can know better.
  expect(warnings.filter((w) => w.code === "SC6016")).toEqual([]);
});

test("a cast whose source cannot have the target layout is named at build time", async () => {
  const source = `interface Row { a: number }
const arr: number[] = [1, 2];
try { const row = arr as unknown as Row; console.log(row.a); }
catch (error) {
  console.log(error instanceof TypeError);
  console.log((error as Error).message);
}
`;
  const { stdout, warnings } = await runProgram("warned-cast", source);
  expect(stdout).toBe("true\nexpected object at $, got array\n");
  const castWarnings = warnings.filter((w) => w.code === "SC6016");
  expect(castWarnings.map((w) => w.loc.start)).toEqual([source.indexOf("arr as unknown as Row")]);
  expect(castWarnings[0]?.message).toContain("of type 'number[]'");
});
