import { expect, test } from "vitest";
import {
  F64,
  KEY_ORDER_FIELD,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { observeRecordLiteralRebuilds, transformExpr } from "../../ir/traverse.js";
import { ShapeRegistry } from "../type-mapper.js";
import {
  applyKeyOrderWitnesses,
  KeyOrderNotes,
  type KeyOrderSegment,
} from "./key-order-witness.js";
import type { Lowerer } from "./lowerer.js";
import * as ts from "../ts7/adapter.js";

const loc = { file: "order.ts", start: 0, end: 1 };
/** `number | undefined`: the optional-field slot type. */
const OPT: IrType = { kind: "union", unionId: "u0" };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const absent: IrExpr = { kind: "fieldAbsent", unionId: "u0", type: OPT, loc };

interface Fixture {
  lowerer: Lowerer;
  shapes: ShapeRegistry;
  notes: KeyOrderNotes;
  record(fields: [string, IrType][], order: string[]): IrType & { kind: "record" };
  literal(type: IrType, keys: string[], segments?: KeyOrderSegment[]): IrExpr;
  run(body: IrStmt[], name?: string): IrFunction;
  order(type: IrType & { kind: "record" }): string[] | undefined;
}

function fixture(): Fixture {
  const shapes = new ShapeRegistry();
  const notes = new KeyOrderNotes();
  const lowerer = {
    shapes,
    keyOrder: notes,
    unions: new Map([["u0", { id: "u0", arms: [F64, { kind: "undefinedT" }] }]]),
    classes: new Map(),
    methodAccessSites: new Map(),
    dynConvertible: () => true,
    armTag: (unionId: string, arm: IrType): number =>
      unionId === "u0" && arm.kind === "undefinedT" ? 1 : -1,
    recordFieldPresent: (obj: IrExpr, shapeId: string, field: string): IrExpr => ({
      kind: "recordHas",
      obj,
      shapeId,
      field,
      type: { kind: "bool" },
      loc,
    }),
  } as unknown as Lowerer;
  const record = (fields: [string, IrType][], order: string[]): IrType & { kind: "record" } => ({
    kind: "record",
    shapeId: shapes.intern(
      [...fields].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, type]) => ({ name, type })),
      false,
      undefined,
      order,
    ),
  });
  const literal = (type: IrType, keys: string[], segments?: KeyOrderSegment[]): IrExpr => {
    const shape = shapes.get((type as IrType & { kind: "record" }).shapeId)!;
    const fields = keys.map((name) => ({ name, value: num(1) }));
    for (const f of shape.fields)
      if (!keys.includes(f.name)) fields.push({ name: f.name, value: absent });
    return notes.literal(
      { kind: "recordLit", fields, type, loc },
      segments ?? keys.map((name) => ({ kind: "key", name, definite: true })),
    );
  };
  const run = (body: IrStmt[], name = "main"): IrFunction => {
    const fn: IrFunction = { name, params: [], returnType: F64, locals: [], body, loc };
    applyKeyOrderWitnesses(lowerer, [fn]);
    return fn;
  };
  const order = (type: IrType & { kind: "record" }): string[] | undefined =>
    shapes.get(type.shapeId)?.declaredOrder;
  return { lowerer, shapes, notes, record, literal, run, order };
}

/** The order index a literal stores (KEY_ORDER_FIELD), when it stores one. */
const orderIndexOf = (lit: IrExpr): IrExpr | undefined =>
  lit.kind === "recordLit" ? lit.fields.find((x) => x.name === KEY_ORDER_FIELD)?.value : undefined;

const observe = (value: IrExpr): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "jsonStringify", value, type: { kind: "string" }, loc },
  loc,
});
const decl = (localId: string, init: IrExpr): IrStmt => ({ kind: "varDecl", localId, init, loc });
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
const set = (obj: IrExpr, field: string): IrStmt => ({
  kind: "recordSet",
  obj,
  shapeId: (obj.type as IrType & { kind: "record" }).shapeId,
  field,
  value: num(2),
  loc,
});

test("a shape takes the one order its literals write", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  f.run([observe(f.literal(ab, ["b", "a"])), observe(f.literal(ab, ["b", "a"]))]);
  expect(f.order(ab)).toEqual(["b", "a"]);
  expect(f.notes.changed.has(ab.shapeId)).toBe(true);
});

