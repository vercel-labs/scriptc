import { expect, test, vi } from "vitest";
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
import { DispatchSites } from "./dispatch-sites.js";

const loc: SrcLoc = { file: "sites.ts", start: 0, end: 1 };
const keyRead = (key: string): IrStmt => ({
  kind: "exprStmt",
  expr: {
    kind: "dynKeyGet",
    value: { kind: "varRef", localId: "value", type: DYN, loc },
    key: { kind: "strLit", value: key, type: DYN, loc },
    type: DYN,
    loc,
  },
  loc,
});
const value = (n: number): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "numLit", value: n, type: F64, loc },
  loc,
});
const fn = (body: IrStmt[]): IrFunction => ({
  name: "f",
  body,
  params: [],
  locals: [],
  returnType: VOID,
  loc,
});

test("reuses a function's sites while its statement list is unchanged", () => {
  const sites = new DispatchSites();
  const f = fn([value(1)]);
  const walk = vi.spyOn(traversal, "everyStmtList");
  try {
    expect(sites.of(f).dispatches).toBe(false);
    expect(sites.of(f).dispatches).toBe(false);
    expect(walk).toHaveBeenCalledTimes(1);
    // A statement added to the same list is found.
    f.body.push(keyRead("next"));
    expect(sites.of(f)).toMatchObject({ dispatches: true, generatorSteps: true });
    // So is a replaced list.
    f.body = [value(2)];
    expect(sites.of(f)).toMatchObject({ dispatches: false, generatorSteps: false });
    expect(walk).toHaveBeenCalledTimes(3);
  } finally {
    walk.mockRestore();
  }
});

test("scans a body again once a change inside an unchanged list is reported", () => {
  const sites = new DispatchSites();
  const placeholder: Extract<IrStmt, { kind: "block" }> = { kind: "block", body: [], loc };
  const f = fn([placeholder]);
  expect(sites.of(f).dispatches).toBe(false);
  placeholder.body.push(keyRead("map"));
  sites.forget(f);
  expect(sites.of(f)).toMatchObject({ dispatches: true, runtimeSteps: true });
});

test("a program operates on a dynamic value once a body reads from one, not while it only passes one along", () => {
  const sites = new DispatchSites();
  const classValue: IrType = { kind: "classval", className: "Gauge" };
  const converted: IrExpr = {
    kind: "dynFrom",
    value: { kind: "classRef", className: "Gauge", type: classValue, loc },
    type: DYN,
    loc,
  };
  // A function value called with the class as its receiver, the class kept
  // in a local, and the checked conversion back to the constructor.
  const passing = fn([
    {
      kind: "exprStmt",
      expr: {
        kind: "callValue",
        callee: {
          kind: "varRef",
          localId: "callback",
          type: { kind: "func", params: [], ret: VOID },
          loc,
        },
        receiver: converted,
        args: [],
        type: VOID,
        loc,
      },
      loc,
    },
    { kind: "varDecl", localId: "held", init: converted, loc },
    {
      kind: "exprStmt",
      expr: {
        kind: "dynCheck",
        value: { kind: "varRef", localId: "held", type: DYN, loc },
        type: classValue,
        loc,
      },
      loc,
    },
  ]);
  expect(sites.usesDynamicValues([passing])).toBe(false);
  // A statement added to the same list is found.
  passing.body.push(value(1));
  expect(sites.usesDynamicValues([passing])).toBe(false);
  const reading = fn([keyRead("label")]);
  expect(sites.usesDynamicValues([passing, reading])).toBe(true);
  // The answer stays: bodies are not asked again.
  expect(sites.usesDynamicValues([passing])).toBe(true);
});

test("a checked conversion to anything but a class constructor, and a loop over a dynamic value, operate on it", () => {
  const held: IrExpr = { kind: "varRef", localId: "held", type: DYN, loc };
  const narrowed = fn([
    { kind: "exprStmt", expr: { kind: "dynCheck", value: held, type: F64, loc }, loc },
  ]);
  expect(new DispatchSites().usesDynamicValues([narrowed])).toBe(true);
  const looped = fn([{ kind: "forOf", localId: "item", iterable: held, body: [], loc }]);
  expect(new DispatchSites().usesDynamicValues([looped])).toBe(true);
  // A change inside an unchanged list is seen once it is reported.
  const sites = new DispatchSites();
  const placeholder: Extract<IrStmt, { kind: "block" }> = { kind: "block", body: [], loc };
  const f = fn([placeholder]);
  expect(sites.usesDynamicValues([f])).toBe(false);
  placeholder.body.push(keyRead("label"));
  expect(sites.usesDynamicValues([f])).toBe(false);
  sites.forget(f);
  expect(sites.usesDynamicValues([f])).toBe(true);
});
