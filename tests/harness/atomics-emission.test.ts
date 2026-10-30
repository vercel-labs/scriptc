/* Atomics emission (behavior is in the differential corpus, 5740-5746):
 * operations on integer typed arrays compile to sequentially consistent
 * atomic instructions on the element, and only an index that is not an
 * integer in range calls the runtime operation. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

async function emittedLlvm(name: string, source: string): Promise<string> {
  const key = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `atomics-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    backend: "llvm",
    outputKind: "llvm",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFileSync(result.artifact.path, "utf8");
}

function body(llvm: string, name: string): string {
  const start = llvm.search(new RegExp(`^define internal [^\\n]*@${name}[.(]`, "m"));
  expect(start).toBeGreaterThanOrEqual(0);
  return llvm.slice(start, llvm.indexOf("\n}\n", start));
}

test("Atomics operations compile to sequentially consistent instructions", async () => {
  const llvm = await emittedLlvm(
    "ops",
    `function work(a: Int32Array, b: Uint8Array, c: Int16Array, i: number): number {
  let t = Atomics.add(a, i, 1) + Atomics.sub(a, i, 2) + Atomics.and(a, i, 3);
  t += Atomics.or(b, i, 4) + Atomics.xor(b, i, 5) + Atomics.exchange(c, i, 6);
  t += Atomics.compareExchange(a, i, 7, 8) + Atomics.load(b, i) + Atomics.store(c, i, 9);
  return t;
}
const buffer = new SharedArrayBuffer(16);
console.log(work(new Int32Array(buffer), new Uint8Array(buffer), new Int16Array(buffer), 1));
`,
  );
  const work = body(llvm, "sc_bf_work");
  for (const op of ["add", "sub", "and"])
    expect(work).toMatch(new RegExp(`atomicrmw ${op} ptr %t\\d+, i32 [^,]+ seq_cst, align 4`));
  for (const op of ["or", "xor"])
    expect(work).toMatch(new RegExp(`atomicrmw ${op} ptr %t\\d+, i8 [^,]+ seq_cst, align 1`));
  expect(work).toMatch(/atomicrmw xchg ptr %t\d+, i16 [^,]+ seq_cst, align 2/);
  expect(work).toMatch(/cmpxchg ptr %t\d+, i32 [^,]+, i32 [^,]+ seq_cst seq_cst, align 4/);
  expect(work).toMatch(/load atomic i8, ptr %t\d+ seq_cst, align 1/);
  expect(work).toMatch(/store atomic i16 [^,]+, ptr %t\d+ seq_cst, align 2/);
  // Every runtime call is the cold path for an index out of range.
  const calls = work.match(/call double @scr_atomics_op\([^\n]*/g) ?? [];
  expect(calls).toHaveLength(9);
  for (const call of calls) expect(call).toMatch(/\)(?: nounwind)? cold$/);
});

test("an unchanged local array is borrowed across Atomics operations", async () => {
  const llvm = await emittedLlvm(
    "borrow",
    `function count(buffer: SharedArrayBuffer, n: number): number {
  const cells = new Int32Array(buffer);
  for (let i = 0; i < n; i++) {
    Atomics.add(cells, 0, 1);
    Atomics.compareExchange(cells, 1, Atomics.load(cells, 1), i);
  }
  return Atomics.load(cells, 0);
}
function swap(buffer: SharedArrayBuffer, other: SharedArrayBuffer): number {
  let cells = new Int32Array(buffer);
  return Atomics.add(cells, ((cells = new Int32Array(other)), 0), 1);
}
const buffer = new SharedArrayBuffer(16);
console.log(count(buffer, 3), swap(buffer, new SharedArrayBuffer(16)));
`,
  );
  // The local owns the array across each operation: no reference count
  // operations around the atomic instructions.
  const counted = body(llvm, "sc_bf_count");
  expect(counted).toMatch(/atomicrmw add ptr/);
  expect(counted).not.toMatch(/call ptr @scr_bytes_retain_v/);
  // An operand that reassigns the binding releases the old array, so the
  // operation keeps its own reference.
  expect(body(llvm, "sc_bf_swap")).toMatch(/call ptr @scr_bytes_retain_v/);
});
