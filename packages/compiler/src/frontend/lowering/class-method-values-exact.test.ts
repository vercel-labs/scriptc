/* A class-returning method value the island method table holds: the
 * exact-return wrapper must keep the receiverless form for a method that
 * never reads `this`, or a detached call inside the island passes no receiver
 * and the method's receiver check refuses it. Lowers to IR only: no libnode
 * is needed. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import type { IrExpr, IrFunction, IrModule } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function lower(files: Record<string, string>): Promise<IrModule> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "scriptc-exact-class-")));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  const outPath = join(dir, "main.ir.json");
  const result = await compile(join(dir, "main.mjs"), { outDir: dir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return deserializeModule(await readFile(outPath, "utf8"));
}

/** The calls one function makes, anywhere in its body. */
function callsIn(fn: IrFunction): { callee: string; args: number }[] {
  const found: { callee: string; args: number }[] = [];
  everyStmtList(fn.body, {
    stmt: () => true,
    expr: (e) => {
      if (e.kind === "call") found.push({ callee: e.callee, args: e.args.length });
      return true;
    },
  });
  return found;
}

/** A field of the island method table for a class (found by suffix). */
function tableField(mod: IrModule, className: string, method: string): IrExpr | null {
  for (const builder of mod.functions) {
    if (!builder.name.startsWith("%island.methods:") || !builder.name.endsWith(`.${className}`))
      continue;
    for (const stmt of builder.body) {
      if (stmt.kind !== "return" || stmt.value?.kind !== "dynObjLit") continue;
      for (const field of stmt.value.fields ?? [])
        if (field.key.kind === "strLit" && field.key.value === method) return field.value;
    }
  }
  return null;
}

/** The function a table entry names, unwrapping the dyn coercion. */
function targetOf(mod: IrModule, value: IrExpr): IrFunction | null {
  const inner = value.kind === "dynFrom" ? value.value : value;
  const name =
    inner.kind === "closure" ? inner.fnName : inner.kind === "varRef" ? inner.localId : null;
  return name === null ? null : (mod.functions.find((f) => f.name === name) ?? null);
}

const MAIN = `import { requireModule } from "@scriptc/node";
import { Factory } from "./classes.mjs";
const plugin = requireModule("./plugin.mjs");
const factory = new Factory();
console.log(plugin.name, plugin.probe(factory));
`;
const CLASSES = `export class Leaf {
  constructor() {
    this.label = "leaf";
  }
}
export class Factory {
  make(n) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += i;
    if (sum < 0) throw new Error("unreachable");
    return new Leaf();
  }
}
`;
// The island names the class, which is what makes the crossing build the
// class's method table for the instance it receives.
const PLUGIN = `import { Factory } from "./classes.mjs";
export const name = "plugin";
export function probe(value) {
  const make = value.make;
  return make().label;
}
`;

test("an island table entry for a this-free class-returning method carries no receiver", async () => {
  const mod = await lower({ "main.mjs": MAIN, "classes.mjs": CLASSES, "plugin.mjs": PLUGIN });
  const field = tableField(mod, "Factory", "make");
  expect(field, "the island table holds make").not.toBeNull();
  const entry = targetOf(mod, field!);
  expect(entry, "the table entry is a lifted function").not.toBeNull();
  // The method takes one parameter (`n`); the entry takes the same and no
  // receiver, so an island that detaches it (`const make = value.make;
  // make(3)`) passes no receiver to check. The reflected/unbound method
  // value wins over the exact-return wrapper for a method that never reads
  // `this`, and its body has no receiver read left either.
  expect(entry!.params).toHaveLength(1);
  expect(callsIn(entry!).filter((call) => call.callee.includes(".make"))).toEqual([]);
});
