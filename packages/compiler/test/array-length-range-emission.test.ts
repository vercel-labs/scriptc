import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emit(source: string, outputKind: "llvm" | "asm"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-array-length-range-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, outputKind === "llvm" ? "main.ll" : "main.s");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const source = `
class Signature {
  parameters: string[];
  rest: boolean;
  constructor(parameters: string[], rest: boolean) {
    this.parameters = parameters;
    this.rest = rest;
  }
}
function count(signature: Signature): number {
  const length = signature.parameters.length;
  if (signature.rest) return length + signature.parameters[length - 1]!.length;
  return length;
}
const signature = new Signature(["a", "bb"], process.argv.length > 1);
console.log(count(signature), count(new Signature(["x"], false)));
`;

test.runIf(process.arch === "x64" || process.arch === "arm64")(
  "array length loads carry the range of a JS array length",
  async () => {
    const llvm = await emit(source, "llvm");
    const body = /^define internal double @sc_bf_count\([^]*?^}/m.exec(llvm)?.[0] ?? "";
    // The length is an i32 field: its zero extension carries the range.
    expect(body).toMatch(
      /(%\S+) = load i32, ptr %\S+(, !tbaa !\d+)?\n\s*%\S+ = zext i32 \1 to i64/,
    );
  },
);

test.runIf(process.arch === "x64")(
  "a length used as an index is not converted to double and back",
  async () => {
    const asm = await emit(source, "asm");
    // `parameters[length - 1]` loads from data + length * 8 - 8: the index
    // stays the integer length, folded into the address (whether or not
    // `count` is inlined into its callers).
    expect(asm).toMatch(/movq\t-8\(%r\w+,%r\w+,8\), %r\w+/);
  },
);
