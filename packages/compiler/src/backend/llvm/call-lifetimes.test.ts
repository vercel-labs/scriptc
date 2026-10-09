import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  UNDEFINED_T,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";

const loc = { file: "lifetimes.ts", start: 0, end: 0 };
const record: IrType = { kind: "record", shapeId: "cell" };
const optional: IrType = { kind: "union", unionId: "optional" };
const ref = (localId: string, type: IrType = optional): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const num = (value = 1): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
const local = (id: string, type: IrType = optional): IrLocal => ({
  id,
  name: id,
  type,
  mutable: false,
});
const tag = (id: string): IrExpr => ({
  kind: "unionIsTag",
  value: ref(id),
  unionId: "optional",
  tag: 0,
  negated: false,
  type: BOOL,
  loc,
});
const narrow = (id: string): IrExpr => ({
  kind: "unionNarrow",
  value: ref(id),
  unionId: "optional",
  tag: 0,
  type: record,
  loc,
});
const call = (callee: string, args: IrExpr[]): IrExpr => ({
  kind: "call",
  callee,
  args,
  type: F64,
  loc,
});

function helper(name: string, ids = ["value"]): IrFunction {
  return {
    name,
    loc,
    returnType: F64,
    params: ids.map((id) => ({ localId: id, name: id, type: optional })),
    locals: ids.map((id) => local(id)),
    body: ids.map((id) => ({ kind: "exprStmt", expr: tag(id), loc })),
  };
}

function analyze(...functions: IrFunction[]) {
  return analyzeCallLifetimes(new Map(functions.map((fn) => [fn.name, fn])));
}

test("tracks the lifetime of the box separately from an escaping payload", () => {
  const fn = helper("extract");
  fn.returnType = record;
  fn.body = [ret(narrow("value"))];
  expect(analyze(fn).parameters.get(fn.name)).toEqual(new Set([0]));
  fn.returnType = optional;
  fn.body = [ret(ref("value"))];
  expect(analyze(fn).parameters.has(fn.name)).toBe(false);
});

test("class and record field reads borrow their root", () => {
  const cls: IrType = { kind: "object", className: "Cell" };
  const fn = helper("read", ["left", "right"]);
  fn.params[0]!.type = fn.locals[0]!.type = record;
  fn.params[1]!.type = fn.locals[1]!.type = cls;
  fn.body = [
    ret({
      kind: "bin",
      op: "+",
      type: F64,
      loc,
      left: {
        kind: "recordGet",
        obj: ref("left", record),
        shapeId: "cell",
        field: "x",
        type: F64,
        loc,
      },
      right: {
        kind: "fieldGet",
        obj: ref("right", cls),
        className: "Cell",
        field: "x",
        type: F64,
        loc,
      },
    }),
  ];
  expect(analyze(fn).parameters.get(fn.name)).toEqual(new Set([0, 1]));
});

test("keeps independent parameter facts through argument permutations", () => {
  const leaf = helper("leaf", ["kept", "escaped"]);
  leaf.body.push(ret(ref("escaped")));
  const middle = helper("middle", ["first", "second"]);
  middle.body = [ret(call("leaf", [ref("second"), ref("first")]))];
  const outer = helper("outer", ["a", "b"]);
  outer.body = [ret(call("middle", [ref("b"), ref("a")]))];
  const result = analyze(outer, middle, leaf);
  expect(result.parameters.get("leaf")).toEqual(new Set([0]));
  expect(result.parameters.get("middle")).toEqual(new Set([1]));
  expect(result.parameters.get("outer")).toEqual(new Set([0]));
});

test("joins every use of a parameter, including repeated call arguments", () => {
  const leaf = helper("leaf", ["a", "b"]);
  leaf.body.push(ret(ref("b")));
  const outer = helper("outer");
  outer.body = [ret(call("leaf", [ref("value"), ref("value")]))];
  expect(analyze(outer, leaf).parameters.has("outer")).toBe(false);
});

test("solves safe recursive groups and propagates a single escape around a cycle", () => {
  const left = helper("left"),
    right = helper("right");
  left.body.push(ret(call("right", [ref("value")])));
  right.body.push(ret(call("left", [ref("value")])));
  expect(analyze(left, right).parameters.size).toBe(2);
  right.body.push(ret(ref("value")));
  expect(analyze(left, right).parameters.size).toBe(0);
});

test("does not confuse the same local id in unrelated functions", () => {
  const safe = helper("safe"),
    unsafe = helper("unsafe");
  unsafe.body.push(ret(ref("value")));
  expect(analyze(safe, unsafe).parameters.get("safe")).toEqual(new Set([0]));
  expect(analyze(safe, unsafe).parameters.has("unsafe")).toBe(false);
});