test("literals that agree with the table leave the same array in place", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const before = f.order(ab);
  f.run([observe(f.literal(ab, ["a", "b"]))]);
  expect(f.order(ab)).toBe(before);
  expect(f.notes.changed.size).toBe(0);
});

test("values built in two orders each record their literal's order", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const ba = f.literal(ab, ["b", "a"]);
  const aOrder = f.literal(ab, ["a", "b"]);
  f.run([observe(ba), observe(aOrder)]);
  expect(f.order(ab)).toEqual(["a", "b"]);
  const shape = f.shapes.get(ab.shapeId)!;
  expect(shape.orderVariants).toEqual([
    ["a", "b"],
    ["b", "a"],
  ]);
  expect(shape.fields.map((x) => x.name)).toEqual([KEY_ORDER_FIELD, "a", "b"]);
  expect(orderIndexOf(ba)).toMatchObject({ kind: "numLit", value: 1 });
  expect(orderIndexOf(aOrder)).toMatchObject({ kind: "numLit", value: 0 });
});

test("a copy of a value with orders stores its source's index", () => {
  const f = fixture();
  const abc = f.record(
    [
      ["a", F64],
      ["b", F64],
      ["c", F64],
    ],
    ["a", "b", "c"],
  );
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const read = (field: string): IrExpr => ({
    kind: "recordGet",
    obj: ref("x", abc),
    shapeId: abc.shapeId,
    field,
    type: F64,
    loc,
  });
  const rest = f.notes.copy(
    {
      kind: "recordLit",
      fields: [
        { name: "a", value: read("a") },
        { name: "b", value: read("b") },
      ],
      type: ab,
      loc,
    },
    abc.shapeId,
  );
  f.run([
    decl("x", f.literal(abc, ["c", "b", "a"])),
    observe(f.literal(abc, ["a", "b", "c"])),
    observe(rest),
  ]);
  expect(f.shapes.get(ab.shapeId)!.orderVariants).toEqual([
    ["a", "b"],
    ["b", "a"],
  ]);
  expect(orderIndexOf(rest)).toMatchObject({
    kind: "recordGet",
    obj: { kind: "varRef", localId: "x" },
    field: KEY_ORDER_FIELD,
  });
});

test("an unobserved shape keeps today's table", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  f.run([decl("x", f.literal(ab, ["b", "a"]))]);
  expect(f.order(ab)).toEqual(["a", "b"]);
});

test("a synthesized construction pins today's table", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const synthesized: IrExpr = {
    kind: "recordLit",
    fields: [
      { name: "a", value: num(1) },
      { name: "b", value: num(2) },
    ],
    type: ab,
    loc,
  };
  f.run([observe(f.literal(ab, ["b", "a"])), observe(synthesized)]);
  expect(f.order(ab)).toEqual(["a", "b"]);
});

test("a runtime builder typed by its use site pins today's table", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  // net.serverAddress's signature result is VOID: the call takes its record
  // type from its use site, and the runtime builds the record in that order.
  const built: IrExpr = { kind: "libCall", fn: "net.serverAddress", args: [], type: ab, loc };
  f.run([observe(f.literal(ab, ["b", "a"])), observe(built)]);
  expect(f.order(ab)).toEqual(["a", "b"]);
});

test("an always-throwing call typed as the record leaves its literals' order", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const thrown: IrExpr = { kind: "libCall", fn: "error.nodeThrow", args: [], type: ab, loc };
  f.run([observe(f.literal(ab, ["b", "a"])), observe(thrown)]);
  expect(f.order(ab)).toEqual(["b", "a"]);
});

test("a checked conversion alone pins today's table", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", OPT],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const parsed: IrExpr = { kind: "dynCheck", value: ref("j", { kind: "dyn" }), type: ab, loc };
  // A late write to `a` would move it after `b`; values only a checked
  // conversion builds keep today's table, so parsed values in that order
  // need no source view.
  f.run([decl("p", parsed), set(ref("p", ab), "a"), observe(ref("p", ab))]);
  expect(f.order(ab)).toEqual(["a", "b"]);
});

test("a shape literals and a checked conversion both build takes the literals' order", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const parsed: IrExpr = { kind: "dynCheck", value: ref("j", { kind: "dyn" }), type: ab, loc };
  // The literal's values can enumerate in no other order; parsed values in
  // another order keep a record-source view.
  f.run([observe(f.literal(ab, ["b", "a"])), observe(parsed)]);
  expect(f.order(ab)).toEqual(["b", "a"]);
});

