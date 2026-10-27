import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  F64,
  JSVAL,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import { promoteJsvals } from "./jsval.js";
import { assignLegacyTiers } from "./tiers.js";
import { validateModule } from "./validate.js";

const loc = { file: "jsval.ts", start: 0, end: 0 };
const ref = (id: string, type = DYN): IrExpr => ({ kind: "varRef", localId: id, type, loc });
const num = (value: number): IrExpr => ({
  kind: "dynFrom",
  value: { kind: "numLit", value, type: F64, loc },
  type: DYN,
  loc,
});
const op = (fn: "dyn.add" | "dyn.arithmetic", l: IrExpr, r: IrExpr, symbol?: string): IrExpr => ({
  kind: "libCall",
  fn,
  args:
    symbol === undefined ? [l, r] : [l, r, { kind: "strLit", value: symbol, type: STRING, loc }],
  type: DYN,
  loc,
});
const keyGet = (from: IrExpr, key: string): IrExpr => ({
  kind: "dynKeyGet",
  key: { kind: "strLit", value: key, type: STRING, loc },
  value: from,
  type: DYN,
  loc,
});

function fn(name: string, body: IrStmt[], locals: string[] = [], returnType = DYN): IrFunction {
  return {
    name,
    params: [{ localId: "o", name: "o", type: DYN }],
    returnType,
    locals: [
      { id: "o", name: "o", type: DYN, mutable: false },
      ...locals.map((id) => ({ id, name: id, type: DYN, mutable: true })),
    ],
    body,
    loc,
  };
}

function moduleOf(...functions: IrFunction[]): IrModule {
  const main: IrFunction = {
    name: "%main",
    params: [],
    returnType: VOID,
    locals: [],
    body: [],
    loc,
  };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: "jsval.ts",
    functions: [main, ...functions],
    entry: "%main",
  };
  assignLegacyTiers(mod.functions);
  return mod;
}

/** The js.* calls of a body, in source order. */
function jsCalls(body: IrStmt[]): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") {
      const node = value as { kind?: string; fn?: string };
      if (node.kind === "libCall" && node.fn?.startsWith("js.")) out.push(node.fn);
      Object.values(value).forEach(visit);
    }
  };
  visit(body);
  return out;
}

test("operator chains compute with jsvals and box only where a dyn value is needed", () => {
  // return o.x * o.y + 1
  const chain = fn("chain", [
    {
      kind: "return",
      value: op(
        "dyn.add",
        op("dyn.arithmetic", keyGet(ref("o"), "x"), keyGet(ref("o"), "y"), "*"),
        num(1),
      ),
      loc,
    },
  ]);
  const mod = moduleOf(chain);
  expect(chain.tier).toBe("dynamic");
  // A static caller keeps the dyn ABI: one box at the end of the chain,
  // none in between; the static 1 is an immediate and the reads keep their
  // cells.
  const caller = fn("caller", [
    {
      kind: "return",
      value: { kind: "call", callee: "chain", args: [ref("o")], type: DYN, loc },
      loc,
    },
  ]);
  mod.functions.push(caller);
  expect(caller.tier).toBeUndefined();
  expect(promoteJsvals(mod)).toBe(1);
  expect(chain.returnType).toEqual(DYN);
  expect(jsCalls(chain.body)).toEqual([
    "js.toDyn",
    "js.add",
    "js.arithmetic",
    "js.fromDyn",
    "js.fromDyn",
    "js.fromF64",
  ]);
  expect(jsCalls(caller.body)).toEqual([]);
  expect(validateModule(mod)).toEqual([]);
});

test("a dynamic function called only by dynamic functions returns a jsval", () => {
  const twice = fn("twice", [
    { kind: "return", value: op("dyn.arithmetic", keyGet(ref("o"), "n"), num(2), "*"), loc },
  ]);
  // return twice(o) + twice(o): no box between the calls and the add.
  const sum = fn("sum", [
    {
      kind: "return",
      value: op(
        "dyn.add",
        { kind: "call", callee: "twice", args: [ref("o")], type: DYN, loc },
        { kind: "call", callee: "twice", args: [ref("o")], type: DYN, loc },
      ),
      loc,
    },
  ]);
  const user = fn("user", [
    {
      kind: "exprStmt",
      expr: keyGet({ kind: "call", callee: "sum", args: [ref("o")], type: DYN, loc }, "x"),
      loc,
    },
    { kind: "return", value: ref("o"), loc },
  ]);
  const mod = moduleOf(twice, sum, user);
  promoteJsvals(mod);
  expect(twice.returnType).toEqual(JSVAL);
  expect(sum.returnType).toEqual(JSVAL);
  expect(jsCalls(twice.body)).toEqual(["js.arithmetic", "js.fromDyn", "js.fromF64"]);
  expect(jsCalls(sum.body)).toEqual(["js.add"]);
  // A dyn consumer boxes the jsval result once.
  expect(jsCalls(user.body)).toEqual(["js.toDyn", "js.fromDyn"]);
  expect(validateModule(mod)).toEqual([]);
});

