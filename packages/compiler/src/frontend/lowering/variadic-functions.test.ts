import { beforeEach, expect, test, vi } from "vitest";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import {
  DYN,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import * as traversal from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";
import {
  checkVariadicFunctions,
  setCheckVariadicSkip,
  type FinishedBodies,
} from "./variadic-functions.js";

// The suites run with the check mode on (vitest.config.ts); these tests count
// the walks of a build without it, and turn it on where they test it.
beforeEach(() => setCheckVariadicSkip(false));

const loc: SrcLoc = { file: "variadic.ts", start: 0, end: 1 };
const VARIADIC: IrType = { kind: "func", params: [], ret: DYN, rest: true };
const FIXED: IrType = { kind: "func", params: [F64], ret: DYN };
const TYPED_REST: IrType = {
  kind: "func",
  params: [{ kind: "array", elem: F64 }],
  ret: DYN,
  rest: true,
  restAbi: "typed",
};

const statement = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const read = (type: IrType): IrExpr => ({ kind: "varRef", localId: "callback", type, loc });
/** A runtime builtin given `argument`. */
const builtinCall = (argument: IrExpr): IrStmt =>
  statement({ kind: "libCall", fn: "dyn.valueOf", args: [argument], type: DYN, loc });
const fn = (name: string, body: IrStmt[], signature: Partial<IrFunction> = {}): IrFunction => ({
  name,
  body,
  params: [],
  locals: [],
  returnType: VOID,
  loc,
  ...signature,
});

/** The part of a Lowerer the check reads when no store is found. */
function lowering(tables: { stores?: string[]; adapters?: string[] } = {}): {
  lowerer: Lowerer;
  diags: ScrDiagnostic[];
} {
  const diags: ScrDiagnostic[] = [];
  const lowerer = {
    diags,
    pushDiag: (diag: ScrDiagnostic) => diags.push(diag),
    notedVariadicStores: new Set(tables.stores ?? []),
    notedLongerCalls: new Set<string>(),
    freshClosureAdapters: new Set(tables.adapters ?? []),
    fmt: () => "(x: number) => unknown",
    moduleOrder: [],
    unions: new Map(),
    shapes: new Map(),
    classes: new Map(),
  } as unknown as Lowerer;
  return { lowerer, diags };
}

/** How many bodies the check walks for `functions`, told `bodies`. */
function walked(lowerer: Lowerer, functions: IrFunction[], bodies?: FinishedBodies): number {
  const walk = vi.spyOn(traversal, "everyStmtList");
  try {
    checkVariadicFunctions(lowerer, functions, bodies);
    return walk.mock.calls.length;
  } finally {
    walk.mockRestore();
  }
}

const NONE: FinishedBodies = { variadicFunctions: false };
const SOME: FinishedBodies = { variadicFunctions: true };

test("a program without a variadic function is not walked", () => {
  const { lowerer, diags } = lowering();
  const functions = [
    fn("main", [builtinCall(read(FIXED))]),
    fn("other", [builtinCall(read(TYPED_REST))]),
  ];
  expect(walked(lowerer, functions, NONE)).toBe(0);
  expect(diags).toEqual([]);
  // Without the answer of the step before, it is.
  expect(walked(lowerer, functions)).toBe(2);
});

test("a variadic function handed to a builtin is refused told so as untold", () => {
  const functions = (): IrFunction[] => [
    fn("main", [builtinCall(read(FIXED))]),
    fn("handler", [builtinCall(read(VARIADIC))]),
  ];
  const untold = lowering();
  checkVariadicFunctions(untold.lowerer, functions());
  const told = lowering();
  expect(walked(told.lowerer, functions(), SOME)).toBe(2);
  expect(untold.diags.map((diag) => diag.code)).toEqual(["SC1090"]);
  expect(told.diags).toEqual(untold.diags);
});

test("a store lowering noted keeps the walk", () => {
  const store = ["func(f64)=>dyn", "(x: number) => unknown", 1, "variadic.ts", 0, 1].join("\u001f");
  const { lowerer } = lowering({ stores: [store] });
  const functions = [fn("main", [builtinCall(read(FIXED))])];
  expect(walked(lowerer, functions, NONE)).toBe(1);
});

test("an adapter whose call is a store keeps the walk", () => {
  const variadic = fn("%fn.variadic.0", [], {
    params: [{ localId: "f.0", name: "f", type: DYN }],
    returnType: FIXED,
  });
  const packing = fn("%fn.adapt.0", [], {
    params: [{ localId: "f.0", name: "f", type: TYPED_REST }],
    returnType: FIXED,
  });
  // An adapter between fixed signatures stores nothing.
  const widening = fn("%fn.adapt.1", [], {
    params: [{ localId: "f.0", name: "f", type: FIXED }],
    returnType: { kind: "func", params: [F64, F64], ret: DYN },
  });
  for (const [factory, walks] of [
    [variadic, true],
    [packing, true],
    [widening, false],
  ] as const) {
    const { lowerer } = lowering({ adapters: [factory.name] });
    const count = walked(lowerer, [fn("main", []), factory], NONE);
    expect(count > 0, factory.name).toBe(walks);
  }
});

test("the check mode fails a skip that the walk would not have made", () => {
  const { lowerer } = lowering();
  // A variadic function in a body the step before said holds none.
  const main = fn("main", [builtinCall(read(VARIADIC))]);
  setCheckVariadicSkip(true);
  expect(() => checkVariadicFunctions(lowerer, [main], NONE)).toThrow(
    /skipped for a program in which main holds/,
  );
  // And passes a skip the walk agrees with, having walked.
  const typed = lowering();
  expect(walked(typed.lowerer, [fn("main", [builtinCall(read(FIXED))])], NONE)).toBe(2);
  expect(typed.diags).toEqual([]);
});
