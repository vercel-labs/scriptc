import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { keepSetElementsBoxed } from "../src/backend/llvm/test-boxed-unions.js";
import { type IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-json-nullable-releases-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, {
      outDir: dir,
      outPath: output,
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The module's `JSON.stringify` writer for class instances of `className`. */
function classWriter(llvm: string, className: string): string {
  const header = new RegExp(`^define [^\\n]*; stringify object:${className}$`, "m").exec(llvm);
  expect(header, className).not.toBeNull();
  const end = llvm.indexOf("\n}", header!.index);
  expect(end, className).toBeGreaterThan(header!.index);
  return llvm.slice(header!.index, end);
}

function calls(text: string, symbol: string): number {
  return text.match(new RegExp(`@${symbol}\\(`, "g"))?.length ?? 0;
}

// A class field typed `C | undefined` keeps the class pointer itself, but a
// module-wide boxed union of that shape hands the field's writer a temporary
// union box: the writer must release that box once, on the path where the
// field is present as well as where it is undefined. Releasing it a second
// time frees the box the write just read.
const source = `
class Tail {
  label: string;
  child: Tail | undefined;
  constructor(label: string, child: Tail | undefined) { this.label = label; this.child = child; }
}
function render(tail: Tail): string { return JSON.stringify(tail); }
// The Set keeps the element union a tagged box (keepSetElementsBoxed), which
// is what a nullable class field's writer boxes the read into.
const boxed = new Set<Tail | undefined>();
boxed.add(new Tail("a", undefined));
console.log(render(new Tail("b", undefined)), render(new Tail("c", new Tail("d", undefined))));
console.log(boxed.size, boxed.has(undefined));
`;

test("a present optional class reference's JSON field releases its box once", async () => {
  const module = await lower(source);
  const writer = classWriter(emitLlvmModule(module, keepSetElementsBoxed(module)), "Tail");
  expect(calls(writer, "scr_union_new_ref")).toBe(1);
  expect(calls(writer, "scr_union_release")).toBe(1);
});

test("an undefined optional class reference's JSON field releases its box once", async () => {
  const module = await lower(source);
  const writer = classWriter(emitLlvmModule(module, keepSetElementsBoxed(module)), "Tail");
  // Both arms of the presence test reach the single release: the undefined
  // arm branches straight to it, and the present arm joins it after the write.
  const skip = /br i1 %\w+, label %(jcl\.s\d+), label %(jcl\.w\d+)/.exec(writer);
  expect(skip).not.toBeNull();
  const [, skipLabel, writeLabel] = skip!;
  const blocks = writer.split(`\n${skipLabel}:`);
  expect(blocks).toHaveLength(2);
  expect(blocks[1]!.split("\n")[1] ?? "").toContain("@scr_union_release(");
  const write = writer.split(`\n${writeLabel}:`)[1]!.split(`\n${skipLabel}:`)[0]!;
  expect(calls(write, "scr_union_release")).toBe(0);
  expect(write).toContain(`br label %${skipLabel}`);
});
