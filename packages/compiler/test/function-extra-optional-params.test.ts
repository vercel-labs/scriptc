import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, type ScrDiagnostic } from "../src/index.js";
import type { IrExpr, IrModule } from "../src/ir/ir.js";
import { everyStmtList } from "../src/ir/traverse.js";

interface Lowered {
  ok: boolean;
  diagnostics: ScrDiagnostic[];
  module: IrModule | null;
}

async function lowerSource(source: string): Promise<Lowered> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-fn-param-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) return { ok: false, diagnostics: result.diagnostics, module: null };
    return {
      ok: true,
      diagnostics: [],
      module: deserializeModule(await readFile(outPath, "utf8")),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every indirect `callValue` in the module, flattened. */
function callValues(mod: IrModule): IrExpr[] {
  const out: IrExpr[] = [];
  for (const fn of mod.functions) {
    everyStmtList(fn.body, {
      expr: (e) => {
        if (e.kind === "callValue") out.push(e);
        return true;
      },
      stmt: () => true,
    });
  }
  return out;
}

/** The adapter call that invokes a source function with MORE parameters than
 * the destination slot it was converted into. */
function extraParamAdapterCalls(mod: IrModule) {
  return callValues(mod).filter(
    (e): e is IrExpr & { kind: "callValue" } =>
      e.kind === "callValue" &&
      e.callee.type.kind === "func" &&
      !e.callee.type.rest &&
      e.callee.type.params.length === 2 &&
      e.args.length === 2,
  );
}

test("an extra optional parameter receives undefined through the adapter", async () => {
  const { ok, diagnostics, module } = await lowerSource(`
type Slot = (value: string) => void;
type Source = (value: string | undefined, extra?: number) => void;

function take(callback: Slot): void {
  callback("x");
}

function forward(callback: Source): void {
  take(callback);
}

forward((value, extra) => {
  console.log(value, extra);
});
export {};
`);
  expect(diagnostics).toEqual([]);
  expect(ok).toBe(true);
  if (!module) return;

  const adapted = extraParamAdapterCalls(module);
  expect(adapted).toHaveLength(1);
  const call = adapted[0]!;
  if (call.kind !== "callValue") return;

  // The slot's `string` parameter still widens into the source's
  // `string | undefined`.
  expect(call.args[0]!.kind).toBe("unionWrap");
  expect(call.args[0]!.type.kind).toBe("union");
  // The absent extra parameter is the undefined arm of its `number |
  // undefined` ABI union, wrapping a unit `undefined`.
  expect(call.args[1]).toMatchObject({
    kind: "unionWrap",
    value: { kind: "unitLit", unit: "undefined" },
  });
  expect(call.args[1]!.type.kind).toBe("union");
});

test("an extra checked-dynamic optional parameter receives undefined", async () => {
  const { ok, diagnostics, module } = await lowerSource(`
function take(callback: (value: string) => void): void {
  callback("x");
}

function forward(callback: (value: string, meta?: any) => void): void {
  take(callback);
}

forward((value, meta) => {
  console.log(value, meta === undefined);
});
export {};
`);
  expect(diagnostics).toEqual([]);
  expect(ok).toBe(true);
  if (!module) return;

  const adapted = extraParamAdapterCalls(module);
  expect(adapted).toHaveLength(1);
  const call = adapted[0]!;
  if (call.kind !== "callValue") return;
  expect(call.args[1]!.type.kind).toBe("dyn");
});

test("an extra REQUIRED parameter stays a checker refusal", async () => {
  const { ok, diagnostics } = await lowerSource(`
function take(callback: (value: string) => void): void {
  callback("x");
}

function two(value: string, count: number): void {
  console.log(value, count);
}

take(two);
export {};
`);
  expect(ok).toBe(false);
  expect(diagnostics.map((d) => d.code)).toContain("SC0001");
});

test("a typed-rest source stays served by the rest-packing adapter", async () => {
  // The typed-rest source is admitted by TypeScript (the rest may be empty)
  // and already lowering through the rest-packing adapter, not the
  // extra-parameter path this fix touches.
  const { ok, diagnostics } = await lowerSource(`
function take(callback: (value: string) => void): void {
  callback("x");
}

function rest(value: string, ...others: number[]): void {
  console.log(value, others.length);
}

take(rest);
export {};
`);
  expect(diagnostics).toEqual([]);
  expect(ok).toBe(true);
});