test("a number check of an operator result reads the jsval, and comparisons take jsvals", () => {
  const checked = fn(
    "checked",
    [
      {
        kind: "if",
        cond: {
          kind: "libCall",
          fn: "dyn.compare",
          args: [keyGet(ref("o"), "a"), num(3), { kind: "strLit", value: "<", type: STRING, loc }],
          type: BOOL,
          loc,
        },
        then: [{ kind: "return", value: { kind: "numLit", value: 0, type: F64, loc }, loc }],
        else_: null,
        loc,
      },
      {
        kind: "return",
        value: {
          kind: "dynCheck",
          value: op("dyn.arithmetic", keyGet(ref("o"), "a"), num(2), "%"),
          type: F64,
          loc,
        },
        loc,
      },
    ],
    [],
    F64,
  );
  const mod = moduleOf(checked);
  promoteJsvals(mod);
  expect(jsCalls(checked.body)).toEqual([
    "js.compare",
    "js.fromDyn",
    "js.fromF64",
    "js.toF64",
    "js.arithmetic",
    "js.fromDyn",
    "js.fromF64",
  ]);
  expect(validateModule(mod)).toEqual([]);
});

test("a dyn local written by operators in a loop becomes a jsval local", () => {
  // acc = o.start; for (...) acc = acc + o.step; return acc
  const loop = fn(
    "loop",
    [
      { kind: "varDecl", localId: "acc", init: keyGet(ref("o"), "start"), loc },
      {
        kind: "while",
        cond: { kind: "boolLit", value: false, type: BOOL, loc },
        body: [
          {
            kind: "assign",
            localId: "acc",
            value: op("dyn.add", ref("acc"), keyGet(ref("o"), "step")),
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: ref("acc"), loc },
    ],
    ["acc"],
  );
  const mod = moduleOf(loop);
  promoteJsvals(mod);
  expect(loop.locals.find((l) => l.id === "acc")!.type).toEqual(JSVAL);
  expect(loop.returnType).toEqual(JSVAL);
  expect(jsCalls(loop.body)).toEqual(["js.fromDyn", "js.add", "js.fromDyn"]);
  expect(validateModule(mod)).toEqual([]);
});

test("a dyn local mostly read by dyn consumers stays dyn", () => {
  // t = o.a + 1; for (...) use(t)
  const reader = fn(
    "reader",
    [
      { kind: "varDecl", localId: "t", init: op("dyn.add", keyGet(ref("o"), "a"), num(1)), loc },
      {
        kind: "while",
        cond: { kind: "boolLit", value: false, type: BOOL, loc },
        body: [{ kind: "exprStmt", expr: keyGet(ref("t"), "x"), loc }],
        loc,
      },
      { kind: "return", value: ref("t"), loc },
    ],
    ["t"],
  );
  const mod = moduleOf(reader);
  promoteJsvals(mod);
  expect(reader.locals.find((l) => l.id === "t")!.type).toEqual(DYN);
  expect(validateModule(mod)).toEqual([]);
});

test("static functions keep their dyn values; async functions keep their dyn result", () => {
  const plain = fn("plain", [{ kind: "return", value: ref("o"), loc }]);
  const asyncChain = fn("asyncChain", [
    { kind: "return", value: op("dyn.add", keyGet(ref("o"), "x"), num(1)), loc },
  ]);
  asyncChain.async = true;
  const mod = moduleOf(plain, asyncChain);
  expect(plain.tier).toBeUndefined();
  expect(asyncChain.tier).toBe("dynamic");
  const before = JSON.stringify(plain);
  expect(promoteJsvals(mod)).toBe(1);
  expect(JSON.stringify(plain)).toBe(before);
  expect(asyncChain.returnType).toEqual(DYN);
  expect(jsCalls(asyncChain.body)).toEqual(["js.toDyn", "js.add", "js.fromDyn", "js.fromF64"]);
  expect(validateModule(mod)).toEqual([]);
});
