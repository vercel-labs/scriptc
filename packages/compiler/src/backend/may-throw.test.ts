import { expect, test } from "vitest";
import {
  DYN,
  F64,
  VOID,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "../ir/ir.js";
import { computeMayThrow } from "./may-throw.js";

const loc = { file: "tdz.ts", start: 0, end: 1 };
const value: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
const local: IrLocal = {
  id: "value",
  name: "value",
  type: F64,
  mutable: true,
  boxed: true,
  tdz: true,
};
function fn(name: string, body: IrStmt[], locals: IrLocal[] = [local]): IrFunction {
  return { name, body, locals, params: [], returnType: VOID, loc };
}
function moduleWith(...functions: IrFunction[]): IrModule {
  return { irVersion: 14, sourceFile: loc.file, entry: "caller", functions };
}
const assignment: IrStmt = { kind: "assign", localId: local.id, value, loc };
const expression: IrExpr = { kind: "assignExpr", localId: local.id, value, type: F64, loc };
const increment: IrExpr = {
  kind: "incDec",
  localId: local.id,
  op: "+",
  prefix: false,
  type: F64,
  loc,
};
const read: IrExpr = { kind: "varRef", localId: local.id, type: F64, loc };
const exprStmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });

test.each([
  ["store", assignment],
  ["assignment expression", exprStmt(expression)],
  ["increment", exprStmt(increment)],
  ["read", exprStmt(read)],
] as const)("TDZ %s propagates through the direct call graph", (_name, operation) => {
  const target = fn("target", [operation]);
  const middle = fn(
    "middle",
    [exprStmt({ kind: "call", callee: "target", args: [], type: VOID, loc })],
    [],
  );
  const caller = fn(
    "caller",
    [exprStmt({ kind: "call", callee: "middle", args: [], type: VOID, loc })],
    [],
  );
  const answer = computeMayThrow(moduleWith(caller, middle, target));
  expect([...answer.fns].sort()).toEqual(["caller", "middle", "target"]);
  expect(answer.indirect).toBe(false);
});

test("TDZ stores seed indirect-call propagation", () => {
  const closure: IrExpr = {
    kind: "closure",
    fnName: "target",
    captures: [],
    type: funcOf([], VOID),
    loc,
  };
  const caller = fn(
    "caller",
    [exprStmt({ kind: "callValue", callee: closure, args: [], type: VOID, loc })],
    [],
  );
  const answer = computeMayThrow(moduleWith(caller, fn("target", [assignment])));
  expect(answer.indirect).toBe(true);
  expect([...answer.fns].sort()).toEqual(["caller", "target"]);
});

test.each([true, false])(
  "declaration stores do not throw solely for TDZ (mutable=%s)",
  (mutable) => {
    const initialize: IrStmt = { ...assignment, initializes: true };
    expect(
      computeMayThrow(moduleWith(fn("caller", [initialize], [{ ...local, mutable }]))).fns.size,
    ).toBe(0);
  },
);

test("legacy const TDZ stores remain initialization", () => {
  const immutable = { ...local, mutable: false };
  expect(computeMayThrow(moduleWith(fn("caller", [assignment], [immutable]))).fns.size).toBe(0);
});

test("ordinary boxed stores do not gain an exception edge", () => {
  const ordinary: IrLocal = {
    id: local.id,
    name: local.name,
    type: F64,
    mutable: true,
    boxed: true,
  };
  expect(
    computeMayThrow(
      moduleWith(fn("caller", [assignment, exprStmt(expression), exprStmt(increment)], [ordinary])),
    ).fns.size,
  ).toBe(0);
});

test("initializers still propagate exceptions from their right-hand side", () => {
  const initialize: IrStmt = {
    ...assignment,
    initializes: true,
    value: { kind: "call", callee: "failure", args: [], type: F64, loc },
  };
  const failure = fn("failure", [{ kind: "throw", value, loc }], []);
  expect([...computeMayThrow(moduleWith(fn("caller", [initialize]), failure)).fns].sort()).toEqual([
    "caller",
    "failure",
  ]);
});

const call = (callee: string): IrStmt =>
  exprStmt({ kind: "call", callee, args: [], type: VOID, loc });
