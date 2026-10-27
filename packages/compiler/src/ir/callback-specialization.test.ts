import { expect, test } from "vitest";
import { specializeCallbackCalls } from "./callback-specialization.js";
import { BOOL, F64, VOID, funcOf, type IrExpr, type IrFunction, type IrModule } from "./ir.js";
import { everyStmtList } from "./traverse.js";

const loc = { file: "callbacks.ts", start: 0, end: 0 };
const callback = funcOf([F64], BOOL);
const ref = (localId: string, type = callback): IrExpr => ({ kind: "varRef", localId, type, loc });
const closure = (fnName: string, captures: string[] = []): IrExpr => ({
  kind: "closure",
  fnName,
  captures,
  type: callback,
  loc,
});
const call = (callee: string, args: IrExpr[]): IrExpr => ({
  kind: "call",
  callee,
  args,
  type: BOOL,
  loc,
});
const one: IrExpr = { kind: "numLit", value: 1, type: F64, loc };

function predicate(name: string): IrFunction {
  return {
    name,
    params: [{ localId: "n", name: "n", type: F64 }],
    locals: [{ id: "n", name: "n", type: F64, mutable: true }],
    returnType: BOOL,
    body: [{ kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc }],
    loc,
  };
}
/** `consume(test)` calls `test(1)`; `main` calls it once per target. */
function fixture(targets: string[]): IrModule {
  const consumer: IrFunction = {
    name: "consume",
    sourceName: "consume",
    ownsPrototype: true,
    params: [{ localId: "test", name: "test", type: callback }],
    locals: [{ id: "test", name: "test", type: callback, mutable: true }],
    returnType: BOOL,
    body: [
      {
        kind: "return",
        value: { kind: "callValue", callee: ref("test"), args: [one], type: BOOL, loc },
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
    body: targets.map((target) => ({
      kind: "exprStmt" as const,
      expr: call("consume", [closure(target)]),
      loc,
    })),
    loc,
  };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [...new Set(targets)].map(predicate).concat([consumer, entry]),
  };
}
function calleesOf(fn: IrFunction | undefined): string[] {
  const out: string[] = [];
  everyStmtList(fn?.body ?? [], {
    stmt: () => true,
    expr: (expr) => {
      if (expr.kind === "call") out.push(expr.callee);
      if (expr.kind === "closure") out.push(`closure:${expr.fnName}`);
      return true;
    },
  });
  return out;
}
const named = (mod: IrModule, name: string) => mod.functions.find((fn) => fn.name === name);

test("each callback target gets its own copy and the unreachable original goes", () => {
  const mod = specializeCallbackCalls(fixture(["a", "b", "a"]));
  expect(calleesOf(named(mod, "main"))).toEqual([
    "consume.cb0",
    "closure:a",
    "consume.cb1",
    "closure:b",
    "consume.cb0",
    "closure:a",
  ]);
  expect(named(mod, "consume")).toBeUndefined();
  const copy = named(mod, "consume.cb0")!;
  expect(copy).toMatchObject({ sourceName: "consume", ownsPrototype: true });
  // Copies own their nodes: analyses key facts by node identity.
  expect(copy.body[0]).not.toBe(named(mod, "consume.cb1")!.body[0]);
  expect(copy.locals[0]).not.toBe(named(mod, "consume.cb1")!.locals[0]);
});

test("one target, rebound parameters and oversized bodies keep the module", () => {
  const single = fixture(["a", "a"]);
  expect(specializeCallbackCalls(single)).toBe(single);
  const rebound = fixture(["a", "b"]);
  named(rebound, "consume")!.body.unshift({
    kind: "assign",
    localId: "test",
    value: closure("a"),
    loc,
  });
  expect(specializeCallbackCalls(rebound)).toBe(rebound);
  const large = fixture(["a", "b"]);
  const body = named(large, "consume")!.body;
  for (let i = 0; i < 200; i++) body.unshift({ kind: "exprStmt", expr: one, loc });
  expect(specializeCallbackCalls(large)).toBe(large);
});

test("a function value or an unknown callback keeps the original next to the copies", () => {
  const valued = fixture(["a", "b"]);
  named(valued, "main")!.body.push({
    kind: "exprStmt",
    expr: { ...closure("consume"), type: funcOf([callback], BOOL) },
    loc,
  });
  const specialized = specializeCallbackCalls(valued);
  expect(named(specialized, "consume")).toBeDefined();
  expect(named(specialized, "consume.cb1")).toBeDefined();

  const unknown = fixture(["a"]);
  const entry = named(unknown, "main")!;
  entry.params = [{ localId: "p", name: "p", type: callback }];
  entry.locals = [{ id: "p", name: "p", type: callback, mutable: true }];
  entry.body.push({ kind: "exprStmt", expr: call("consume", [ref("p")]), loc });
  const mixed = specializeCallbackCalls(unknown);
  expect(calleesOf(named(mixed, "main"))).toEqual(["consume.cb0", "closure:a", "consume"]);
});

test("recursion forwarding the callback stays in its copy", () => {
  const mod = fixture(["a", "b"]);
  named(mod, "consume")!.body.unshift({
    kind: "exprStmt",
    expr: call("consume", [ref("test")]),
    loc,
  });
  const out = specializeCallbackCalls(mod);
  expect(calleesOf(named(out, "consume.cb0"))).toEqual(["consume.cb0"]);
  expect(calleesOf(named(out, "consume.cb1"))).toEqual(["consume.cb1"]);
  expect(named(out, "consume")).toBeUndefined();
});

test("closures over a specialized callback get copies; recursion never copies per level", () => {
  const mod = fixture(["a", "b"]);
  const consumer = named(mod, "consume")!;
  consumer.locals[0]!.boxed = true;
  const inner: IrFunction = {
    name: "%inner",
    params: [{ localId: "n", name: "n", type: F64 }],
    captures: [{ localId: "c", name: "c", type: callback }],
    locals: [
      { id: "n", name: "n", type: F64, mutable: true },
      { id: "c", name: "c", type: callback, mutable: true, boxed: true },
    ],
    returnType: BOOL,
    body: [
      {
        kind: "return",
        value: { kind: "callValue", callee: ref("c"), args: [ref("n", F64)], type: BOOL, loc },
        loc,
      },
    ],
    loc,
  };
  mod.functions.push(inner);
  // consume(test) also recurses with `(n) => test(n)`.
  consumer.body.unshift({
    kind: "exprStmt",
    expr: call("consume", [closure("%inner", ["test"])]),
    loc,
  });
  const out = specializeCallbackCalls(mod);
  const forA = calleesOf(named(out, "main"))[0]!;
  const [recursion, made] = calleesOf(named(out, forA));
  // The original handles the recursion's new closures.
  expect(recursion).toBe("consume");
  expect(named(out, "consume")).toBeDefined();
  expect(made).toMatch(/^closure:%inner\.cb\d$/);
  const innerCopy = named(out, made!.slice("closure:".length))!;
  expect(innerCopy.captures).toEqual(inner.captures);
  expect(innerCopy.captures).not.toBe(inner.captures);
});

test("copies stay within the per-function budget", () => {
  const targets = Array.from({ length: 10 }, (_, i) => `t${i}`);
  const out = specializeCallbackCalls(fixture(targets));
  const callees = calleesOf(named(out, "main")).filter((name) => !name.startsWith("closure:"));
  expect(callees.filter((name) => name.startsWith("consume.cb"))).toHaveLength(4);
  expect(callees.slice(4)).toEqual(Array(6).fill("consume"));
});

test("function-keyed contracts extend to the copies", () => {
  const mod = fixture(["a", "b"]);
  mod.contracts = { noThrow: ["consume"], int32Locals: ["consume\0test", "main\0x"] };
  const out = specializeCallbackCalls(mod);
  expect(out.contracts?.noThrow).toEqual(["consume", "consume.cb0", "consume.cb1"]);
  expect(out.contracts?.int32Locals).toEqual([
    "consume\0test",
    "main\0x",
    "consume.cb0\0test",
    "consume.cb1\0test",
  ]);
});
