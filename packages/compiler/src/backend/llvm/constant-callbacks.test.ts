import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
} from "../../ir/ir.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";
import {
  AmbientReceiverReaders,
  callbackIgnoresReceiver,
  findConstantCallbacks,
} from "./constant-callbacks.js";

const loc = { file: "callbacks.ts", start: 0, end: 0 };
const callback = funcOf([F64], BOOL);
const ref = (localId: string, type = callback): IrExpr => ({ kind: "varRef", localId, type, loc });
const closure = (fnName: string): IrExpr => ({
  kind: "closure",
  fnName,
  captures: [],
  type: callback,
  loc,
});
function fixture(): IrModule {
  const predicate: IrFunction = {
    name: "predicate",
    params: [{ localId: "n", name: "n", type: F64 }],
    locals: [{ id: "n", name: "n", type: F64, mutable: true }],
    returnType: BOOL,
    body: [{ kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc }],
    loc,
  };
  const consumer: IrFunction = {
    name: "consume",
    ownsPrototype: true,
    params: [{ localId: "test", name: "test", type: callback }],
    locals: [{ id: "test", name: "test", type: callback, mutable: true }],
    returnType: BOOL,
    body: [
      {
        kind: "return",
        value: {
          kind: "callValue",
          callee: ref("test"),
          args: [{ kind: "numLit", value: 1, type: F64, loc }],
          type: BOOL,
          loc,
        },
        loc,
      },
    ],
    loc,
  };
  const entry: IrFunction = {
    name: "main",
    params: [],
    locals: [],
    returnType: VOID,
    body: [
      {
        kind: "exprStmt",
        expr: { kind: "call", callee: "consume", args: [closure("predicate")], type: BOOL, loc },
        loc,
      },
    ],
    loc,
  };
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    functions: [predicate, consumer, entry],
  };
}
function facts(mod: IrModule) {
  return findConstantCallbacks(
    mod,
    analyzeCallLifetimes(new Map(mod.functions.map((fn) => [fn.name, fn]))),
  );
}
test("a closed consumer with one target specializes its callback parameter", () => {
  expect(facts(fixture()).get("consume")?.get("test")).toBe("predicate");
});
test.each(["multiple", "escape", "write", "metadata", "suspend", "synthetic"])(
  "%s prevents incoming-call specialization",
  (reason) => {
    const mod = fixture();
    const consumer = mod.functions[1]!;
    const entry = mod.functions[2]!;
    if (reason === "multiple") {
      mod.functions.push({ ...mod.functions[0]!, name: "other" });
      entry.body.push({
        kind: "exprStmt",
        expr: { kind: "call", callee: "consume", args: [closure("other")], type: BOOL, loc },
        loc,
      });
    }
    if (reason === "escape")
      entry.body.push({
        kind: "exprStmt",
        expr: { ...closure("consume"), type: funcOf([callback], BOOL) },
        loc,
      });
    if (reason === "write")
      consumer.body.unshift({ kind: "assign", localId: "test", value: closure("predicate"), loc });
    if (reason === "metadata")
      mod.classes = [{ name: "Cell", fields: [], prototypeDataHelper: "consume", loc }];
    if (reason === "suspend") consumer.async = true;
    if (reason === "synthetic") delete consumer.ownsPrototype;
    expect(facts(mod).get("consume")?.has("test")).not.toBe(true);
  },
);
test("global closure aliases resolve without borrowing the caller's local namespace", () => {
  const mod = fixture();
  const entry = mod.functions[2]!;
  mod.globals = [{ id: "%g.callback", name: "callback", type: callback, mutable: false }];
  entry.locals = [{ id: "local", name: "local", type: callback, mutable: false }];
  entry.body.unshift(
    { kind: "varDecl", localId: "local", init: closure("predicate"), loc },
    { kind: "assign", localId: "%g.callback", value: ref("local"), loc },
  );
  const call = entry.body[2]!;
  if (call.kind === "exprStmt" && call.expr.kind === "call") call.expr.args = [ref("%g.callback")];
  expect(facts(mod).get("consume")?.has("test")).not.toBe(true);
  entry.body[1] = { kind: "assign", localId: "%g.callback", value: closure("predicate"), loc };
  expect(facts(mod).get("consume")?.get("test")).toBe("predicate");
  entry.body.push({ kind: "assign", localId: "%g.callback", value: closure("predicate"), loc });
  expect(facts(mod).get("consume")?.has("test")).not.toBe(true);
});
test("receiver elision admits only synchronous receiver-free work", () => {
  const fn = fixture().functions[0]!;
  expect(callbackIgnoresReceiver(fn)).toBe(true);
  // A fixed compile-fence throw cannot observe the receiver.
  fn.body.unshift({ kind: "runtimeFence", code: "SC2020", message: "refused", loc });
  expect(callbackIgnoresReceiver(fn)).toBe(true);
  fn.body[0] = {
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "dyn.this", args: [], type: { kind: "dyn" }, loc },
    loc,
  };
  expect(callbackIgnoresReceiver(fn)).toBe(false);
  fn.body.shift();
  fn.async = true;
  expect(callbackIgnoresReceiver(fn)).toBe(false);
});

