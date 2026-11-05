import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

/** Lower one program to IR; a fence answers its diagnostic codes instead. */
async function lower(
  source: string,
): Promise<{ ok: true; module: IrModule } | { ok: false; codes: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-map-closure-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) return { ok: false, codes: result.diagnostics.map((d) => d.code) };
    return { ok: true, module: deserializeModule(await readFile(outPath, "utf8")) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a map callback answering a closure produces an array of functions", async () => {
  const result = await lower(`
interface Entry { source: string; scope: "user" | "project" }
function tasksFor(entries: Entry[]): Array<() => Promise<string>> {
  return entries.map((entry) => async () => \`\${entry.scope}:\${entry.source}\`);
}
function readers(entries: Entry[]): (() => string)[] {
  return entries.map((entry) => () => entry.source);
}
console.log(tasksFor([]).length, readers([]).length);
export {};
`);
  if (!result.ok) throw new Error(`fenced: ${result.codes.join(", ")}`);
  expect(validateModule(result.module)).toEqual([]);
  // The element kind is the closure type itself: a function value is one
  // ScrClosure stored by reference, like a closure array literal.
  for (const name of ["tasksFor", "readers"]) {
    const fn = result.module.functions.find((candidate) => candidate.name === name);
    expect(fn, name).toBeDefined();
    expect(fn!.returnType.kind, name).toBe("array");
    if (fn!.returnType.kind === "array") expect(fn!.returnType.elem.kind, name).toBe("func");
  }
});

test("an inline map result of closures stays inline", async () => {
  const result = await lower(`
interface Entry { source: string }
const entries: Entry[] = [{ source: "a" }];
const first = entries.map((entry) => (() => entry.source.length));
console.log(first[0]!());
export {};
`);
  if (!result.ok) throw new Error(`fenced: ${result.codes.join(", ")}`);
  expect(validateModule(result.module)).toEqual([]);
});

test("a void-returning map callback stores undefined elements", async () => {
  const result = await lower(`
const items = [1, 2];
const out = items.map((n) => {
  console.log(n);
});
console.log(out.length);
export {};
`);
  // A discarding mapper's answer is undefined, which the result array
  // stores as its element (as Node's map does).
  if (!result.ok) throw new Error(`fenced: ${result.codes.join(", ")}`);
  expect(validateModule(result.module)).toEqual([]);
});
