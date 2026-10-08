import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
} from "../../ir/ir.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";
import { callbackIgnoresReceiver, findConstantCallbacks } from "./constant-callbacks.js";

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
test("receiver elision admits only synchronous scalar work", () => {
  const fn = fixture().functions[0]!;
  expect(callbackIgnoresReceiver(fn)).toBe(true);
  fn.body.unshift({ kind: "runtimeFence", code: "SC2020", message: "refused", loc });
  expect(callbackIgnoresReceiver(fn)).toBe(false);
  fn.body.shift();
  fn.async = true;
  expect(callbackIgnoresReceiver(fn)).toBe(false);
});
