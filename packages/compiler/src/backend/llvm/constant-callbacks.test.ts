import { expect, test } from "vitest";
import {
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  STRING,
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
    irVersion: 17,
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
test.each(["sync", "async"])(
  "a %s generator's unchanged callback parameter specializes through its spawn calls",
  (kind) => {
    const mod = fixture();
    const consumer = mod.functions[1]!;
    delete consumer.ownsPrototype;
    consumer.generator = {
      yieldT: BOOL,
      nextT: VOID,
      resultType: { kind: "record", shapeId: "r0" },
    };
    if (kind === "async") consumer.async = true;
    expect(analyzeCallLifetimes(new Map(mod.functions.map((fn) => [fn.name, fn])))).toMatchObject({
      generatorParameters: new Map([["consume", new Set(["test"])]]),
    });
    expect(facts(mod).get("consume")?.get("test")).toBe("predicate");
    // A rebound or captured parameter is no stable owner.
    consumer.body.unshift({ kind: "assign", localId: "test", value: closure("predicate"), loc });
    expect(facts(mod).get("consume")?.has("test")).not.toBe(true);
    consumer.body.shift();
    consumer.locals[0]!.boxed = true;
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
test("recursion that forwards the unchanged callback agrees with the outer calls", () => {
  const mod = fixture();
  const consumer = mod.functions[1]!;
  const recurse: IrStmt = {
    kind: "exprStmt",
    expr: { kind: "call", callee: "consume", args: [ref("test")], type: BOOL, loc },
    loc,
  };
  consumer.body.unshift(recurse);
  expect(facts(mod).get("consume")?.get("test")).toBe("predicate");
  // Forwarding another function's callback is an ordinary incoming call.
  consumer.body[0] = {
    kind: "exprStmt",
    expr: { kind: "call", callee: "consume", args: [closure("other")], type: BOOL, loc },
    loc,
  };
  mod.functions.push({ ...mod.functions[0]!, name: "other" });
  expect(facts(mod).get("consume")?.has("test")).not.toBe(true);
});
test("a callback forwarded through another consumer's parameter resolves", () => {
  const mod = fixture();
  const entry = mod.functions[2]!;
  const forward: IrFunction = {
    name: "forward",
    ownsPrototype: true,
    params: [{ localId: "f", name: "f", type: callback }],
    locals: [{ id: "f", name: "f", type: callback, mutable: true }],
    returnType: BOOL,
    body: [
      {
        kind: "return",
        value: { kind: "call", callee: "consume", args: [ref("f")], type: BOOL, loc },
        loc,
      },
    ],
    loc,
  };
  mod.functions.push(forward);
  entry.body = [
    {
      kind: "exprStmt",
      expr: { kind: "call", callee: "forward", args: [closure("predicate")], type: BOOL, loc },
      loc,
    },
  ];
  expect(facts(mod).get("consume")?.get("test")).toBe("predicate");
  // A forwarder that rebinds its parameter forwards an unknown value.
  forward.body.unshift({ kind: "assign", localId: "f", value: closure("other"), loc });
  mod.functions.push({ ...mod.functions[0]!, name: "other" });
  expect(facts(mod).get("consume")?.has("test")).not.toBe(true);
});
test("a closure capturing an unchanged callback parameter calls its target", () => {
  const mod = fixture();
  const consumer = mod.functions[1]!;
  const inner: IrFunction = {
    name: "%inner",
    params: [],
    captures: [{ localId: "c", name: "c", type: callback }],
    locals: [{ id: "c", name: "c", type: callback, mutable: true, boxed: true }],
    returnType: BOOL,
    body: [
      {
        kind: "return",
        value: {
          kind: "callValue",
          callee: ref("c"),
          args: [{ kind: "numLit", value: 2, type: F64, loc }],
          type: BOOL,
          loc,
        },
        loc,
      },
    ],
    loc,
  };
  mod.functions.push(inner);
  consumer.locals[0]!.boxed = true;
  consumer.body.unshift({
    kind: "exprStmt",
    expr: { kind: "closure", fnName: "%inner", captures: ["test"], type: funcOf([], BOOL), loc },
    loc,
  });
  expect(facts(mod).get("%inner")?.get("c")).toBe("predicate");
  // A write through the environment rebinds the shared binding.
  inner.body.unshift({ kind: "assign", localId: "c", value: closure("predicate"), loc });
  expect(facts(mod).get("%inner")?.has("c")).not.toBe(true);
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

test("receiver elision admits library work that runs no user code", () => {
  const str: IrExpr = { kind: "strLit", value: "a", type: STRING, loc };
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const dyn = ref("d", DYN);
  const ignores = (expr: IrExpr): boolean => {
    const fn = fixture().functions[0]!;
    fn.body.unshift({ kind: "exprStmt", expr, loc });
    return callbackIgnoresReceiver(fn);
  };
  const lib = (fn: string, args: IrExpr[]): IrExpr =>
    ({ kind: "libCall", fn, args, type: F64, loc }) as IrExpr;
  const intrinsic = (name: string, args: IrExpr[]): IrExpr =>
    ({ kind: "intrinsic", name, args, type: VOID, loc }) as IrExpr;
  // String and number members over primitives; a callback operand may run.
  expect(ignores(lib("string.lastIndexOfFrom", [str, str, num(0)]))).toBe(true);
  expect(ignores(lib("num.sameValue", [num(0), num(1)]))).toBe(true);
  expect(ignores(lib("string.lastIndexOf", [str, closure("predicate")]))).toBe(false);
  expect(ignores(lib("perf.now", []))).toBe(true);
  // `new Error(message, options)` with a primitive message and no options.
  const message: IrExpr = { kind: "dynFrom", value: str, type: DYN, loc };
  expect(ignores(lib("error.newOptions", [message, message]))).toBe(true);
  expect(ignores(lib("error.newOptions", [message, dyn]))).toBe(false);
  // The module binding check only throws; console output may inspect.
  const initialized: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
  expect(ignores(intrinsic("module.tdzCheck", [initialized, str]))).toBe(true);
  expect(ignores(intrinsic("console.log", [dyn]))).toBe(false);
  // A typed array built from nothing or a typed source; a dynamic source
  // may be an iterable.
  const bytes = (source: IrExpr | null): IrExpr => ({
    kind: "bytesNew",
    source,
    type: BYTES_U8,
    loc,
  });
  expect(ignores(bytes(null))).toBe(true);
  expect(ignores(bytes(dyn))).toBe(false);
});

test("receiver elision admits array for-of loops", () => {
  const fn = fixture().functions[0]!;
  const numbers = { kind: "array", elem: F64 } as const;
  const one: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
  fn.locals.push({ id: "x", name: "x", type: F64, mutable: false });
  fn.body.unshift({
    kind: "forOf",
    localId: "x",
    iterable: { kind: "arrayLit", elems: [one], type: numbers, loc },
    body: [],
    loc,
  });
  expect(callbackIgnoresReceiver(fn)).toBe(true);
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

test("signature adapters that only forward the receiver ignore it with their original", () => {
  const forward = (receiver: IrExpr): IrStmt => ({
    kind: "return",
    value: {
      kind: "callValue",
      callee: ref("f.0"),
      receiver,
      args: [{ kind: "varRef", localId: "a.0", type: F64, loc }],
      type: BOOL,
      loc,
    },
    loc,
  });
  const ambient: IrExpr = { kind: "libCall", fn: "dyn.this", args: [], type: { kind: "dyn" }, loc };
  const adapter: IrFunction = {
    name: "%fn.adapt.x.impl",
    params: [{ localId: "a.0", name: "a", type: F64 }],
    captures: [{ localId: "f.0", name: "f", type: callback }],
    locals: [
      { id: "f.0", name: "f", type: callback, mutable: false, boxed: true },
      { id: "a.0", name: "a", type: F64, mutable: false },
    ],
    returnType: BOOL,
    body: [forward(ambient)],
    loc,
  };
  const readers = (): AmbientReceiverReaders =>
    new AmbientReceiverReaders(new Map([[adapter.name, adapter]]));
  // The adapter itself reads the receiver, only to forward it.
  expect(readers().ignores(adapter)).toBe(false);
  expect(readers().forwardsOnly(adapter)).toBe(true);
  // Any other read of the receiver, or forwarding something else, does not.
  adapter.body = [thisRead, forward(ambient)];
  expect(readers().forwardsOnly(adapter)).toBe(false);
  adapter.body = [forward(ref("a.0", F64))];
  expect(readers().forwardsOnly(adapter)).toBe(false);
  adapter.body = [forward(ambient)];
  adapter.captures = [];
  expect(readers().forwardsOnly(adapter)).toBe(false);
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

test.each(["%arr.some.0", "%bytes.some.0"])(
  "synthetic array and typed-array HOF helpers are constant-callback consumers (%s)",
  (name) => {
    const mod = fixture();
    const consumer = mod.functions[1]!;
    const entry = mod.functions[2]!;
    delete consumer.ownsPrototype;
    consumer.name = name;
    const call = entry.body[0]!;
    if (call.kind === "exprStmt" && call.expr.kind === "call") call.expr.callee = name;
    expect(facts(mod).get(name)?.get("test")).toBe("predicate");
  },
);

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
