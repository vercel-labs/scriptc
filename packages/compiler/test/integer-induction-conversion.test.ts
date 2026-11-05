import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("array index counters convert to and from numbers with signed conversions on 64-bit targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-integer-induction-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    const source = `
function weigh(values: number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) total += (i / 2) * values[j]! + j;
  }
  return total;
}
console.log(weigh([1, 2, 3, 4]));
`;
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const body = (ll: string): string =>
      ll.match(
        /define internal [^\n]+ @sc_(?:b)?f_weigh(?:\.i32)?\([^\n]*\) #0 \{([\s\S]*?)\n\}/,
      )![1]!;

    const wide = body(emitLlvmModule(mod));
    expect(wide).toContain("integer induction");
    // Both counters are read as numbers (i / 2, + j): safe integers, so the
    // signed conversion is exact; the nested start converts back the same way.
    expect(wide).toMatch(/ = sitofp i64 %\w+ to double/);
    expect(wide).not.toMatch(/ = uitofp i64 /);
    expect(wide).toMatch(/ = fptosi double %\w+ to i64/);
    expect(wide).not.toMatch(/ = fptoui double %\w+ to i64/);

    // 32-bit counters reach 2^32 - 2, beyond the signed i32 range.
    const narrow = body(emitLlvmModule(mod, { pointerBits: 32, wasi: true }));
    expect(narrow).toMatch(/ = uitofp i32 %\w+ to double/);
    expect(narrow).toMatch(/ = fptoui double %\w+ to i32/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an integer sum with a uint32 operand converts from 32 bits; counter sums keep 64 bits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-integer-uint32-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    const source = `
function au(u: Float64Array, v: Float64Array): void {
  for (let i = 0; i < v.length; i++) {
    let t = 0;
    for (let j = 0; j < u.length; j++) t += u[j]! / ((((i + j) * (i + j + 1)) >>> 1) + i + 1);
    v[i] = t;
  }
}
function next(values: number[]): number {
  let total = 0;
  for (let i = 0; i + 1 < values.length; i++) total += values[i + 1]! - (i + 1);
  return total;
}
const u = new Float64Array(8).fill(1);
const v = new Float64Array(8);
au(u, v);
console.log(v[3], next([1, 2, 3, 4]));
`;
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const ll = emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
    const body = (name: string): string =>
      ll.match(
        new RegExp(
          `define internal [^\\n]+ @sc_(?:b)?f_${name}(?:\\.i32)?\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`,
        ),
      )![1]!;
    // The divisor is at most 2^31 - 1 + 2^25 + 1: above int32, within uint32,
    // and built on the uint32 \`>>>\` result. It is a 32-bit sum, and its double
    // converts from the 32 bits.
    const au = body("au");
    const divisor = /(%\w+) = fdiv double %\w+, (%\w+)/.exec(au)?.[2];
    expect(divisor).toBeDefined();
    expect(au).toMatch(new RegExp(`${divisor} = uitofp i32 %\\w+ to double`));
    expect(au).toMatch(/ = add nuw i32 /);
    // \`i + 1\` sums a counter and a literal: it keeps the 64-bit sum and its
    // signed conversion.
    const next = body("next");
    expect(next).not.toMatch(/ = add nuw i32 /);
    const sum = /(%\w+) = add nsw i64 %\w+, 1\n/.exec(next)?.[1];
    expect(sum).toBeDefined();
    expect(next).toMatch(new RegExp(` = sitofp i64 ${sum} to double`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