test.each(["absent", "missing parameter", "async", "generator", "capture", "class capture"])(
  "refuses forwarding to a %s target",
  (reason) => {
    const outer = helper("outer"),
      leaf = helper("leaf");
    outer.body = [ret(call("leaf", [ref("value")]))];
    if (reason === "missing parameter") leaf.params = [];
    if (reason === "async") leaf.async = true;
    if (reason === "generator")
      leaf.generator = {
        yieldT: F64,
        nextT: F64,
        resultType: { kind: "record", shapeId: "result" },
      };
    if (reason === "capture") leaf.captures = [];
    if (reason === "class capture") leaf.classCaptures = [];
    const result = reason === "absent" ? analyze(outer) : analyze(outer, leaf);
    expect(result.parameters.has("outer")).toBe(false);
  },
);

test.each(["boxed", "tdz", "redeclared", "assign", "assign expression", "increment"])(
  "rejects a %s binding even when reads are projections",
  (reason) => {
    const fn = helper("read");
    if (reason === "boxed") fn.locals[0]!.boxed = true;
    if (reason === "tdz") fn.locals[0]!.tdz = true;
    if (reason === "redeclared")
      fn.body.push({ kind: "varDecl", localId: "value", init: null, loc });
    if (reason === "assign")
      fn.body.push({ kind: "assign", localId: "value", value: ref("value"), loc });
    if (reason === "assign expression")
      fn.body.push(
        ret({ kind: "assignExpr", localId: "value", value: ref("value"), type: optional, loc }),
      );
    if (reason === "increment")
      fn.body.push(
        ret({ kind: "incDec", localId: "value", op: "+", prefix: true, type: F64, loc }),
      );
    expect(analyze(fn).parameters.size).toBe(0);
  },
);

test("proves unassigned source parameters despite their writable declaration", () => {
  const fn = helper("read");
  fn.locals[0]!.mutable = true;
  expect(analyze(fn).parameters.get("read")).toEqual(new Set([0]));
  fn.body.push({ kind: "assign", localId: "value", value: ref("value"), loc });
  expect(analyze(fn).parameters.size).toBe(0);
});

test("rejects metadata captures that are not expression children", () => {
  for (const kind of ["closure", "classRef"] as const) {
    const fn = helper("read");
    const expr: IrExpr =
      kind === "closure"
        ? { kind, fnName: "captured", captures: ["value"], type: funcOf([], F64), loc }
        : {
            kind,
            className: "Captured",
            captures: ["value"],
            type: { kind: "classval", className: "Captured" },
            loc,
          };
    fn.body.push({ kind: "exprStmt", expr, loc });
    expect(analyze(fn).parameters.size).toBe(0);
  }
});

test("unknown indirect and runtime consumers cannot receive stack boxes", () => {
  const consumers: IrExpr[] = [
    {
      kind: "callValue",
      callee: ref("cb", funcOf([optional], F64)),
      args: [ref("value")],
      type: F64,
      loc,
    },
    { kind: "unionWrap", value: ref("value"), unionId: "nested", tag: 0, type: optional, loc },
    {
      kind: "recordLit",
      fields: [{ name: "value", value: ref("value") }],
      type: { kind: "record", shapeId: "holder" },
      loc,
    },
  ];
  for (const expr of consumers) {
    const fn = helper("read");
    fn.body.push(ret(expr));
    expect(analyze(fn).parameters.size).toBe(0);
  }
});

test("a local alias is an owned use, while scalar control flow does not escape", () => {
  const fn = helper("read");
  fn.body = [{ kind: "if", cond: tag("value"), then: [ret(num())], else_: [ret(num(2))], loc }];
  expect(analyze(fn).parameters.size).toBe(1);
  fn.locals.push(local("alias"));
  fn.body.unshift({ kind: "varDecl", localId: "alias", init: ref("value"), loc });
  expect(analyze(fn).parameters.size).toBe(0);
});

test("records safe local consumers without accepting duplicate or absent declarations", () => {
  const fn = helper("work", []),
    leaf = helper("leaf");
  fn.locals.push(local("item"));
  const init: IrExpr = {
    kind: "unionWrap",
    unionId: "optional",
    tag: 1,
    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
    type: optional,
    loc,
  };
  const declaration: IrStmt = { kind: "varDecl", localId: "item", init, loc };
  fn.body = [declaration, ret(call("leaf", [ref("item")]))];
  expect(analyze(fn, leaf).locals.get("work")).toEqual(new Set(["item"]));
  fn.body.push(declaration);
  expect(analyze(fn, leaf).locals.get("work")?.size).toBe(0);
  fn.body = [ret(call("leaf", [ref("item")]))];
  expect(analyze(fn, leaf).locals.get("work")?.size).toBe(0);
});

