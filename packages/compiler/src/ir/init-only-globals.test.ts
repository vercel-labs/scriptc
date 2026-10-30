import { expect, test } from "vitest";
import { freezeInitOnlyGlobals } from "./init-only-globals.js";
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrGlobal,
  type IrModule,
  type IrStmt,
} from "./ir.js";

const loc = { file: "init-only-globals.ts", start: 0, end: 0 };
const source = { loc, scope: loc };
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId: string): IrExpr => ({ loc, kind: "varRef", localId, type: F64 });
const assign = (localId: string, value: IrExpr): IrStmt => ({
  loc,
  kind: "assign",
  localId,
  value,
});
const use = (expr: IrExpr): IrStmt => ({ loc, kind: "exprStmt", expr });
const ret = (value: IrExpr): IrStmt => ({ loc, kind: "return", value });
const fn = (name: string, body: IrStmt[], extra: Partial<IrFunction> = {}): IrFunction => ({
  loc,
  name,
  params: [],
  locals: [],
  returnType: name === "%init" ? VOID : F64,
  body,
  ...extra,
});
const binding = (id: string, extra: Partial<IrGlobal> = {}): IrGlobal => ({
  id,
  name: id,
  type: F64,
  mutable: true,
  source,
  ...extra,
});
const guard: IrGlobal = { id: "%g.%loaded", name: "%loaded", type: BOOL, mutable: true };
const guarded = (body: IrStmt[]): IrStmt[] => [
  {
    loc,
    kind: "if",
    cond: { loc, kind: "varRef", localId: guard.id, type: BOOL },
    then: [{ loc, kind: "return", value: null }],
    else_: null,
  },
  {
    loc,
    kind: "assign",
    localId: guard.id,
    value: { loc, kind: "boolLit", value: true, type: BOOL },
  },
  ...body,
];
const moduleOf = (globals: IrGlobal[], functions: IrFunction[]): IrModule => ({
  irVersion: 17,
  sourceFile: "init-only-globals.ts",
  entry: "%init",
  globals: [guard, ...globals],
  functions,
});
const mutability = (mod: IrModule): Record<string, boolean> =>
  Object.fromEntries((mod.globals ?? []).map((g) => [g.name, g.mutable]));

test("source bindings stored once by the guarded initializer become immutable", () => {
  const mod = moduleOf(
    [
      binding("%g.SIZE"),
      binding("%g.BLOCK"),
      binding("%g.TWICE"),
      binding("%g.LATER"),
      binding("%g.EARLY"),
      binding("%g.FLAGGED", { initFlag: "%g.FLAGGED%initialized" }),
      binding("%g.CHECKED", { tdz: true }),
      binding("%g.LOOPED"),
      binding("%g.LABELED"),
    ],
    [
      fn(
        "%init",
        guarded([
          use(ref("%g.EARLY")),
          assign("%g.SIZE", num(24)),
          { loc, kind: "block", body: [assign("%g.BLOCK", ref("%g.SIZE"))] },
          assign("%g.TWICE", num(1)),
          assign("%g.TWICE", num(2)),
          assign("%g.LATER", num(3)),
          assign("%g.EARLY", num(4)),
          assign("%g.FLAGGED", num(5)),
          assign("%g.CHECKED", num(6)),
          { loc, kind: "while", cond: ref("%g.SIZE"), body: [assign("%g.LOOPED", num(7))] },
          { loc, kind: "block", labels: ["out"], body: [assign("%g.LABELED", num(8))] },
        ]),
      ),
      fn("bump", [assign("%g.LATER", num(9)), ret(ref("%g.SIZE"))]),
    ],
  );
  expect(mutability(freezeInitOnlyGlobals(mod))).toEqual({
    "%loaded": true,
    "%g.SIZE": false,
    "%g.BLOCK": false,
    "%g.TWICE": true,
    "%g.LATER": true,
    "%g.EARLY": true,
    "%g.FLAGGED": true,
    "%g.CHECKED": true,
    "%g.LOOPED": true,
    "%g.LABELED": true,
  });
});

test("unguarded, asynchronous and library initializers keep their bindings mutable", () => {
  const globals = [binding("%g.SIZE")];
  const store = [assign("%g.SIZE", num(24))];
  const unguarded = moduleOf(globals, [fn("%init", store)]);
  const asyncInit = moduleOf(globals, [fn("%init", guarded(store), { async: true })]);
  const library: IrModule = {
    ...moduleOf(globals, [fn("%init", guarded(store))]),
    lib: {} as NonNullable<IrModule["lib"]>,
  };
  for (const mod of [unguarded, asyncInit, library]) expect(freezeInitOnlyGlobals(mod)).toBe(mod);
});

test("compiler-internal globals without a source binding are never frozen", () => {
  const internal: IrGlobal = { id: "%g.%cache", name: "%cache", type: F64, mutable: true };
  const mod = moduleOf([internal], [fn("%init", guarded([assign(internal.id, num(1))]))]);
  expect(freezeInitOnlyGlobals(mod)).toBe(mod);
});
