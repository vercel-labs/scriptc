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

const source = (indexedRead: string): string => `
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
  if (signature.rest) { ${indexedRead} }
  return length;
}
const signature = new Signature(["a", "bb"], process.argv.length > 1);
console.log(count(signature), count(new Signature(["x"], false)));
`;

test.runIf(process.arch === "x64" || process.arch === "arm64")(
  "array length loads carry the range of a JS array length",
  async () => {
    const llvm = await emit(
      source("return length + signature.parameters[length - 1]!.length;"),
      "llvm",
    );
    const body = /^define internal double @sc_bf_count\([^]*?^}/m.exec(llvm)?.[0] ?? "";
    expect(body).toMatch(/= load i64, ptr %\S+(, !tbaa !\d+)?, !range !\{i64 0, i64 4294967296\}/);
    expect(body).toMatch(/icmp ult i64 %\S+, 4294967295/);
    expect(body).not.toContain("fptoui double");
  },
);

test.runIf(process.arch === "x64")(
  "a length used as an index is not converted back from double",
  async () => {
    // A required local keeps the direct read; equality alone uses an optional
    // helper, while string length introduces an unrelated double conversion.
    const asm = await emit(
      source(
        'const last: string = signature.parameters[length - 1]!; return last === "bb" ? length : 0;',
      ),
      "asm",
    );
    const body = /^sc_bf_count:[^]*?\.cfi_endproc/m.exec(asm)?.[0] ?? "";
    expect(body).not.toBe("");
    // The property Get ABI needs a double key on its slow path; dense guards
    // retain the original integer instead of converting that key back.
    expect(body).not.toMatch(/cvttsd2si/);
  },
);
