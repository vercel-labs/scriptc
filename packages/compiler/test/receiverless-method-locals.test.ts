// A method that never reads `this` gets a receiverless copy for its
// detached value. The copy owns its parameter and local records: the jsval
// promotion retypes a function's locals in place, so a copy that shared
// them with the method kept the method's promoted types over its own
// unpromoted body. The differential case is
// tests/corpus/8818-receiverless-method-dynamic-operands.ts.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

type IrLocal = { id: string; type: { kind: string } };
type IrFunction = { name: string; params: { localId: string }[]; locals: IrLocal[] };

async function compileToIr(source: string[]): Promise<IrFunction[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-receiverless-locals-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source.join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const module = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return (module as unknown as { functions: IrFunction[] }).functions;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a receiverless method copy is promoted like its method", async () => {
  const functions = await compileToIr([
    "class Money {",
    "  cents = 1250;",
    "  toString(): string {",
    '    return "$" + this.cents;',
    "  }",
    "}",
    "const paint: any = {",
    "  fg(kind: string, text: string): string {",
    "    return kind + text;",
    "  },",
    "};",
    "class Picker {",
    "  hint(): string {",
    '    return "tab" + paint.fg("muted", " (all)");',
    "  }",
    "}",
    "const picker = new Picker();",
    "const loose: any = picker;",
    "const detached = picker.hint;",
    "const boxed: any = new Money();",
    'console.log(picker.hint(), loose.hint(), detached(), "total " + boxed);',
  ]);
  const method = functions.find((fn) => fn.name === "%Picker.hint");
  const copy = functions.find((fn) => fn.name === "%method.receiverless:%Picker.hint");
  expect(method).toBeDefined();
  expect(copy).toBeDefined();
  const receiver = method!.params[0]!.localId;
  const typed = (fn: IrFunction): string[] =>
    fn.locals.filter((local) => local.id !== receiver).map((l) => `${l.id}: ${l.type.kind}`);
  expect(typed(copy!)).toEqual(typed(method!));
  // The operands of the `+` are hoisted for ToPrimitive, and promoted.
  expect(typed(copy!).some((local) => local.endsWith(": jsval"))).toBe(true);
});
