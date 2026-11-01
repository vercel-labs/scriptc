import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

/** Compiles `source` as a TypeScript entry and returns its LLVM text. */
async function llvmFor(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-typed-arg-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The LLVM bodies of the functions whose symbol contains `fragment`. */
function bodiesContaining(llvm: string, fragment: string): string[] {
  const out: string[] = [];
  for (const match of llvm.matchAll(
    /define internal [^\n]+ @(\S+)\([^\n]*\) #\d+ \{([\s\S]*?)\n\}/g,
  ))
    if (match[1]!.includes(fragment)) out.push(match[2]!);
  return out;
}

const BUMP = (call: string) => `
type Stats = { hits: number; misses: number; name: string };
function bump(target: unknown, key: string, by: number): void {
  const record = target as Record<string, number>;
  record[key] = record[key]! + by;
}
const stats: Stats = { hits: 0, misses: 0, name: "s" };
const other: unknown = JSON.parse("{}");
function main(): void {
  ${call}
  console.log(stats.hits, stats.name);
}
main();
`;

test("a call that passes a typed record runs a clone with typed field access", async () => {
  const llvm = await llvmFor(BUMP(`bump(stats, "hits", 1);`));
  // Parameter versioning adds an integer copy of the clone, so every body
  // whose symbol names it is joined.
  const clones = bodiesContaining(llvm, "bump_typedArg");
  expect(clones.length).toBeGreaterThan(0);
  expect(clones.join("\n")).toMatch(/getelementptr inbounds %sc_rs_\S+, ptr \S+, i64 0, i32 \d+/);
  // The original keeps the dynamic operations for every call that does not
  // pass the record.
  expect(
    bodiesContaining(llvm, "bump").some((body) => body.includes("@scr_dyn_new_typed_ref_observed")),
  ).toBe(true);
});

test("a parameter that escapes is not cloned", async () => {
  const llvm = await llvmFor(`
type Stats = { hits: number };
const kept: unknown[] = [];
function bump(target: unknown, key: string, by: number): void {
  kept.push(target);
  const record = target as Record<string, number>;
  record[key] = record[key]! + by;
}
const stats: Stats = { hits: 0 };
function main(): void {
  bump(stats, "hits", 1);
  console.log(stats.hits, kept.length);
}
main();
`);
  expect(bodiesContaining(llvm, "typedArg")).toHaveLength(0);
});

test("a call with a dynamic argument is not cloned", async () => {
  const llvm = await llvmFor(BUMP(`bump(other, "hits", 1);`));
  expect(bodiesContaining(llvm, "typedArg")).toHaveLength(0);
});
