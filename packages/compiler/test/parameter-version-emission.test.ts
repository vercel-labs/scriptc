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

test("the body a version leaves emits each loop once", async () => {
  const llvm = await emitLlvm(`
const fact: number[] = [];
function fillFact(n: number): void {
  fact[0] = 1;
  for (let i = 1; i <= n; i++) fact[i] = fact[i - 1]! * i;
}
fillFact(Number(process.argv.length > 5 ? "7.5" : "6"));
console.log(fact.join(" "));
`);
  expect(versions(llvm)).toEqual(["fillFact"]);
  const loopBodies = (name: string): number => {
    const body = new RegExp(`^define [^@]*@sc_\\w+?_${name}\\([^]*?^}`, "m").exec(llvm)?.[0] ?? "";
    return body.match(/^loop\.b\d+:/gm)?.length ?? 0;
  };
  // The fallback runs only for numbers the version does not take: its loop
  // gets no speculative integer copy beside the ordinary one.
  expect(loopBodies("fillFact")).toBe(0);
  expect(loopBodies("fillFact_int32Fallback")).toBe(1);
  expect(loopBodies("fillFact_int32Params\\.i32")).toBe(1);
});

test("a module that reads stacks keeps a single body", async () => {
  const llvm = await emitLlvm(`${loops}\nconsole.log(typeof new Error("x").stack);\n`);
  expect(versions(llvm)).toEqual([]);
});

test("the original body runs as an out-of-line fallback the helper places by name", async () => {
  const llvm = await emitLlvm(loops);
  // Only a bound that is not an int32 reaches it: it is cold, never
  // inlined, and marked for the helper's partitioner.
  expect(llvm).toMatch(
    /^define [^@]*@sc_\w+?_sumTo_int32Fallback\([^)]*\) noinline cold "scriptc-fallback" /m,
  );
  // The function itself keeps only the int32 test and the two calls.
  const body = /^define [^@]*@sc_\w+?_sumTo\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  expect(body).toMatch(/call [^@]*@sc_\w+_sumTo_int32Params/);
  expect(body).toMatch(/call [^@]*@sc_\w+_sumTo_int32Fallback/);
  expect(body).not.toMatch(/^loop\./m);
});

test("a versioned function stays out of line so its copy compiles in its frame", async () => {
  const llvm = await emitLlvm(loops);
  // Inlined into a caller the function takes its copy along, and the loops
  // then compile in that caller's frame instead of this one.
  expect(llvm).toMatch(/^define [^@]*@sc_\w+?_sumTo\([^)]*\) noinline /m);
});