test("closure locals get local facts while their parameters stay unproven", () => {
  const fn = helper("closure");
  fn.captures = [];
  fn.locals.push(local("item"));
  fn.body = [
    { kind: "varDecl", localId: "item", init: ref("value"), loc },
    { kind: "exprStmt", expr: tag("item"), loc },
  ];
  const result = analyze(fn);
  expect(result.parameters.has("closure")).toBe(false);
  expect(result.borrowed.has("closure")).toBe(false);
  expect(result.locals.get("closure")).toEqual(new Set(["item"]));
  // A captured local is never a stack candidate inside the closure body.
  fn.captures = [{ localId: "item", name: "item", type: optional }];
  expect(analyze(fn).locals.get("closure")?.has("item")).toBe(false);
});

test("strict union equality and narrowed nullish reads are projections", () => {
  const fn = helper("compare");
  const equal: IrExpr = {
    kind: "unionEq",
    unionId: "optional",
    negated: false,
    sameValue: false,
    left: ref("value"),
    right: ref("value"),
    type: BOOL,
    loc,
  };
  fn.body = [{ kind: "exprStmt", expr: equal, loc }];
  expect(analyze(fn).parameters.get("compare")).toEqual(new Set([0]));
  const narrowed: IrExpr = { kind: "nullish", left: ref("value"), right: num(), type: F64, loc };
  fn.body = [ret(narrowed)];
  expect(analyze(fn).parameters.get("compare")).toEqual(new Set([0]));
  // The pass-through shape returns the box itself.
  fn.returnType = optional;
  fn.body = [
    ret({ kind: "nullish", left: ref("value"), right: ref("value"), type: optional, loc }),
  ];
  expect(analyze(fn).parameters.has("compare")).toBe(false);
});

test("visits nested argument effects even when the outer helper is safe", () => {
  const fn = helper("work"),
    leaf = helper("leaf");
  const nested: IrExpr = {
    kind: "seqExpr",
    stmts: [ret(ref("value"))],
    result: num(),
    type: F64,
    loc,
  };
  fn.body.push(ret(call("leaf", [nested])));
  expect(analyze(fn, leaf).parameters.has("work")).toBe(false);
});

test("unused parameters are borrowed but scalar values never change ABI", () => {
  const fn = helper("unused", ["value", "count"]);
  fn.params[1]!.type = fn.locals[1]!.type = F64;
  fn.body = [ret(num())];
  expect(analyze(fn).parameters.get(fn.name)).toEqual(new Set([0]));
});

test("a late unsafe leaf invalidates a deep chain without recursive graph traversal", () => {
  const functions: IrFunction[] = [];
  for (let i = 0; i < 12000; i++) {
    const fn = helper(`f${i}`);
    fn.body = [ret(call(`f${i + 1}`, [ref("value")]))];
    functions.push(fn);
  }
  const leaf = helper("f12000");
  expect(analyze(...functions, leaf).parameters.size).toBe(12001);
  leaf.body.push(ret(ref("value")));
  expect(analyze(...functions, leaf).parameters.size).toBe(0);
});

test("joins a wide graph without tying safe siblings to escaping parameters", () => {
  const leaf = helper("leaf", ["safe", "escaped"]);
  leaf.body.push(ret(ref("escaped")));
  const callers = Array.from({ length: 1000 }, (_, i) => {
    const fn = helper(`caller${i}`, ["a", "b"]);
    fn.body = [ret(call("leaf", [ref("a"), ref("b")]))];
    return fn;
  });
  const result = analyze(leaf, ...callers);
  for (const fn of callers) expect(result.parameters.get(fn.name)).toEqual(new Set([0]));
});

test("analysis does not mutate IR or carry stale facts across emissions", () => {
  const fn = helper("work");
  const before = JSON.stringify(fn);
  const first = analyze(fn);
  expect(JSON.stringify(fn)).toBe(before);
  fn.body.push(ret(ref("value")));
  expect(analyze(fn).parameters.size).toBe(0);
  expect(first.parameters.get("work")).toEqual(new Set([0]));
});

