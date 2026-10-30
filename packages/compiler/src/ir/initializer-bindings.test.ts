import { expect, test } from "vitest";
import {
  conditionalLoopWrites,
  findInitializerBindings,
  initializerLocalCandidates,
  withInitializerBindings,
  withInitializerLocals,
} from "./initializer-bindings.js";
import {
  BOOL,
  F64,
  VOID,
  type IrFunction,
  type IrGlobal,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import { analyzeIntegerRanges } from "./integer-ranges.js";

const loc = { file: "test.ts", start: 0, end: 1 };
const assign = (id: string, value: number): IrStmt => ({
  kind: "assign",
  localId: id,
  value: { kind: "numLit", value, type: F64, loc },
  loc,
});
function fixture(): IrModule {
  const fn: IrFunction = {
    name: "init",
    params: [],
    locals: [],
    returnType: VOID,
    loc,
    body: [
      {
        kind: "if",
        cond: { kind: "varRef", localId: "guard", type: BOOL, loc },
        then: [{ kind: "return", value: null, loc }],
        else_: null,
        loc,
      },
      {
        kind: "assign",
        localId: "guard",
        value: { kind: "boolLit", value: true, type: BOOL, loc },
        loc,
      },
      assign("value", 17),
      { kind: "exprStmt", expr: { kind: "varRef", localId: "value", type: F64, loc }, loc },
    ],
  };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: fn.name,
    functions: [fn],
    globals: [
      { id: "guard", name: "guard", type: BOOL, mutable: true },
      { id: "value", name: "value", type: F64, mutable: true },
    ],
  };
}

test("private initializer bindings supply numeric facts without rewriting storage or ABI", () => {
  const mod = fixture(),
    fn = mod.functions[0]!;
  const bindings = findInitializerBindings(mod).get(fn.name)!;
  expect(bindings.map((g) => g.id)).toEqual(["value"]);
  const numeric = withInitializerBindings(fn, bindings);
  const read = fn.body[3]!;
  if (read.kind !== "exprStmt") throw new Error("fixture");
  expect(analyzeIntegerRanges(fn).get(read.expr)).toBeNull();
  expect(analyzeIntegerRanges(numeric).get(read.expr)).toEqual({ min: 17, max: 17 });
  expect(numeric.body).toBe(fn.body);
  expect(fn.locals).toEqual([]);
  expect(fn.params).toEqual([]);
  expect(mod.globals!.length).toBe(2);
  expect(withInitializerBindings(fn, [])).toBe(fn);
});

test("cross-function reads, writes and closure captures exclude a global", () => {
  for (const operation of ["read", "write", "capture"] as const) {
    const mod = fixture(),
      fn = mod.functions[0]!;
    const other: IrFunction = {
      ...fn,
      name: "other",
      body: operation === "write" ? [assign("value", 0.5)] : [fn.body[3]!],
    };
    if (operation === "capture")
      other.body = [
        {
          kind: "exprStmt",
          loc,
          expr: {
            kind: "closure",
            fnName: fn.name,
            captures: ["value"],
            type: { kind: "func", params: [], ret: VOID },
            loc,
          },
        },
      ];
    mod.functions.push(other);
    expect(findInitializerBindings(mod).size, operation).toBe(0);
  }
});

test("guards must return immediately and have exactly one write", () => {
  for (const change of [
    "unguarded",
    "late",
    "reset",
    "foreign-reset",
    "async",
    "generator",
    "tdz",
  ] as const) {
    const mod = fixture(),
      fn = mod.functions[0]!;
    if (change === "unguarded") fn.body.shift();
    if (change === "late") fn.body.unshift(assign("value", 1));
    if (change === "reset") fn.body.push(fn.body[1]!);
    if (change === "foreign-reset")
      mod.functions.push({ ...fn, name: "reset", body: [fn.body[1]!] });
    if (change === "async") fn.async = true;
    if (change === "generator")
      fn.generator = { yieldT: F64, nextT: VOID, resultType: { kind: "record", shapeId: "r0" } };
    if (change === "tdz") mod.globals![1]!.tdz = true;
    expect(findInitializerBindings(mod).size, change).toBe(0);
  }
});

test("number bindings without an import-cycle flag may move into a local", () => {
  const mod = fixture(),
    fn = mod.functions[0]!;
  const bindings = findInitializerBindings(mod).get(fn.name)!;
  const flagged: IrGlobal = { id: "cyc", name: "cyc", type: F64, mutable: true, initFlag: "flag" };
  const bytes: IrGlobal = {
    id: "b",
    name: "b",
    type: { kind: "bytes", elem: "u8" },
    mutable: true,
  };
  const candidates = initializerLocalCandidates([...bindings, flagged, bytes]);
  expect(candidates.map((g) => g.id)).toEqual(["value"]);
  // The view lists them as plain locals; parameters and body are unchanged.
  const view = withInitializerLocals(fn, candidates);
  expect(view.locals.map((l) => l.id)).toEqual(["value"]);
  expect(view.params).toBe(fn.params);
  expect(view.body).toBe(fn.body);
  expect(withInitializerLocals(fn, [])).toBe(fn);
});

test("conditional loop writes are those an iteration may skip", () => {
  const t = { kind: "boolLit", value: true, type: BOOL, loc } as const;
  const inc = (id: string): IrStmt => ({
    kind: "exprStmt",
    expr: { kind: "incDec", localId: id, op: "+", prefix: true, type: F64, loc },
    loc,
  });
  const body: IrStmt[] = [
    // Outside any loop, a conditional write is irrelevant.
    { kind: "if", cond: t, then: [assign("outside", 1)], else_: null, loc },
    {
      kind: "while",
      cond: t,
      body: [
        assign("always", 1),
        { kind: "if", cond: t, then: [inc("sometimes")], else_: null, loc },
        // An inner loop's own body writes unconditionally for that loop.
        { kind: "while", cond: t, body: [assign("inner", 2)], loc },
        {
          kind: "exprStmt",
          expr: {
            kind: "logical",
            op: "&&",
            left: t,
            right: { kind: "assignExpr", localId: "shortCircuit", value: t, type: BOOL, loc },
            type: BOOL,
            loc,
          },
          loc,
        },
      ],
      loc,
    },
  ];
  expect([...conditionalLoopWrites(body)].sort()).toEqual(["shortCircuit", "sometimes"]);
});