test("a literal an IR rewrite rebuilds keeps its witness", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const identity = { expr: (e: IrExpr): IrExpr => e, stmt: (st: IrStmt): IrStmt => st };
  const original = f.literal(ab, ["b", "a"]);
  observeRecordLiteralRebuilds((from, to) => f.notes.follow(from, to));
  let rebuilt: IrExpr;
  try {
    rebuilt = transformExpr(original, identity);
  } finally {
    observeRecordLiteralRebuilds(null);
  }
  expect(rebuilt).not.toBe(original);
  f.run([observe(rebuilt)]);
  expect(f.order(ab)).toEqual(["b", "a"]);
});

test("a spread contributes its source's order, and an override keeps its position", () => {
  const f = fixture();
  const src = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const out = f.record(
    [
      ["a", F64],
      ["b", F64],
      ["c", F64],
    ],
    ["a", "b", "c"],
  );
  const spread: KeyOrderSegment = { kind: "spread", shapeId: src.shapeId, maybeAbsent: false };
  f.run([
    decl("s", f.literal(src, ["b", "a"])),
    // { ...s, a: 1, c: 2 } — `a` stays where the spread put it.
    observe(
      f.literal(
        out,
        ["a", "b", "c"],
        [
          spread,
          { kind: "key", name: "a", definite: true },
          { kind: "key", name: "c", definite: true },
        ],
      ),
    ),
  ]);
  expect(f.order(out)).toEqual(["b", "a", "c"]);
});

test("a spread of a checked-conversion source cannot be ordered statically", () => {
  const f = fixture();
  const src = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const out = f.record(
    [
      ["a", F64],
      ["b", F64],
      ["c", F64],
    ],
    ["c", "a", "b"],
  );
  const parsed: IrExpr = { kind: "dynCheck", value: ref("j", { kind: "dyn" }), type: src, loc };
  const spread: KeyOrderSegment = { kind: "spread", shapeId: src.shapeId, maybeAbsent: false };
  f.run([
    decl("s", parsed),
    observe(f.literal(out, ["a", "b", "c"], [spread, { kind: "key", name: "c", definite: true }])),
  ]);
  expect(f.order(out)).toEqual(["c", "a", "b"]);
});

test("a late-only optional key follows the keys values are built with", () => {
  const f = fixture();
  const o = f.record(
    [
      ["a", OPT],
      ["b", F64],
    ],
    ["a", "b"],
  );
  f.run([decl("o", f.literal(o, ["b"])), set(ref("o", o), "a"), observe(ref("o", o))]);
  expect(f.order(o)).toEqual(["b", "a"]);
});

test("straight-line writes of late-only keys keep program order", () => {
  const f = fixture();
  const o = f.record(
    [
      ["id", F64],
      ["x", OPT],
      ["y", OPT],
    ],
    ["id", "x", "y"],
  );
  f.run([
    decl("o", f.literal(o, ["id"])),
    set(ref("o", o), "y"),
    set(ref("o", o), "x"),
    observe(ref("o", o)),
  ]);
  expect(f.order(o)).toEqual(["id", "y", "x"]);
});

test("late-only keys written through different bindings move to the end per value", () => {
  const f = fixture();
  const o = f.record(
    [
      ["id", F64],
      ["x", OPT],
      ["y", OPT],
    ],
    ["id", "x", "y"],
  );
  f.run([
    decl("o", f.literal(o, ["id"])),
    set(ref("o", o), "y"),
    set(ref("p", o), "x"),
    observe(ref("o", o)),
  ]);
  expect(f.order(o)).toEqual(["id", "x", "y"]);
  expect(f.shapes.get(o.shapeId)!.orderVariants).toEqual([
    ["id", "x", "y"],
    ["id", "y", "x"],
  ]);
});