test("heap inputs may escape while projection-only facts remain restrictive", () => {
  const fn = helper("identity");
  fn.returnType = optional;
  fn.body = [ret(ref("value"))];
  const facts = analyze(fn);
  expect(facts.borrowed.get(fn.name)).toEqual(new Set([0]));
  expect(facts.parameters.has(fn.name)).toBe(false);
});

test("borrows unchanged collection and callback parameters without a callee effect proof", () => {
  const types: IrType[] = [
    { kind: "array", elem: record },
    { kind: "map", key: F64, value: record },
    { kind: "set", elem: record },
    { kind: "bytes", elem: "u8" },
    funcOf([record], record),
  ];
  for (const type of types) {
    const fn = helper("forward");
    fn.params[0]!.type = fn.locals[0]!.type = type;
    fn.returnType = type;
    fn.body = [ret({ kind: "call", callee: "unknown", args: [ref("value", type)], type, loc })];
    expect(analyze(fn).borrowed.get(fn.name)).toEqual(new Set([0]));
    expect(analyze(fn).parameters.has(fn.name)).toBe(false);
  }
});

test("heap borrowing keeps a boxed parameter that nothing rebinds", () => {
  const fn = helper("identity");
  fn.body = [ret(ref("value"))];
  fn.locals[0]!.boxed = true;
  expect(analyze(fn).borrowed.get(fn.name)).toEqual(new Set([0]));
  fn.body.unshift({ kind: "assign", localId: "value", value: ref("value"), loc });
  expect(analyze(fn).borrowed.size).toBe(0);
});

test.each([
  "tdz",
  "capture",
  "class capture",
  "assign",
  "assign expression",
  "redeclare",
  "catch",
  "loop binding",
])("heap borrowing excludes a %s parameter", (reason) => {
  const fn = helper("identity");
  fn.body = [ret(ref("value"))];
  if (reason === "tdz") fn.locals[0]!.tdz = true;
  if (reason === "capture" || reason === "class capture")
    fn.body.unshift({
      kind: "exprStmt",
      loc,
      expr:
        reason === "capture"
          ? { kind: "closure", fnName: "callback", captures: ["value"], type: funcOf([], F64), loc }
          : {
              kind: "classRef",
              className: "Local",
              captures: ["value"],
              type: { kind: "classval", className: "Local" },
              loc,
            },
    });
  if (reason === "assign")
    fn.body.unshift({ kind: "assign", localId: "value", value: ref("value"), loc });
  if (reason === "assign expression")
    fn.body.unshift({
      kind: "exprStmt",
      loc,
      expr: { kind: "assignExpr", localId: "value", value: ref("value"), type: optional, loc },
    });
  if (reason === "redeclare")
    fn.body.unshift({ kind: "varDecl", localId: "value", init: ref("value"), loc });
  if (reason === "catch")
    fn.body.unshift({
      kind: "tryCatch",
      tryBody: [],
      catchLocalId: "value",
      catchBody: [],
      finallyBody: [],
      loc,
    });
  if (reason === "loop binding")
    fn.body.unshift({
      kind: "forOf",
      localId: "value",
      iterable: ref("items", { kind: "array", elem: optional }),
      body: [],
      loc,
    });
  expect(analyze(fn).borrowed.size).toBe(0);
});

test("unchanged let bindings can own call inputs but subsequent writes and captures invalidate them", () => {
  const fn = helper("work", []);
  fn.locals = [{ ...local("value"), mutable: true }];
  fn.body = [{ kind: "varDecl", localId: "value", init: ref("outside"), loc }, ret(ref("value"))];
  expect(analyze(fn).bindings.get(fn.name)).toEqual(new Set(["value"]));
  fn.body.unshift({
    kind: "if",
    cond: { kind: "boolLit", value: false, type: BOOL, loc },
    then: [{ kind: "assign", localId: "value", value: ref("outside"), loc }],
    else_: [],
    loc,
  });
  expect(analyze(fn).bindings.get(fn.name)?.size).toBe(0);
});

test("strict union equality projects both operands without escaping either box", () => {
  const equal = (left: IrExpr, right: IrExpr): IrExpr => ({
    kind: "unionEq",
    unionId: "optional",
    negated: false,
    sameValue: false,
    left,
    right,
    type: BOOL,
    loc,
  });
  const fn = helper("same", ["value", "other"]);
  fn.body = [ret(equal(ref("value"), ref("other")))];
  expect(analyze(fn).parameters.get("same")).toEqual(new Set([0, 1]));
  // A nested consumer inside an operand is still visited.
  fn.body = [ret(equal(ref("value"), call("escape", [ref("other")])))];
  expect(analyze(fn).parameters.get("same")).toEqual(new Set([0]));
});

