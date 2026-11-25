import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/** The serialized IR of a program that must compile. */
async function irOf(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-find-written-predicate-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, `export {};\n${source}`);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The TypeError a checked conversion throws for an element the predicate
 * accepted that is not of the predicate's type. */
const LIED = "a type predicate returned true for a value of another type";

// A written predicate is an assertion TypeScript does not check. The search
// runs it as a test and converts the element it answers checked, so a
// predicate that lies is a TypeError at run time, not a wrong union arm.
test.each([
  [
    "an inline predicate of find",
    `const rows: (number | string)[] = ["wrong"];
     console.log(rows.find((value): value is number => true));`,
  ],
  [
    "an inline predicate of findLast",
    `const rows: (number | string)[] = ["wrong"];
     console.log(rows.findLast((value): value is number => true));`,
  ],
  [
    "a guard function passed by name",
    `function isNumber(value: number | string): value is number { return true; }
     console.log((["wrong", 1] as (number | string)[]).find(isNumber));`,
  ],
])("%s compiles to a checked conversion", async (_name, source) => {
  expect(await irOf(source)).toContain(LIED);
});

test("a callback without a predicate has nothing to check", async () => {
  const ir = await irOf(
    `const rows: (number | string)[] = ["kept"];
     console.log(rows.find((value) => value === "kept"));`,
  );
  expect(ir).not.toContain(LIED);
});
