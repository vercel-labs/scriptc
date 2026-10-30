import { expect, test, vi } from "vitest";
import { F64, VOID, type IrFunction, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import * as traversal from "../../ir/traverse.js";
import { DeferredModuleInitializers } from "./deferred-module-initializers.js";
import type { Lowerer } from "./lowerer.js";

const loc: SrcLoc = { file: "registry.ts", start: 0, end: 1 };
const block = (where: SrcLoc): Extract<IrStmt, { kind: "block" }> => ({
  kind: "block",
  body: [],
  loc: where,
});
const read = (id: string): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "varRef", localId: id, type: F64, loc },
  loc,
});
const value = (n: number): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "numLit", value: n, type: F64, loc },
  loc,
});
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  name,
  body,
  params: [],
  locals: [],
  returnType: VOID,
  loc,
});

function fixture() {
  const initializers = new DeferredModuleInitializers();
  // Queue IR actions directly: syntax classification has separate corpus
  // coverage, while these cases exercise live worklist mutations.
  const pending = (
    initializers as unknown as { pending: Map<string, { loc: SrcLoc; lower: () => IrStmt[] }[]> }
  ).pending;
  const lowerer = {
    classes: new Map(),
    shapes: { get: () => undefined },
    unions: { get: () => undefined },
  } as unknown as Lowerer;
  return { initializers, pending, lowerer };
}

test("materializes many demanded registries without a whole-program scan per action", () => {
  const { initializers, pending, lowerer } = fixture();
  const placeholders: IrStmt[] = [],
    reads: IrStmt[] = [];
  for (let i = 0; i < 64; i++) {
    const where = { ...loc, start: i * 2, end: i * 2 + 1 };
    placeholders.push(block(where));
    reads.push(read(`g${i}`));
    pending.set(`g${i}`, [{ loc: where, lower: () => [value(i)] }]);
  }
  const functions = [fn("init", placeholders), fn("use", reads)];
  const walk = vi.spyOn(traversal, "everyStmtList");
  try {
    expect(initializers.process(lowerer, functions)).toBe(true);
    expect(pending.size).toBe(0);
    for (let i = 0; i < 64; i++)
      expect(placeholders[i]).toEqual({
        kind: "block",
        body: [value(i)],
        loc: { ...loc, start: i * 2, end: i * 2 + 1 },
      });
    for (const f of functions)
      expect(walk.mock.calls.filter(([body]) => body === f.body).length).toBeLessThanOrEqual(2);
    walk.mockClear();
    expect(initializers.process(lowerer, functions)).toBe(false);
    expect(walk).not.toHaveBeenCalled();
  } finally {
    walk.mockRestore();
  }
});

test("finds replaced blocks and references appended to an existing body in a later wave", () => {
  const { initializers, pending, lowerer } = fixture();
  const original = block(loc);
  const functions = [fn("init", [original]), fn("use", [])];
  pending.set("registry", [{ loc, lower: () => [value(7)] }]);
  expect(initializers.process(lowerer, functions)).toBe(false);
  functions[0]!.body = traversal.transformStmtList(functions[0]!.body, {
    stmt: (s) => s,
    expr: (e) => e,
  });
  functions[1]!.body.push(read("registry"));
  expect(initializers.process(lowerer, functions)).toBe(true);
  expect(original.body).toEqual([]);
  expect(functions[0]!.body).toEqual([{ kind: "block", body: [value(7)], loc }]);
});

test("reuses the scan of an unchanged body while only bindings are pending", () => {
  const { initializers, pending, lowerer } = fixture();
  const placeholder = block(loc);
  const functions = [fn("init", [placeholder]), fn("use", [value(1)])];
  pending.set("registry", [{ loc, lower: () => [value(7)] }]);
  expect(initializers.process(lowerer, functions)).toBe(false);
  const walk = vi.spyOn(traversal, "everyStmtList");
  try {
    expect(initializers.process(lowerer, functions)).toBe(false);
    expect(walk).not.toHaveBeenCalled();
    // A statement added to the same list is found.
    functions[1]!.body.push(read("registry"));
    expect(initializers.process(lowerer, functions)).toBe(true);
    expect(walk.mock.calls.filter(([body]) => body === functions[0]!.body)).toHaveLength(0);
  } finally {
    walk.mockRestore();
  }
  expect(placeholder.body).toEqual([value(7)]);
});

