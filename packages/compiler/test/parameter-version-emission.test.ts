import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-parameter-version-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const versions = (llvm: string): string[] => [
  ...new Set([...llvm.matchAll(/^define [^@]*@sc_\w+?_(\w+?)_int32Params\b/gm)].map((m) => m[1]!)),
];

const loops = `
function sumTo(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += i;
  return s;
}
function literal(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += i;
  return s;
}
function recursive(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += i;
  return n > 0 ? s + recursive(n - 1) : s;
}
function unbounded(n: number): number {
  let s = 0;
  for (let i = 0; i < 10; i++) s += n;
  return s;
}
class Counter {
  total(n: number): number {
    let s = 0;
    for (let i = 0; i < n; i++) s += i;
    return s;
  }
}
const n = Number(process.argv.length > 5 ? "7.5" : "6");
console.log(sumTo(n), literal(4), literal(5), recursive(n), unbounded(n), new Counter().total(n));
`;

test("a loop-bounding parameter some caller passes unproven gets an int32 version", async () => {
  const llvm = await emitLlvm(loops);
  expect(versions(llvm)).toEqual(["sumTo"]);
  // The version takes the parameter as an i32, and the body dispatches to it
  // after testing for an int32 that is not -0.
  expect(llvm).toMatch(/^define [^@]*@sc_\w+_sumTo_int32Params\.i32\(i32 /m);
  const body = /^define [^@]*@sc_\w+?_sumTo\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  expect(body).toMatch(/call [^@]*@sc_\w+_sumTo_int32Params/);
  expect(body).toMatch(/fdiv double 0x3FF0000000000000, %\S+/);
});

test("a module that reads stacks keeps a single body", async () => {
  const llvm = await emitLlvm(`${loops}\nconsole.log(typeof new Error("x").stack);\n`);
  expect(versions(llvm)).toEqual([]);
});
