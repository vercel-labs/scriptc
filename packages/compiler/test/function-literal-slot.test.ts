import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrExpr, IrFunction, IrModule } from "../src/ir/ir.js";
import { everyStmtList } from "../src/ir/traverse.js";

async function lowerSource(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-fn-slot-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function expressions(mod: IrModule, keep: (e: IrExpr) => boolean): IrExpr[] {
  const out: IrExpr[] = [];
  for (const fn of mod.functions) {
    everyStmtList(fn.body, {
      expr: (e) => {
        if (keep(e)) out.push(e);
        return true;
      },
      stmt: () => true,
    });
  }
  return out;
}

/** Calls of a signature adapter factory: each wraps a function value in a
 * second closure. */
const adapterCalls = (mod: IrModule): IrExpr[] =>
  expressions(mod, (e) => e.kind === "call" && e.callee.startsWith("%fn.adapt."));

/** The closures over function literals (lifted `%fn.<hash>` functions), with
 * the function each one names. */
function literals(mod: IrModule): { closure: IrExpr & { kind: "closure" }; fn: IrFunction }[] {
  const byName = new Map(mod.functions.map((fn) => [fn.name, fn]));
  return expressions(mod, (e) => e.kind === "closure" && /^%fn\.[0-9a-f]{12}/.test(e.fnName)).map(
    (e) => {
      const closure = e as IrExpr & { kind: "closure" };
      return { closure, fn: byName.get(closure.fnName)! };
    },
  );
}

const EACH = `
function each(xs: number[], f: (value: number, index: number) => void): void {
  for (let i = 0; i < xs.length; i++) f(xs[i]!, i);
}
`;

test("a literal with fewer parameters takes its slot's parameter list", async () => {
  const mod = await lowerSource(`${EACH}
let total = 0;
each([1, 2, 3], (x) => {
  total += x;
});
each([1, 2, 3], () => {
  total += 1;
});
console.log(total);
export {};
`);
  expect(adapterCalls(mod)).toEqual([]);
  const found = literals(mod);
  expect(found.map(({ fn }) => fn.params.length)).toEqual([2, 2]);
  expect(
    found.map(({ closure }) => closure.type.kind === "func" && closure.type.params.length),
  ).toEqual([2, 2]);
  // Function.length stays the declared count.
  expect(found.map(({ closure }) => closure.length)).toEqual([1, 0]);
});

test("a literal with its slot's own parameter list records no length", async () => {
  const mod = await lowerSource(`${EACH}
let total = 0;
each([1, 2, 3], (x, i) => {
  total += x + i;
});
console.log(total);
export {};
`);
  expect(adapterCalls(mod)).toEqual([]);
  expect(literals(mod).map(({ closure }) => closure.length)).toEqual([undefined]);
});

test("a literal in a record field, a binding and a returned value takes the slot's list", async () => {
  const mod = await lowerSource(`
type Pick = (value: number, index: number) => boolean;
interface Visitor {
  keep: Pick;
  skip?: Pick;
}
function make(limit: number): Pick {
  return (x) => x > limit;
}
function run(v: Visitor, f: Pick): number {
  return (v.keep(1, 0) ? 1 : 0) + (f(2, 0) ? 2 : 0) + (v.skip?.(3, 0) ? 4 : 0);
}
const bound: Pick = (x) => x > 1;
console.log(run({ keep: () => true, skip: (x) => x === 3 }, bound), run({ keep: make(0) }, make(5)));
export {};
`);
  expect(adapterCalls(mod)).toEqual([]);
  expect(literals(mod).map(({ fn }) => fn.params.length)).toEqual([2, 2, 2, 2]);
});

test("a parameter declared wider than the slot passes converts at entry", async () => {
  const mod = await lowerSource(`${EACH}
const seen: string[] = [];
each([1, 2], (x: unknown) => {
  seen.push(typeof x);
});
console.log(seen.join(","));
export {};
`);
  expect(adapterCalls(mod)).toEqual([]);
  const [{ fn }] = literals(mod) as [{ fn: IrFunction }];
  // The ABI parameters are the slot's; the declared name binds from the first.
  expect(fn.params.map((p) => p.type.kind)).toEqual(["f64", "f64"]);
  const first = fn.body[0];
  expect(first?.kind).toBe("varDecl");
  expect(first?.kind === "varDecl" && first.init?.type.kind).toBe("dyn");
});

test("forms whose parameters the slot cannot stand in for keep the adapter", async () => {
  const forms = [
    // A named function expression can call itself with its own parameter list.
    "each([1], function self(x) { if (x > 5) self(0); });",
    // A rest parameter collects what the caller passed.
    "each([1], (...all: number[]) => { void all; });",
    // A default beside a conversion: the conversion ran before the default.
    "each([1], (x: unknown, i = 7) => { void x; void i; });",
    // `arguments` holds what the caller passed.
    "each([1], function (x) { void x; void arguments.length; });",
    // More parameters than the slot passes.
    "each([1], (x, i, extra?: string) => { void x; void i; void extra; });",
  ];
  for (const form of forms) {
    const mod = await lowerSource(`${EACH}\n${form}\nexport {};\n`);
    expect(adapterCalls(mod).length, form).toBe(1);
    expect(literals(mod).map(({ closure }) => closure.length)).toEqual([undefined]);
  }
});
