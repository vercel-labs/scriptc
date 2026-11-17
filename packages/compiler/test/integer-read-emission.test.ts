import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("int32 counters and typed-array reads keep integers visible to LLVM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-integer-reads-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
class Text {
  pos: number;
  end: number;
  units: Uint16Array;
  values: Float64Array;
  constructor(n: number) {
    this.units = new Uint16Array(n);
    this.values = new Float64Array(n);
    this.pos = 0;
    this.end = n | 0;
  }
  skip(): number {
    const units = this.units;
    const end = this.end;
    let pos = this.pos;
    while (pos < end) {
      const c = units[pos] | 0;
      if (c === 42 || c > 127) break;
      pos = (pos + 1) | 0;
    }
    this.pos = pos;
    return pos;
  }
  sum(at: number): number {
    return this.values[at] + this.units[at];
  }
}
const text = new Text(8);
console.log(text.skip(), text.sum(3), text.sum(9));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const ll = emitLlvmModule(mod);
    const body = (name: string): string =>
      ll.match(
        new RegExp(
          `define internal [^\\n]+ @sc_bf_${name}(?:\\.i32)?\\([^\\n]*\\) align 64 #0 \\{([\\s\\S]*?)\\n\\}`,
        ),
      )![1]!;
    const skip = body("_x25_Text_skip");
    // The counter's increment is 32-bit arithmetic that cannot overflow and
    // converts from i32, so LLVM folds the double round trip of the local.
    expect(skip).toMatch(/ = add nsw i32 /);
    expect(skip).not.toMatch(/ = sitofp i64 /);
    // The read joins its integer and a validity bit; the number converts after the join.
    expect(skip).toMatch(
      / = phi i32 \[ %\w+, %bytes\.read\.ok\d+ \], \[ 0, %bytes\.read\.invalid\d+ \]/,
    );
    expect(skip).toMatch(
      / = phi i1 \[ true, %bytes\.read\.ok\d+ \], \[ false, %bytes\.read\.invalid\d+ \]/,
    );
    expect(skip).not.toMatch(/ = phi double \[ %\w+, %bytes\.read\.ok/);
    // A floating element has no integer view and keeps the joined number.
    const sum = body("_x25_Text_sum");
    expect(sum).toMatch(/ = phi double \[ %\w+, %bytes\.read\.ok\d+ \], \[ 0x7FF8000000000000/);
    expect(sum).toMatch(/ = phi i1 \[ true, %bytes\.read\.ok/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