test("environment bodies prove their own locals but never their parameters", () => {
  const leaf = helper("leaf");
  const fn = helper("lifted");
  fn.captures = [{ localId: "box", name: "box", type: optional }];
  fn.locals.push({ ...local("box"), boxed: true }, local("item"));
  fn.body = [
    {
      kind: "varDecl",
      localId: "item",
      init: { kind: "unionWrap", value: num(), unionId: "optional", tag: 0, type: optional, loc },
      loc,
    },
    ret(call("leaf", [ref("item")])),
    ret(call("leaf", [ref("box")])),
    ret(call("leaf", [ref("value")])),
  ];
  const facts = analyze(fn, leaf);
  expect(facts.locals.get("lifted")).toEqual(new Set(["item"]));
  expect(facts.bindings.get("lifted")).toEqual(new Set(["item"]));
  expect(facts.parameters.has("lifted")).toBe(false);
  expect(facts.borrowed.has("lifted")).toBe(false);
  fn.async = true;
  expect(analyze(fn, leaf).locals.has("lifted")).toBe(false);
});

test("strict union equality is a borrowing use of a local operand", () => {
  const fn = helper("same", ["left", "right"]);
  fn.returnType = BOOL;
  fn.body = [
    ret({
      kind: "unionEq",
      unionId: "optional",
      negated: false,
      sameValue: false,
      left: ref("left"),
      right: ref("right"),
      type: BOOL,
      loc,
    }),
  ];
  expect(analyze(fn).parameters.get("same")).toEqual(new Set([0, 1]));
  fn.body = [
    ret({
      kind: "unionEq",
      unionId: "optional",
      negated: false,
      sameValue: false,
      left: ref("left"),
      right: {
        kind: "unionWrap",
        value: ref("right"),
        unionId: "nested",
        tag: 0,
        type: optional,
        loc,
      },
      type: BOOL,
      loc,
    }),
  ];
  expect(analyze(fn).parameters.get("same")).toEqual(new Set([0]));
});

test("closure bodies get local facts but never parameter facts", () => {
  const fn = helper("closure");
  fn.captures = [];
  fn.locals.push(local("item"));
  fn.body = [
    { kind: "varDecl", localId: "item", init: ref("value"), loc },
    { kind: "exprStmt", expr: tag("item"), loc },
  ];
  const result = analyze(fn);
  expect(result.parameters.has("closure")).toBe(false);
  expect(result.borrowed.has("closure")).toBe(false);
  expect(result.locals.get("closure")).toEqual(new Set(["item"]));
  expect(result.projectedLocals.get("closure")).toEqual(new Set(["item"]));
  expect(result.bindings.get("closure")).toEqual(new Set(["item"]));
  fn.locals[0]!.boxed = true;
  fn.body.push({ kind: "exprStmt", expr: tag("value"), loc });
  expect(analyze(fn).locals.get("closure")).toEqual(new Set(["item"]));
});

test("stores into nullable-pointer class fields project the stored union", () => {
  const self: IrType = { kind: "object", className: "Node" };
  const store = (className: string, field: string, value: IrExpr): IrStmt => ({
    kind: "fieldSet",
    obj: ref("this", self),
    className,
    field,
    value,
    loc,
  });
  const fn: IrFunction = {
    name: "%Node.constructor",
    loc,
    returnType: { kind: "void" },
    params: [
      { localId: "this", name: "this", type: self },
      { localId: "value", name: "value", type: optional },
    ],
    locals: [local("this", self), local("value")],
    body: [store("Node", "next", ref("value"))],
  };
  const nullable = (className: string, field: string): boolean =>
    className === "Node" && field === "next";
  const functions = new Map([[fn.name, fn]]);
  // Ordinary union fields store (retain) the box itself.
  expect(analyzeCallLifetimes(functions).parameters.get(fn.name)?.has(1)).toBeFalsy();
  expect(analyzeCallLifetimes(functions, nullable).parameters.get(fn.name)).toEqual(new Set([1]));
  // Another field of the same class keeps ordinary storage.
  fn.body = [store("Node", "other", ref("value"))];
  expect(analyzeCallLifetimes(functions, nullable).parameters.get(fn.name)?.has(1)).toBeFalsy();
  // The receiver is still an ordinary use, and a second escape still rejects.
  fn.body = [store("Node", "next", ref("value")), ret(ref("value"))];
  expect(analyzeCallLifetimes(functions, nullable).parameters.get(fn.name)?.has(1)).toBeFalsy();
});
