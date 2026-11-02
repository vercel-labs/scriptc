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

test("a write to a frozen record in a clone throws, as the dynamic write does", async () => {
  const llvm = await llvmFor(`
type Stats = { hits: number; misses: number };
function setHits(target: unknown): number {
  const record = target as Record<string, number>;
  record.hits = 4;
  return 1;
}
const stats: Stats = { hits: 0, misses: 0 };
const frozen: Stats = { hits: 0, misses: 0 };
Object.freeze(frozen);
function main(): void {
  console.log(setHits(stats), setHits(frozen), stats.hits, frozen.hits);
}
main();
`);
  const clones = bodiesContaining(llvm, "typedArg").join("\n");
  // The frozen bit gates the store, and the write it refuses throws.
  expect(clones).toMatch(/lshr i64 \S+, 62/);
  expect(clones).toMatch(/call void @scr_record_throw_frozen/);
  expect(clones).toMatch(/getelementptr inbounds %sc_rs_\S+, ptr \S+, i64 0, i32 \d+/);
});

test("a shape a partial record assertion names is not cloned", async () => {
  const helper = `
function peek(target: unknown, key: string): any {
  const record = target as Record<string, number>;
  return record[key];
}
const full: Stats = { hits: 2, misses: 3 };
`;
  const withoutPartial = await llvmFor(`
type Stats = { hits: number; misses: number };
${helper}function main(): void {
  console.log(peek(full, "hits"));
}
main();
`);
  expect(bodiesContaining(withoutPartial, "typedArg").length).toBeGreaterThan(0);
  // `partial` may be missing the field the helper reads: the dynamic read
  // answers undefined, where a clone's typed read would abort on the absent
  // field of the partial view.
  const withPartial = await llvmFor(`
type Stats = { hits: number; misses: number };
${helper}const partial = { hits: 1 } as Stats;
function main(): void {
  console.log(peek(full, "hits"), peek(partial, "misses"));
}
main();
`);
  expect(bodiesContaining(withPartial, "typedArg")).toHaveLength(0);
});

test("a receiver reassigned inside an expression is not cloned", async () => {
  const llvm = await llvmFor(`
type Stats = { hits: number; misses: number };
const other: any = { hits: 9, misses: 0 };
function bump(target: unknown): number {
  const record = target as Record<string, number>;
  record.hits = 5;
  const keep = Math.max((target = other, 0), 1);
  record.misses = keep;
  return keep;
}
const stats: Stats = { hits: 1, misses: 2 };
function main(): void {
  console.log(bump(stats), stats.hits, stats.misses);
}
main();
`);
  expect(bodiesContaining(llvm, "typedArg")).toHaveLength(0);
});
