import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-logical-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

// The trap for a value its destination union cannot hold, naming the value.
const stranded = (type: string): string =>
  `a '${type}' value is not representable in the target union`;

const TYPES = `
type Pair = { a: string | null; b: string | null };
type Other = { name: string };
`;

test("a literal right operand built at its contextual type is the pair's answer", async () => {
  const llvm = await emit(`${TYPES}
function and(c: Other | null): Pair | null {
  return c && { a: null, b: null };
}
function andArray(c: Other | null): (string | null)[] | null {
  return c && [null, null];
}
function andFlag(flag: boolean): Pair | false {
  return flag && { a: null, b: null };
}
function or(c: Other | null): Other | Pair {
  return c || { a: null, b: null };
}
function nullish(c: Other | null): Other | Pair {
  return c ?? { a: null, b: null };
}
const c: Other | null = process.argv.length > 9 ? null : { name: "n" };
console.log(and(c), andArray(c), andFlag(c !== null), or(c), nullish(c));
`);
  // The left operand's object arm keeps its trap on the path it cannot take.
  expect(llvm).toContain(stranded("{ name: string }"));
  expect(llvm).not.toContain(stranded("{ a: null | string; b: null | string }"));
  expect(llvm).not.toContain(stranded("(null | string)[]"));
});