function callsOf(name: string, callee: string, extra: IrStmt[] = []): IrFunction {
  return {
    name,
    params: [],
    locals: [],
    returnType: VOID,
    body: [
      ...extra,
      { kind: "exprStmt", expr: { kind: "call", callee, args: [], type: VOID, loc }, loc },
    ],
    loc,
  };
}
const thisRead: IrStmt = {
  kind: "exprStmt",
  expr: { kind: "libCall", fn: "dyn.this", args: [], type: { kind: "dyn" }, loc },
  loc,
};

test("receiver readers propagate backwards through direct calls and recursion", () => {
  const leaf = callsOf("leaf", "middle");
  const middle = callsOf("middle", "leaf");
  const functions = new Map([leaf, middle].map((fn) => [fn.name, fn]));
  // A cycle with no reader is receiver-free.
  expect(new AmbientReceiverReaders(functions).ignores(leaf)).toBe(true);
  middle.body.unshift(thisRead);
  const readers = new AmbientReceiverReaders(functions);
  expect(readers.ignores(leaf)).toBe(false);
  expect(readers.ignores(middle)).toBe(false);
  // Unknown callees and async callees count as readers.
  const unknown = callsOf("unknown", "missing");
  expect(callbackIgnoresReceiver(unknown)).toBe(false);
  const spawn = callsOf("spawn", "task");
  const task: IrFunction = { ...callsOf("task", "spawn"), body: [], async: true };
  expect(
    new AmbientReceiverReaders(new Map([spawn, task].map((fn) => [fn.name, fn]))).ignores(spawn),
  ).toBe(false);
});

test("virtual calls admit every same-named method", () => {
  const call: IrStmt = {
    kind: "exprStmt",
    expr: { kind: "virtualCall", className: "%A", method: "run", args: [], type: VOID, loc },
    loc,
  };
  const caller: IrFunction = { ...callsOf("caller", "x"), body: [call] };
  const a: IrFunction = { ...callsOf("%A.run", "x"), body: [] };
  const b: IrFunction = { ...callsOf("%B.run", "x"), body: [] };
  const functions = new Map([caller, a, b].map((fn) => [fn.name, fn]));
  expect(new AmbientReceiverReaders(functions).ignores(caller)).toBe(true);
  b.body = [thisRead];
  expect(new AmbientReceiverReaders(functions).ignores(caller)).toBe(false);
});

test("synthetic array HOF helpers are constant-callback consumers", () => {
  const mod = fixture();
  const consumer = mod.functions[1]!;
  const entry = mod.functions[2]!;
  delete consumer.ownsPrototype;
  consumer.name = "%arr.some.0";
  const call = entry.body[0]!;
  if (call.kind === "exprStmt" && call.expr.kind === "call") call.expr.callee = "%arr.some.0";
  expect(facts(mod).get("%arr.some.0")?.get("test")).toBe("predicate");
});

function factory(name: string, returns: IrExpr[]): IrFunction {
  return {
    name,
    params: [],
    locals: [],
    returnType: callback,
    body: returns.map((value) => ({
      kind: "if",
      cond: { kind: "boolLit", value: true, type: BOOL, loc },
      then: [{ kind: "return", value, loc }],
      else_: null,
      loc,
    })),
    loc,
  };
}

test("a factory returning one function resolves through its call", () => {
  const mod = fixture();
  const entry = mod.functions[2]!;
  mod.functions.push(factory("make", [closure("predicate")]));
  const call = entry.body[0]!;
  if (call.kind === "exprStmt" && call.expr.kind === "call")
    call.expr.args = [{ kind: "call", callee: "make", args: [], type: callback, loc }];
  expect(facts(mod).get("consume")?.get("test")).toBe("predicate");
  mod.functions.push({ ...mod.functions[0]!, name: "other" });
  mod.functions[3] = factory("make", [closure("predicate"), closure("other")]);
  expect(facts(mod).get("consume")?.has("test")).not.toBe(true);
});

test("an immutable capture resolves at its closure creation site", () => {
  const mod = fixture();
  const entry = mod.functions[2]!;
  const lambda: IrFunction = {
    name: "%lambda",
    params: [],
    captures: [{ localId: "cb", name: "cb", type: callback }],
    locals: [{ id: "cb", name: "cb", type: callback, mutable: false, boxed: true }],
    returnType: BOOL,
    body: [
      {
        kind: "return",
        value: {
          kind: "callValue",
          callee: ref("cb"),
          args: [{ kind: "numLit", value: 1, type: F64, loc }],
          type: BOOL,
          loc,
        },
        loc,
      },
    ],
    loc,
  };
  mod.functions.push(lambda);
  entry.locals = [{ id: "cb", name: "cb", type: callback, mutable: false, boxed: true }];
  entry.body.push(
    { kind: "varDecl", localId: "cb", init: closure("predicate"), loc },
    {
      kind: "exprStmt",
      expr: {
        kind: "closure",
        fnName: "%lambda",
        captures: ["cb"],
        type: funcOf([], BOOL),
        loc,
      },
      loc,
    },
  );
  expect(facts(mod).get("%lambda")?.get("cb")).toBe("predicate");
  entry.locals[0]!.mutable = true;
  lambda.locals[0]!.mutable = true;
  expect(facts(mod).get("%lambda")?.has("cb")).not.toBe(true);
});