const closureOf = (fnName: string): IrExpr => ({
  kind: "closure",
  fnName,
  captures: [],
  type: funcOf([], VOID),
  loc,
});
const callClosure = (fnName: string): IrStmt =>
  exprStmt({ kind: "callValue", callee: closureOf(fnName), args: [], type: VOID, loc });
const failure: IrStmt = { kind: "throw", value, loc };

test("propagates through a long caller-first chain without recursive graph traversal", () => {
  const size = 6000;
  const functions = Array.from({ length: size }, (_, i) =>
    fn(`fn${i}`, [i === size - 1 ? failure : call(`fn${i + 1}`)], []),
  );
  for (const order of [functions, [...functions].reverse()]) {
    const answer = computeMayThrow(moduleWith(...order));
    expect(answer.indirect).toBe(false);
    expect(answer.fns).toEqual(new Set(functions.map((f) => f.name)));
  }
});

test("recursive components only throw when they reach a throwing seed", () => {
  const mod = moduleWith(
    fn("caller", [call("left"), call("left")], []),
    fn("left", [call("right")], []),
    fn("right", [call("left")], []),
    fn("pure", [call("pure")], []),
  );
  expect(computeMayThrow(mod).fns.size).toBe(0);
  mod.functions[2]!.body.push(failure);
  expect(computeMayThrow(mod).fns).toEqual(new Set(["caller", "left", "right"]));
});

test("a transitively throwing closure activates indirect callers and their callers", () => {
  const mod = moduleWith(
    fn("outer", [call("indirect")], []),
    fn("indirect", [callClosure("wrapper")], []),
    fn("wrapper", [call("target")], []),
    fn("target", [failure], []),
    fn("otherIndirect", [callClosure("pure")], []),
    fn("pure", [], []),
  );
  const before = structuredClone(mod);
  const answer = computeMayThrow(mod);
  expect(answer.indirect).toBe(true);
  expect(answer.fns).toEqual(new Set(["outer", "indirect", "wrapper", "target", "otherIndirect"]));
  expect(mod).toEqual(before);
  mod.functions[3]!.body = [];
  expect(computeMayThrow(mod)).toEqual({ fns: new Set(), indirect: false });
  expect(answer.fns.size).toBe(5);
});

test.each(["async", "generator", "async generator"])(
  "a throwing %s body does not unwind direct or indirect callers",
  (kind) => {
    const target = fn("target", [failure], []);
    if (kind.includes("async")) target.async = true;
    if (kind.includes("generator"))
      target.generator = {
        yieldT: F64,
        nextT: VOID,
        resultType: { kind: "record", shapeId: "result" },
      };
    const mod = moduleWith(fn("caller", [call("target"), callClosure("target")], []), target);
    expect(computeMayThrow(mod)).toEqual({ fns: new Set(["target"]), indirect: false });
  },
);

test("dynamic function adapters activate indirect calls without an IR closure target", () => {
  const adapter: IrExpr = {
    kind: "dynCheck",
    value: { kind: "varRef", localId: "unknown", type: DYN, loc },
    type: funcOf([], VOID),
    loc,
  };
  const callee: IrExpr = { kind: "varRef", localId: "callback", type: funcOf([], VOID), loc };
  const mod = moduleWith(
    fn("caller", [call("indirect")], []),
    fn("indirect", [exprStmt({ kind: "callValue", callee, args: [], type: VOID, loc })], []),
    fn("adapter", [exprStmt(adapter)], []),
  );
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set(["caller", "indirect", "adapter"]),
    indirect: true,
  });
});

const construct = (className: string, direct = false): IrStmt =>
  exprStmt(
    direct
      ? { kind: "new", className, args: [], type: { kind: "object", className }, loc }
      : {
          kind: "newValue",
          callee: { kind: "classRef", className, type: { kind: "classval", className }, loc },
          args: [],
          type: { kind: "object", className },
          loc,
        },
  );