test("a late-only key written in a loop guards the write with its move", () => {
  const f = fixture();
  const o = f.record(
    [
      ["id", F64],
      ["x", OPT],
      ["y", OPT],
    ],
    ["id", "x", "y"],
  );
  const body: IrStmt[] = [
    decl("o", f.literal(o, ["id"])),
    set(ref("o", o), "y"),
    {
      kind: "while",
      cond: { kind: "boolLit", value: false, type: { kind: "bool" }, loc },
      body: [set(ref("o", o), "x")],
      loc,
    },
    observe(ref("o", o)),
  ];
  const fn = f.run(body);
  expect(f.order(o)).toEqual(["id", "x", "y"]);
  const loop = fn.body.find((st) => st.kind === "while") as IrStmt & { kind: "while" };
  const guarded = loop.body[0]!;
  expect(guarded.kind).toBe("block");
  const [move, write] = (guarded as IrStmt & { kind: "block" }).body;
  expect(move).toMatchObject({ kind: "if", cond: { kind: "unary", op: "!" } });
  expect(write).toMatchObject({ kind: "recordSet", field: "x" });
});

test("re-adding a key a literal creates earlier moves it to the end of that value", () => {
  const f = fixture();
  const o = f.record(
    [
      ["a", OPT],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const del: IrStmt = {
    kind: "recordSet",
    obj: ref("o", o),
    shapeId: o.shapeId,
    field: "a",
    value: absent,
    loc,
  };
  f.run([decl("o", f.literal(o, ["a", "b"])), del, set(ref("o", o), "a"), observe(ref("o", o))]);
  expect(f.order(o)).toEqual(["a", "b"]);
  expect(f.shapes.get(o.shapeId)!.orderVariants).toEqual([
    ["a", "b"],
    ["b", "a"],
  ]);
});

test("a moving write evaluates its value before it tests and moves the key", () => {
  const f = fixture();
  const o = f.record(
    [
      ["id", F64],
      ["x", OPT],
      ["y", OPT],
    ],
    ["id", "x", "y"],
  );
  // `o.x = ((o.y = 2), 3)`: y is created first.
  const value: IrExpr = {
    kind: "seqExpr",
    stmts: [set(ref("o", o), "y")],
    result: num(3),
    type: F64,
    loc,
  };
  const write: IrStmt = {
    kind: "recordSet",
    obj: ref("o", o),
    shapeId: o.shapeId,
    field: "x",
    value,
    loc,
  };
  const fn = f.run([
    decl("o", f.literal(o, ["id"])),
    observe(f.literal(o, ["x", "id"])),
    write,
    observe(ref("o", o)),
  ]);
  const shape = f.shapes.get(o.shapeId)!;
  expect(shape.orderVariants).toBeDefined();
  const block = fn.body[2] as IrStmt & { kind: "block" };
  expect(block.kind).toBe("block");
  // The receiver evaluates first, since the value may assign its binding.
  const [receiver, first, guard, written] = block.body;
  expect(receiver).toMatchObject({ kind: "varDecl", init: { kind: "varRef", localId: "o" } });
  const target = (receiver as IrStmt & { kind: "varDecl" }).localId;
  expect(first).toMatchObject({ kind: "varDecl", init: { kind: "seqExpr" } });
  const local = (first as IrStmt & { kind: "varDecl" }).localId;
  expect(guard).toMatchObject({ kind: "if", cond: { kind: "unary", op: "!" } });
  expect(written).toMatchObject({
    kind: "recordSet",
    obj: { kind: "varRef", localId: target },
    field: "x",
    value: { kind: "varRef", localId: local },
  });
  // The write inside the value moves y in its own block.
  const init = (first as IrStmt & { kind: "varDecl" }).init as IrExpr & { kind: "seqExpr" };
  expect(init.stmts[0]).toMatchObject({ kind: "block" });
});

test("a key after a spread that the source may lack picks its order from the source's keys", () => {
  const f = fixture();
  const s = f.record(
    [
      ["a", F64],
      ["b", OPT],
      ["c", OPT],
    ],
    ["a", "b", "c"],
  );
  const t = f.record(
    [
      ["a", F64],
      ["b", F64],
      ["c", OPT],
    ],
    ["a", "b", "c"],
  );
  const read = (field: string): IrExpr => ({
    kind: "recordGet",
    obj: ref("v", s),
    shapeId: s.shapeId,
    field,
    type: OPT,
    loc,
  });
  // `{ ...x, b: 1 }`, which evaluates `x` into `v` first
  const merged = f.notes.literal(
    {
      kind: "recordLit",
      fields: [
        { name: "a", value: read("a") },
        { name: "c", value: read("c") },
        { name: "b", value: num(1) },
      ],
      type: t,
      loc,
    },
    [
      {
        kind: "spread",
        shapeId: s.shapeId,
        maybeAbsent: false,
        value: { kind: "varRef", localId: "v", type: s, loc },
      },
      { kind: "key", name: "b", definite: true },
    ],
  );
  const prologue = [decl("v", ref("x", s))];
  f.run([
    decl("x", f.literal(s, ["c", "a"])),
    observe(f.literal(s, ["a", "c"])),
    observe({ kind: "seqExpr", stmts: prologue, result: merged, type: t, loc }),
  ]);
  // b keeps its place in the source's order when the source has it, and
  // follows the source's keys when it does not.
  expect(f.shapes.get(t.shapeId)!.orderVariants).toEqual([
    ["a", "c", "b"],
    ["c", "a", "b"],
    ["a", "b", "c"],
  ]);
  expect(prologue[1]).toMatchObject({
    kind: "varDecl",
    init: {
      kind: "ternary",
      cond: { kind: "recordHas", obj: { kind: "varRef", localId: "v" }, field: "b" },
    },
  });
  const snapshot = (prologue[1] as IrStmt & { kind: "varDecl" }).localId;
  expect(orderIndexOf(merged)).toMatchObject({ kind: "varRef", localId: snapshot });
});

test("a spread reads its source's order right after the literal evaluates the source", () => {
  const f = fixture();
  const s = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const t = f.record(
    [
      ["a", F64],
      ["b", F64],
      ["first", F64],
      ["last", F64],
    ],
    ["first", "a", "b", "last"],
  );
  const read = (localId: string, field: string): IrExpr => ({
    kind: "recordGet",
    obj: ref(localId, s),
    shapeId: s.shapeId,
    field,
    type: F64,
    loc,
  });
  // `{ first: y.a, ...x, last: y.b }`: the literal evaluates `first`, then
  // the source into `v` and its fields, then `last`, which reads another
  // value of the source's shape.
  const lit = f.notes.literal(
    {
      kind: "recordLit",
      fields: [
        { name: "first", value: ref("p", F64) },
        { name: "a", value: ref("va", F64) },
        { name: "b", value: ref("vb", F64) },
        { name: "last", value: read("y", "b") },
      ],
      type: t,
      loc,
    },
    [
      { kind: "key", name: "first", definite: true },
      {
        kind: "spread",
        shapeId: s.shapeId,
        maybeAbsent: false,
        value: { kind: "varRef", localId: "v", type: s, loc },
      },
      { kind: "key", name: "last", definite: true },
    ],
  );
  const prologue: IrStmt[] = [
    decl("p", read("y", "a")),
    decl("v", ref("x", s)),
    decl("va", read("v", "a")),
    decl("vb", read("v", "b")),
  ];
  f.run([
    decl("x", f.literal(s, ["b", "a"])),
    decl("y", f.literal(s, ["a", "b"])),
    observe({ kind: "seqExpr", stmts: prologue, result: lit, type: t, loc }),
  ]);
  expect(f.shapes.get(t.shapeId)!.orderVariants).toEqual([
    ["first", "a", "b", "last"],
    ["first", "b", "a", "last"],
  ]);
  // The index is the spread binding's, read before `last` evaluates.
  expect(prologue[2]).toMatchObject({
    kind: "varDecl",
    init: { kind: "recordGet", obj: { kind: "varRef", localId: "v" }, field: KEY_ORDER_FIELD },
  });
  const snapshot = (prologue[2] as IrStmt & { kind: "varDecl" }).localId;
  expect(orderIndexOf(lit)).toMatchObject({ kind: "varRef", localId: snapshot });
});

/** `{ a, b }` with a declared table `["a", "b"]` and a literal `{ b, a }`
 * plus `{ ...value, a }` of the same shape, beside `extra`. */
function selfCopy(
  extra: (f: Fixture, ab: IrType & { kind: "record" }) => IrStmt[],
  fnName = "main",
): string[] {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const self: KeyOrderSegment = { kind: "spread", shapeId: ab.shapeId, maybeAbsent: false };
  f.run(
    [
      decl("v", f.literal(ab, ["b", "a"])),
      observe(f.literal(ab, ["a", "b"], [self, { kind: "key", name: "a", definite: true }])),
      ...extra(f, ab),
    ],
    fnName,
  );
  return f.order(ab)!;
}

test("a literal that starts by spreading its own shape takes the other literals' order", () => {
  expect(selfCopy(() => [])).toEqual(["b", "a"]);
});

test("a self copy of a shape a checked conversion builds cannot be ordered statically", () => {
  const parsed = (ab: IrType): IrExpr => ({
    kind: "dynCheck",
    value: ref("j", { kind: "dyn" }),
    type: ab,
    loc,
  });
  expect(selfCopy((_, ab) => [observe(parsed(ab))])).toEqual(["a", "b"]);
});

test("a replaceable method's checked result builds no record", () => {
  expect(
    selfCopy((f, ab) => {
      const result: IrExpr = { kind: "dynCheck", value: ref("r", { kind: "dyn" }), type: ab, loc };
      return [observe(f.notes.methodResult(result, "load"))];
    }),
  ).toEqual(["b", "a"]);
});

test("a replaceable method's checked result builds records when a replacement may return one", () => {
  expect(
    selfCopy((f, ab) => {
      // A site the census cannot see through (a computed write of some
      // value, a reflection call) may install a replacement returning a
      // record built in any order.
      (f.lowerer.methodAccessSites as Map<string, ts.Node[]>).set("load", [
        { kind: ts.SyntaxKind.CallExpression } as unknown as ts.Node,
      ]);
      const result: IrExpr = { kind: "dynCheck", value: ref("r", { kind: "dyn" }), type: ab, loc };
      return [observe(f.notes.methodResult(result, "load"))];
    }),
  ).toEqual(["a", "b"]);
});

/** A native callback taking the shape, boxed for JavaScript. */
const boxedCallback = (ab: IrType): IrExpr => ({
  kind: "dynFrom",
  value: {
    kind: "closure",
    fnName: "callback",
    captures: [],
    type: { kind: "func", params: [ab], ret: { kind: "void" } },
    loc,
  },
  type: { kind: "dyn" },
  loc,
});

test("a native callback boxed for JavaScript receives records JavaScript builds", () => {
  expect(selfCopy((_, ab) => [observe(boxedCallback(ab))])).toEqual(["a", "b"]);
});

test("a class's prototype slots box its methods without building their parameters", () => {
  expect(selfCopy((_, ab) => [observe(boxedCallback(ab))], "%prototype.data.Service")).toEqual([
    "b",
    "a",
  ]);
});

test("a replaceable method's result keeps its witness through an IR rewrite", () => {
  expect(
    selfCopy((f, ab) => {
      const result = f.notes.methodResult(
        {
          kind: "dynCheck",
          value: ref("r", { kind: "dyn" }),
          type: ab,
          loc,
        },
        "load",
      );
      const identity = { expr: (e: IrExpr): IrExpr => e, stmt: (st: IrStmt): IrStmt => st };
      observeRecordLiteralRebuilds((from, to) => f.notes.follow(from, to));
      try {
        const rebuilt = transformExpr(result, identity);
        expect(rebuilt).not.toBe(result);
        return [observe(rebuilt)];
      } finally {
        observeRecordLiteralRebuilds(null);
      }
    }),
  ).toEqual(["b", "a"]);
});

test("a checked conversion of a boxed primitive builds no record", () => {
  expect(
    selfCopy((_, ab) => {
      const missing: IrExpr = {
        kind: "dynFrom",
        value: { kind: "unitLit", unit: "undefined", type: { kind: "undefinedT" }, loc },
        type: { kind: "dyn" },
        loc,
      };
      return [observe({ kind: "dynCheck", value: missing, type: ab, loc })];
    }),
  ).toEqual(["b", "a"]);
});

test("a checked conversion into a class builds none of its fields' records", () => {
  expect(
    selfCopy((f, ab) => {
      (f.lowerer.classes as Map<string, unknown>).set("Holder", {
        def: { fields: [{ name: "value", type: ab }] },
      });
      const holder: IrType = { kind: "object", className: "Holder" };
      const checked: IrExpr = {
        kind: "dynCheck",
        value: ref("h", { kind: "dyn" }),
        type: holder,
        loc,
      };
      return [{ kind: "exprStmt", expr: checked, loc }];
    }),
  ).toEqual(["b", "a"]);
});

test("a checked function passes its record parameters out, and its callbacks' back in", () => {
  const callable = (params: IrType[]): IrType => ({
    kind: "func",
    params,
    ret: { kind: "string" },
  });
  const checkedAs = (type: IrType): IrStmt => ({
    kind: "exprStmt",
    expr: { kind: "dynCheck", value: ref("fn", { kind: "dyn" }), type, loc },
    loc,
  });
  expect(selfCopy((_, ab) => [checkedAs(callable([ab]))])).toEqual(["b", "a"]);
  // A callback parameter receives values the JavaScript function builds.
  expect(selfCopy((_, ab) => [checkedAs(callable([callable([ab])]))])).toEqual(["a", "b"]);
  // So does a container parameter, which the function can write into.
  expect(selfCopy((_, ab) => [checkedAs(callable([{ kind: "array", elem: ab }]))])).toEqual([
    "a",
    "b",
  ]);
});

test("a generator resume builds only its result record, never the value it carries", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const result = f.record(
    [
      ["done", { kind: "bool" }],
      ["value", ab],
    ],
    ["value", "done"],
  );
  const gen: IrType = {
    kind: "generator",
    yieldT: ab,
    retT: { kind: "void" },
    nextT: { kind: "undefinedT" },
  };
  const resume = (mode: "next" | "value", type: IrType): IrStmt =>
    observe({ kind: "genResume", mode, gen: ref("g", gen), arg: null, type, loc });
  f.run([
    observe(f.literal(ab, ["b", "a"])),
    observe(f.literal(result, ["done", "value"])),
    resume("value", ab),
    resume("next", result),
  ]);
  expect(f.order(ab)).toEqual(["b", "a"]);
  // The result record itself is built in its fixed layout: today's table.
  expect(f.order(result)).toEqual(["value", "done"]);
});

/** `{ a, b }` built by a checked conversion and by the literal `{ b, a }`,
 * copied by `{ ...value, a }` (evaluating the value into a binding, as
 * spread literals do), observed. Answers the table and the function. */
function checkedSelfCopy(): { order: string[]; fn: IrFunction; copy: IrExpr } {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const value = ref("value", ab) as IrExpr & { kind: "varRef" };
  const self: KeyOrderSegment = { kind: "spread", shapeId: ab.shapeId, maybeAbsent: false, value };
  const literal = f.literal(ab, ["a", "b"], [self, { kind: "key", name: "a", definite: true }]);
  const copy: IrExpr = {
    kind: "seqExpr",
    stmts: [decl("value", { kind: "dynCheck", value: ref("j", { kind: "dyn" }), type: ab, loc })],
    result: literal,
    type: ab,
    loc,
  };
  const fn = f.run([observe(f.literal(ab, ["b", "a"])), observe(copy)]);
  return { order: f.order(ab)!, fn, copy };
}

test("a spread of a value a checked conversion built carries the value's order over", () => {
  const { order, fn, copy } = checkedSelfCopy();
  // Values the literal builds enumerate in its order; copies of converted
  // values keep the order their record source holds.
  expect(order).toEqual(["b", "a"]);
  expect(copy).toMatchObject({
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: "value" },
      { kind: "varDecl", localId: "%orderedSpread.0", init: { kind: "recordLit" } },
      {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "record.sourceSpread",
          args: [
            { kind: "varRef", localId: "%orderedSpread.0" },
            { kind: "varRef", localId: "value" },
          ],
        },
      },
    ],
    result: { kind: "varRef", localId: "%orderedSpread.0" },
  });
  expect(fn.locals.map((local) => local.id)).toEqual(["%orderedSpread.0"]);
});

test("a spread of a converted value into a wider shape orders the wider shape", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const abc = f.record(
    [
      ["a", F64],
      ["b", F64],
      ["c", F64],
    ],
    ["c", "a", "b"],
  );
  const value = ref("value", ab) as IrExpr & { kind: "varRef" };
  const spread: KeyOrderSegment = {
    kind: "spread",
    shapeId: ab.shapeId,
    maybeAbsent: false,
    value,
  };
  const wide: IrExpr = {
    kind: "seqExpr",
    stmts: [decl("value", { kind: "dynCheck", value: ref("j", { kind: "dyn" }), type: ab, loc })],
    result: f.literal(abc, ["a", "b", "c"], [spread, { kind: "key", name: "c", definite: true }]),
    type: abc,
    loc,
  };
  f.run([observe(f.literal(ab, ["b", "a"])), observe(wide)]);
  expect(f.order(ab)).toEqual(["b", "a"]);
  expect(f.order(abc)).toEqual(["b", "a", "c"]);
});
