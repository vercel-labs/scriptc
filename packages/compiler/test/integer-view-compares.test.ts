import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

const source = `function siftDown(a: Int32Array, start: number, end: number): void {
  let root = start;
  while (2 * root + 1 < end) {
    let child = 2 * root + 1;
    if (child + 1 < end && a[child]! < a[child + 1]!) child++;
    if (a[root]! >= a[child]!) return;
    const t = a[root]!;
    a[root] = a[child]!;
    a[child] = t;
    root = child;
  }
}
const a = new Int32Array([3, 9, 1, 7, 5]);
siftDown(a, 0, Number(process.argv[2] ?? "5"));
console.log(Array.from(a).join());
`;

test("integer values compare and index as integers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-integer-views-"));
  try {
    const entry = join(dir, "sift.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "sift.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const ll = emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
    const body = ll.match(
      /define internal [^\n]+ @sc_bf_siftDown(?:\.i32)?\([^\n]*\) #0 \{([\s\S]*?)\n\}/,
    )![1]!;
    // `child + 1`: the integer the speculated copy already adds.
    const sums = [...body.matchAll(/(%t\d+) = add nsw i64 %t\d+, 1\n/g)].map((m) => m[1]!);
    expect(sums.length).toBeGreaterThan(0);
    const uses = (op: string) =>
      sums.filter((sum) => new RegExp(`= ${op} i64 \\${sum}, %t\\d+\\n`).test(body));
    // `child + 1 < end` compares the integers,
    expect(uses("icmp slt").length).toBeGreaterThan(0);
    // and `a[child + 1]` bounds the integer index without a double round trip.
    expect(uses("icmp ult").length).toBeGreaterThan(0);
    // `2 * root + 1` may pass 2^53, but its double is its integer rounded
    // once (doubling is exact) and `end` is a safe integer, so the integers
    // compare as the doubles do.
    const doubled = /(%t\d+) = mul nsw i64 2, %t\d+\n/.exec(body)![1]!;
    const plusOne = new RegExp(`(%t\\d+) = add nsw i64 \\${doubled}, 1\\n`).exec(body)![1]!;
    expect(body).toMatch(new RegExp(`= icmp slt i64 \\${plusOne}, %t\\d+\\n`));
    // `a[child]! < a[child + 1]!` compares the elements' int32 bits, and is
    // false when either read is out of range (NaN).
    const ordered = String.raw`\s+%t\d+ = fcmp ord double %t\d+, 0\.0\n\s+%t\d+ = and i1 %t\d+, %t\d+\n`;
    expect(body).toMatch(new RegExp(String.raw`icmp slt i32 %t\d+, %t\d+\n(${ordered}){2}`));
    expect(body).toMatch(new RegExp(String.raw`icmp sge i32 %t\d+, %t\d+\n(${ordered}){2}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