test("class-value construction includes descendants without making direct or sibling construction throw", () => {
  const mod = moduleWith(
    fn("caller", [call("rootValue")], []),
    ...["Root", "Middle", "Leaf", "Sibling", "Other"].flatMap((name) => [
      fn(`${name.toLowerCase()}Value`, [construct(name), construct(name)], []),
      fn(`${name.toLowerCase()}Direct`, [construct(name, true)], []),
      fn(`%${name}.constructor`, name === "Leaf" || name === "Other" ? [call("failure")] : [], []),
    ]),
    fn("failure", [failure], []),
  );
  mod.classes = [
    { name: "Leaf", base: "Middle", fields: [], loc },
    { name: "Sibling", base: "Root", fields: [], loc },
    { name: "Middle", base: "Root", fields: [], loc },
    { name: "Other", fields: [], loc },
    { name: "Root", fields: [], loc },
  ];
  const before = structuredClone(mod);
  const expected = new Set([
    "failure",
    "%Leaf.constructor",
    "%Other.constructor",
    "caller",
    "rootValue",
    "middleValue",
    "leafValue",
    "leafDirect",
    "otherValue",
    "otherDirect",
  ]);
  expect(computeMayThrow(mod)).toEqual({ fns: expected, indirect: false });
  expect(mod).toEqual(before);
  mod.classes.reverse();
  mod.functions.reverse();
  expect(computeMayThrow(mod)).toEqual({ fns: expected, indirect: false });
  mod.functions.find((f) => f.name === "%Leaf.constructor")!.body = [];
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set(["failure", "%Other.constructor", "otherValue", "otherDirect"]),
    indirect: false,
  });
});

test("class-value dependencies participate in the call graph fixpoint", () => {
  const mod = moduleWith(
    fn("caller", [construct("Root")], []),
    fn("direct", [construct("Root", true)], []),
    fn("%Root.constructor", [], []),
    fn("%Child.constructor", [construct("Other")], []),
    fn("%Other.constructor", [construct("Root")], []),
    fn("%OtherChild.constructor", [call("failure")], []),
    fn("failure", [failure], []),
  );
  mod.classes = [
    { name: "Root", fields: [], loc },
    { name: "Child", base: "Root", fields: [], loc },
    { name: "Other", fields: [], loc },
    { name: "OtherChild", base: "Other", fields: [], loc },
  ];
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set([
      "failure",
      "%OtherChild.constructor",
      "%Child.constructor",
      "%Other.constructor",
      "caller",
    ]),
    indirect: false,
  });
  mod.functions.find((f) => f.name === "failure")!.body = [];
  expect(computeMayThrow(mod)).toEqual({ fns: new Set(), indirect: false });
});

test("propagates construction through a deep hierarchy without descendant expansion or recursive traversal", () => {
  const size = 6000;
  const mod = moduleWith(
    ...Array.from({ length: size }, (_, i) => fn(`factory${i}`, [construct(`C${i}`)], [])),
    fn(`%C${size - 1}.constructor`, [failure], []),
  );
  mod.classes = Array.from({ length: size }, (_, i) => ({
    name: `C${i}`,
    ...(i > 0 ? { base: `C${i - 1}` } : {}),
    fields: [],
    loc,
  })).reverse();
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set(mod.functions.map((f) => f.name)),
    indirect: false,
  });
});

test("generic collection mutation propagates checked storage failures to callers", () => {
  const mapType = { kind: "map" as const, key: DYN, value: DYN };
  const setType = { kind: "set" as const, elem: DYN };
  const map: IrExpr = { kind: "varRef", localId: "map", type: mapType, loc };
  const set: IrExpr = { kind: "varRef", localId: "set", type: setType, loc };
  const input: IrExpr = { kind: "varRef", localId: "input", type: DYN, loc };
  const write: IrExpr = {
    kind: "mapIntrinsic",
    method: "set",
    receiver: map,
    args: [input, input],
    type: VOID,
    loc,
  };
  const add: IrExpr = {
    kind: "setIntrinsic",
    method: "add",
    receiver: set,
    args: [input],
    type: VOID,
    loc,
  };
  const caller = fn(
    "caller",
    [exprStmt({ kind: "call", callee: "write", args: [], type: VOID, loc })],
    [],
  );
  expect(
    computeMayThrow(
      moduleWith(caller, fn("write", [exprStmt(write)], []), fn("add", [exprStmt(add)], [])),
    ).fns,
  ).toEqual(new Set(["caller", "write", "add"]));
});
