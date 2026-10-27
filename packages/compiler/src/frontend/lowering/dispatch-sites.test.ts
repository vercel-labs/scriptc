import { expect, test, vi } from "vitest";
import { DYN, F64, VOID, type IrFunction, type IrStmt, type SrcLoc } from "../../ir/ir.js";
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
