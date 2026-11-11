import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import type { IrExpr, IrFunction, IrModule } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-class-callbacks-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function expressions(fn: IrFunction): IrExpr[] {
  const found: IrExpr[] = [];
  everyStmtList(fn.body, {
    stmt: () => true,
    expr: (e) => {
      found.push(e);
      return true;
    },
  });
  return found;
}

/** The `%class.methodsIntact:<root>` tests the program's own functions make,
 * by root class, and the body each test has. */
function intactTests(mod: IrModule): Record<string, { calls: number; body: string }> {
  const tests: Record<string, { calls: number; body: string }> = {};
  for (const fn of mod.functions) {
    if (!fn.name.startsWith("%class.methodsIntact:")) continue;
    const answer = fn.body[0];
    const value = answer?.kind === "return" ? answer.value : null;
    tests[fn.name.slice(fn.name.indexOf(":") + 1)] = {
      calls: 0,
      body:
        value?.kind === "boolLit"
          ? String(value.value)
          : value?.kind === "unary" && value.operand.kind === "varRef"
            ? `!${value.operand.localId}`
            : "?",
    };
  }
  for (const fn of mod.functions)
    for (const e of expressions(fn))
      if (e.kind === "call" && e.callee.startsWith("%class.methodsIntact:"))
        tests[e.callee.slice(e.callee.indexOf(":") + 1)]!.calls++;
  return tests;
}

const untypedWrite = `
function put(target: any, key: string, value: unknown): void {
  target[key] = value;
}
put({}, "a", 1);
`;

test("a program no write can replace a method in makes no test", async () => {
  const mod = await lower(`
class Meter {
  private total = 0;
  add(n: number): number { this.total += n; return this.total; }
}
console.log(new Meter().add(1));
`);
  expect(intactTests(mod)).toEqual({});
});

test("a guarded call tests the instance's table and the family's prototype flag first", async () => {
  const mod = await lower(`
class Meter {
  private total = 0;
  add(n: number): number { this.total += n; return this.total; }
}
${untypedWrite}
const meter = new Meter();
console.log(meter.add(1));
`);
  expect(intactTests(mod)).toEqual({
    Meter: { calls: 1, body: "!%g.%prototype.created.Meter" },
  });
  // The prototype data helper sets the flag whenever it answers.
  const helper = mod.functions.find((fn) => fn.name === "%prototype.data.Meter")!;
  const set = helper.body.at(-2);
  expect(set?.kind === "assign" && set.localId).toBe("%g.%prototype.created.Meter");
  expect(helper.body.at(-1)?.kind).toBe("return");
  // The call is direct when the test holds, without comparing the slot, and
  // the property table is read through its helper only when it does not.
  const init = mod.functions.find((fn) =>
    expressions(fn).some((e) => e.kind === "call" && e.callee === "%class.methodsIntact:Meter"),
  )!;
  const unreplaced = (e: IrExpr): boolean =>
    e.kind === "varRef" && e.localId.startsWith("%callbackUnreplaced");
  const guards = expressions(init).filter(
    (e) =>
      e.kind === "ternary" &&
      e.cond.kind === "logical" &&
      e.cond.op === "||" &&
      unreplaced(e.cond.left) &&
      e.cond.right.kind === "libCall" &&
      e.cond.right.fn === "dyn.sameValue" &&
      e.then.kind === "call" &&
      e.then.callee === "%Meter.add",
  );
  expect(guards.length).toBe(1);
  const reads = expressions(init).filter(
    (e) =>
      e.kind === "ternary" &&
      unreplaced(e.cond) &&
      e.then.kind === "fieldGet" &&
      e.else_.kind === "call" &&
      e.else_.callee.startsWith("%class.readProperties:"),
  );
  expect(reads.length).toBe(1);
});

test("one family shares one test, rooted at its topmost class", async () => {
  const mod = await lower(`
class Shape {
  area(): number { return 1; }
}
class Box extends Shape {
  override area(): number { return 2; }
  edges(): number { return 12; }
}
class Other {
  area(): number { return 3; }
}
${untypedWrite}
const shapes: Shape[] = [new Shape(), new Box()];
const box = new Box();
console.log(shapes[0]!.area(), box.edges(), new Other().area());
`);
  const tests = intactTests(mod);
  expect(Object.keys(tests).sort()).toEqual(["Other", "Shape"]);
  expect(tests["Shape"]).toEqual({ calls: 2, body: "!%g.%prototype.created.Shape" });
  // Each class of the family with a prototype object sets the family's flag.
  for (const name of ["Shape", "Box"]) {
    const helper = mod.functions.find((fn) => fn.name === `%prototype.data.${name}`);
    if (!helper) continue;
    const set = helper.body.at(-2);
    expect(set?.kind === "assign" && set.localId).toBe("%g.%prototype.created.Shape");
  }
});

test("a family with a function-local class keeps reading the property table", async () => {
  const mod = await lower(`
class Shape {
  area(): number { return 1; }
}
function make(): Shape {
  class Local extends Shape {
    override area(): number { return 2; }
  }
  return new Local();
}
${untypedWrite}
const shape = new Shape();
console.log(shape.area(), make().area());
`);
  expect(intactTests(mod)["Shape"]?.body).toBe("false");
});
