import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

async function emit(source: string): Promise<(name: string) => string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-typed-read-boxing-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const ll = emitLlvmModule(mod);
    return (name) =>
      ll.match(
        new RegExp(
          `define internal [^\\n]+ @sc_bf_${name}(?:\\.i32)?\\([^\\n]*\\) align 64 #0 \\{([\\s\\S]*?)\\n\\}`,
        ),
      )![1]!;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const UNION = /scr_union_(new|get|release)|_bytes_idxOr_/;

test("typed-array reads compared with numbers or bound in bounds are never boxed", async () => {
  const body = await emit(`
function countByte(a: Uint8Array, b: number): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b) c++;
  return c;
}
function countOther(a: Float32Array, b: number): number {
  let c = 0;
  for (let i = 0; i <= a.length; i++) if (b !== a[i]) c++;
  return c;
}
function lower(src: Uint8Array, dst: Uint8Array): void {
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const c = src[i];
    dst[i] = c >= 65 && c <= 90 ? c | 32 : c;
  }
}
function kinds(a: Float64Array): string {
  let s = "";
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    s += typeof v;
  }
  return s;
}
function copyPast(src: Int16Array, dst: Int16Array): void {
  for (let i = 0; i < dst.length; i++) {
    const c = src[i];
    dst[i] = c;
  }
}
const a = new Uint8Array([10, 97, 10]);
const d = new Uint8Array(3);
lower(a, d);
const w = new Int16Array(4);
copyPast(new Int16Array([1, 2]), w);
console.log(countByte(a, 10), countOther(new Float32Array([1, NaN]), 1), d[0], kinds(new Float64Array(2)), w[3]);
`);
  for (const name of ["countByte", "countOther", "lower", "kinds", "copyPast"])
    expect(body(name), name).not.toMatch(UNION);
  // The comparison is the plain element compare.
  expect(body("countByte")).toMatch(/fcmp oeq double|icmp eq i32/);
});

test("reads that may be undefined on both sides keep undefined === undefined", async () => {
  const body = await emit(`
function bothReads(a: Uint8Array, i: number, b: Uint8Array, j: number): boolean {
  return a[i] === b[j];
}
function optional(a: Uint8Array, i: number, b: number | undefined): boolean {
  return a[i] === b;
}
function outside(a: Uint8Array): string {
  let s = "";
  for (let i = 0; i <= a.length; i++) {
    const v = a[i];
    s += typeof v;
  }
  return s;
}
const a = new Uint8Array(2);
console.log(bothReads(a, 5, a, 6), optional(a, 9, undefined), outside(a));
`);
  // Two NaN-coded reads compare equal when both stand for undefined.
  expect(body("bothReads")).toMatch(/fcmp uno double/);
  // A possibly-undefined operand and an observed out-of-bounds binding
  // keep `number | undefined`.
  for (const name of ["optional", "outside"]) expect(body(name), name).toMatch(UNION);
});