test("indexes new subtrees for other demanded initializers in the same pass", () => {
  const { initializers, pending, lowerer } = fixture();
  const nestedLoc = { ...loc, start: 10, end: 11 };
  const first = block(loc),
    second = block(nestedLoc),
    nested = block(nestedLoc);
  const functions = [fn("init", [first, second]), fn("use", [read("first"), read("second")])];
  pending.set("first", [{ loc, lower: () => [nested] }]);
  pending.set("second", [{ loc: nestedLoc, lower: () => [value(9)] }]);
  expect(initializers.process(lowerer, functions)).toBe(true);
  expect(first.body).toEqual([{ kind: "block", body: [value(9)], loc: nestedLoc }]);
  expect(second.body).toEqual([value(9)]);
});

test("does not index a materialized subtree with no live insertion point", () => {
  const { initializers, pending, lowerer } = fixture();
  const nestedLoc = { ...loc, start: 10, end: 11 };
  const live = block(nestedLoc),
    detached = block(nestedLoc);
  const functions = [fn("init", [live]), fn("use", [read("first"), read("second")])];
  pending.set("first", [{ loc, lower: () => [detached] }]);
  pending.set("second", [{ loc: nestedLoc, lower: () => [value(9)] }]);
  expect(initializers.process(lowerer, functions)).toBe(true);
  expect(live.body).toEqual([value(9)]);
  expect(detached.body).toEqual([]);
});

test("fills every empty copy with the exact file and span while preserving populated blocks", () => {
  const { initializers, pending, lowerer } = fixture();
  const a = block(loc),
    b = block(loc),
    populated = block(loc);
  populated.body.push(value(1));
  const otherFile = block({ ...loc, file: "other.ts" }),
    otherStart = block({ ...loc, start: 2 }),
    otherEnd = block({ ...loc, end: 2 });
  const functions = [
    fn("init", [a, b, populated, otherFile, otherStart, otherEnd]),
    fn("use", [read("registry")]),
  ];
  pending.set("registry", [{ loc, lower: () => [value(8)] }]);
  expect(initializers.process(lowerer, functions)).toBe(true);
  expect(a.body).toEqual([value(8)]);
  expect(b.body).toEqual([value(8)]);
  expect(populated.body).toEqual([value(1)]);
  for (const untouched of [otherFile, otherStart, otherEnd]) expect(untouched.body).toEqual([]);
});

test("reports the functions whose placeholders it fills", () => {
  const { initializers, pending, lowerer } = fixture();
  const functions = [fn("init", [block(loc)]), fn("use", [read("registry")])];
  pending.set("registry", [{ loc, lower: () => [value(4)] }]);
  const filled: IrFunction[] = [];
  expect(initializers.process(lowerer, functions, (f) => filled.push(f))).toBe(true);
  expect(filled).toEqual([functions[0]]);
});

test("an update or an assignment of the binding demands its initializer", () => {
  const { initializers, pending, lowerer } = fixture();
  const updated = block(loc),
    written = block({ ...loc, start: 2, end: 3 }),
    assigned = block({ ...loc, start: 4, end: 5 }),
    unused = block({ ...loc, start: 6, end: 7 });
  const update = (id: string, prefix: boolean): IrStmt => ({
    kind: "exprStmt",
    expr: { kind: "incDec", op: "+", prefix, localId: id, type: F64, loc },
    loc,
  });
  const functions = [
    fn("init", [updated, written, assigned, unused]),
    fn("use", [
      update("updated", false),
      {
        kind: "assign",
        localId: "written",
        value: { kind: "numLit", value: 1, type: F64, loc },
        loc,
      },
      {
        kind: "exprStmt",
        expr: {
          kind: "assignExpr",
          localId: "assigned",
          value: { kind: "numLit", value: 2, type: F64, loc },
          type: F64,
          loc,
        },
        loc,
      },
    ]),
  ];
  pending.set("updated", [{ loc, lower: () => [value(2)] }]);
  pending.set("written", [{ loc: written.loc, lower: () => [value(3)] }]);
  pending.set("assigned", [{ loc: assigned.loc, lower: () => [value(4)] }]);
  pending.set("unused", [{ loc: unused.loc, lower: () => [value(5)] }]);
  expect(initializers.process(lowerer, functions)).toBe(true);
  expect(updated.body).toEqual([value(2)]);
  // An assignment checks that the binding is initialized and releases its
  // value, so the declaration must have run.
  expect(written.body).toEqual([value(3)]);
  expect(assigned.body).toEqual([value(4)]);
  expect(unused.body).toEqual([]);
  expect(pending.has("unused")).toBe(true);
});
