import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { type IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-plus-inspect-"));
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

/** Every object in the tree with the given `kind`, in source order. */
function nodes(kind: string, root: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.kind === kind) found.push(record);
    for (const value of Object.values(record)) visit(value);
  };
  visit(root);
  return found;
}

test("an optional-string `+` reads its left operand before a writing right operand", async () => {
  const module = await lower(`
const words: (string | undefined)[] = ["first"];
let local: string | undefined = words[0];
console.log(local + (local = "second"));
`);
  const init = module.functions.find((fn) => fn.name === "%init.0")!;
  const declarations = nodes("varDecl", init.body).filter((decl) =>
    String(decl.localId).startsWith("%plus"),
  );
  // The left read is snapshotted first; the assignment to the right
  // operand follows it. Node evaluates and reads the left operand first.
  expect(declarations.map((decl) => (decl.init as { kind: string }).kind)).toEqual([
    "varRef",
    "assignExpr",
  ]);
  // The concatenation reads the snapshot, not the global the assignment
  // writes.
  const concatenation = nodes("strConcat", init.body)[0]!;
  const left = (concatenation.left as { operand?: { localId?: string } }).operand;
  expect(left?.localId).toBe(declarations[0]!.localId);
});

test("util.inspect of a function-local class prints its source names", async () => {
  const module = await lower(`
import { inspect } from "node:util";
function make(): string {
  class Base {}
  class Point extends Base {}
  return inspect(Point);
}
console.log(make());
`);
  const llvm = emitLlvmModule(module, { pointerBits: 64 });
  expect(llvm).toContain("[class Point extends Base]");
  expect(llvm).not.toContain("[class %cx");
});
