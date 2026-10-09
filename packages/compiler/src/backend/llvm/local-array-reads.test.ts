import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  UNDEFINED_T,
  arrayOf,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import {
  findArrayPreservingFunctions,
  findLocalArrayReads,
  findCallArrayReads,
  OptionalArrayReads,
} from "./local-array-reads.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";

/** A pending-exception check: the inline active-cell test or a runtime call. */
const PENDING_CHECK = /@scr_exc_(?:active|pending)\b/;

const loc = { file: "local-array.ts", start: 0, end: 0 };
const element: IrType = { kind: "record", shapeId: "cell" };
const optional: IrType = { kind: "union", unionId: "optional" };
const array = arrayOf(element);
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const params = [
  { localId: "a", name: "a", type: array },
  { localId: "i", name: "i", type: F64 },
];
const unionValue = ref("value", optional);
const narrow: IrExpr = {
  kind: "unionNarrow",
  unionId: "optional",
  tag: 0,
  value: unionValue,
  type: element,
  loc,
};

function fixture(): IrModule {
  const producer: IrFunction = {
    name: "read",
    params,
    returnType: optional,
    locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
    loc,
    body: [
      {
        kind: "return",
        loc,
        value: {
          kind: "ternary",
          type: optional,
          loc,
          cond: {
            kind: "bin",
            op: "===",
            left: {
              kind: "arrayState",
              arr: ref("a", array),
              index: ref("i", F64),
              type: F64,
              loc,
            },
            right: num(1),
            type: BOOL,
            loc,
          },
          then: {
            kind: "unionWrap",
            unionId: "optional",
            tag: 0,
            value: {
              kind: "arrayGet",
              arr: ref("a", array),
              index: ref("i", F64),
              type: element,
              loc,
            },
            type: optional,
            loc,
          },
          else_: {
            kind: "unionWrap",
            unionId: "optional",
            tag: 1,
            value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
            type: optional,
            loc,
          },
        },
      },
    ],
  };
  const work: IrFunction = {
    name: "work",
    params,
    returnType: F64,
    loc,
    locals: [...producer.locals, { id: "value", name: "value", type: optional, mutable: false }],
    body: [
      {
        kind: "varDecl",
        localId: "value",
        init: {
          kind: "call",
          callee: "read",
          args: [ref("a", array), ref("i", F64)],
          type: optional,
          loc,
        },
        loc,
      },
      {
        kind: "return",
        value: { kind: "recordGet", obj: narrow, shapeId: "cell", field: "x", type: F64, loc },
        loc,
      },
    ],
  };
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    records: [{ id: "cell", fields: [{ name: "x", type: F64 }] }],
    unions: [{ id: "optional", arms: [element, UNDEFINED_T] }],
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc },
      producer,
      work,
    ],
  };
}
function candidates(mod: IrModule) {
  const functions = new Map(mod.functions.map((f) => [f.name, f]));
  const unions = new Map(mod.unions!.map((u) => [u.id, u]));
  return findLocalArrayReads(
    mod.functions[2]!,
    functions,
    unions,
    findArrayPreservingFunctions(functions, unions),
  );
}
function workBody(mod: IrModule, pointerBits: 32 | 64 = 64) {
  return /^define internal [^\n]*@sc_(?:b)?f_work\([^]*?^}/m.exec(
    emitLlvmModule(mod, { pointerBits }),
  )![0];
}

test("private optional array results use local tags and borrowed payloads on both ABIs", () => {
  const mod = fixture();
  expect(validateModule(mod)).toEqual([]);
  expect(candidates(mod).get("value")?.borrow).toBe(true);
  for (const pointerBits of [32, 64] as const) {
    const body = workBody(mod, pointerBits);
    expect(body).toContain("alloca %ScrUnion");
    expect(body).toContain("@scr_arr_peek_ref");
    expect(body).not.toContain("@sc_bf_read(");
    expect(body).not.toContain("@scr_union_release");
    expect(body).not.toContain("@sc_rretain_");
    expect(body).not.toContain("@sc_rrelease_");
  }
});

test("unchanged let bindings keep optional array payloads private", () => {
  const mod = fixture();
  mod.functions[2]!.locals[2]!.mutable = true;
  expect(candidates(mod).get("value")?.borrow).toBe(true);
  expect(workBody(mod)).not.toContain("@sc_rretain_");
});

test("preserving loops borrow from local array owners despite unrelated mutation", () => {
  const mod = fixture();
  const work = mod.functions[2]!;
  work.locals[2]!.mutable = true;
  work.body = [
    { kind: "arraySetLength", arr: ref("a", array), length: num(1), loc },
    { kind: "for", init: null, cond: null, update: null, body: work.body, loc },
  ];
  expect(candidates(mod).get("value")?.borrow).not.toBe(true);
  for (const pointerBits of [32, 64] as const) {
    const body = workBody(mod, pointerBits);
    expect(body).toContain("@scr_arr_peek_ref");
    expect(body).not.toContain("@sc_rretain_");
    expect(body).not.toContain("@sc_rrelease_");
  }
  const loop = work.body[1]!;
  if (loop.kind !== "for") throw new Error("expected loop");
  loop.body.splice(1, 0, { kind: "arraySetLength", arr: ref("a", array), length: num(0), loc });
  expect(workBody(mod)).toContain("@sc_rretain_");
});

test("array mutation preserves a separate payload owner and exceptional cleanup", () => {
  const mod = fixture();
  mod.functions[2]!.body.splice(1, 0, {
    kind: "arraySetLength",
    arr: ref("a", array),
    length: num(0),
    loc,
  });
  expect(validateModule(mod)).toEqual([]);
  expect(candidates(mod).get("value")?.borrow).not.toBe(true);
  const body = workBody(mod);
  expect(body).toContain("@sc_rretain_");
  expect(body).toContain("@sc_rrelease_");
  expect(body).not.toContain("@scr_union_release");
});

test("replacing an array parameter keeps the earlier element independently owned", () => {
  const mod = fixture();
  const work = mod.functions[2]!;
  work.locals[0] = { ...work.locals[0]!, mutable: true };
  work.params = [...work.params, { localId: "replacement", name: "replacement", type: array }];
  work.locals.push({ id: "replacement", name: "replacement", type: array, mutable: false });
  work.body.splice(1, 0, { kind: "assign", localId: "a", value: ref("replacement", array), loc });
  expect(validateModule(mod)).toEqual([]);
  const functions = new Map(mod.functions.map((f) => [f.name, f]));
  expect(
    findArrayPreservingFunctions(functions, new Map(mod.unions!.map((u) => [u.id, u]))).has("work"),
  ).toBe(true);
  expect(candidates(mod).get("value")?.borrow).not.toBe(true);
  for (const bits of [32, 64] as const) {
    const body = workBody(mod, bits);
    expect(body).toContain("@sc_rretain_");
    expect(body).toContain("@sc_rrelease_");
  }
});

test.each([
  "alias",
  "capture",
  "assign",
  "boxed",
  "tdz",
  "duplicate",
  "async",
  "effectful producer",
])("keeps %s optional boxes on the general path", (reason) => {
  const mod = fixture();
  const fn = mod.functions[2]!;
  const local = fn.locals[2]!;
  if (reason === "alias") fn.body.push({ kind: "return", value: unionValue, loc });
  if (reason === "capture")
    fn.body.push({
      kind: "exprStmt",
      expr: { kind: "closure", fnName: "capture", captures: ["value"], type: funcOf([], F64), loc },
      loc,
    });
  if (reason === "assign")
    fn.body.push({ kind: "assign", localId: "value", value: unionValue, loc });
  if (reason === "boxed") local.boxed = true;
  if (reason === "tdz") local.tdz = true;
  if (reason === "duplicate") fn.body.push(fn.body[0]!);
  if (reason === "async") fn.async = true;
  if (reason === "effectful producer")
    mod.functions[1]!.body.unshift({ kind: "exprStmt", expr: num(1), loc });
  expect(candidates(mod).size).toBe(0);
});

test("unknown calls and reference stores disable array borrowing", () => {
  const effects: IrStmt[] = [
    { kind: "exprStmt", expr: { kind: "call", callee: "unknown", args: [], type: VOID, loc }, loc },
    { kind: "arraySet", arr: ref("a", array), index: num(0), value: narrow, loc },
    { kind: "assign", localId: "a", value: ref("a", array), loc },
  ];
  for (const effect of effects) {
    const mod = fixture();
    mod.functions[2]!.body.splice(1, 0, effect);
    expect(candidates(mod).get("value")?.borrow).not.toBe(true);
  }
});

function scalarHelper(name: string, callee?: string): IrFunction {
  return {
    name,
    params: [{ localId: "n", name: "n", type: F64 }],
    returnType: F64,
    loc,
    locals: [{ id: "n", name: "n", type: F64, mutable: false }],
    body: [
      {
        kind: "return",
        loc,
        value: callee
          ? { kind: "call", callee, args: [ref("n", F64)], type: F64, loc }
          : { kind: "bin", op: "+", left: ref("n", F64), right: num(1), type: F64, loc },
      },
    ],
  };
}

function callHelper(mod: IrModule, callee: string, argument: IrExpr = num(2)): void {
  mod.functions[2]!.body.splice(1, 0, {
    kind: "exprStmt",
    loc,
    expr: { kind: "call", callee, args: [argument], type: F64, loc },
  });
}

test("borrows array payloads across direct and transitive scalar helpers", () => {
  const mod = fixture();
  mod.functions.push(scalarHelper("outer", "inner"), scalarHelper("inner"));
  callHelper(mod, "outer");
  expect(validateModule(mod)).toEqual([]);
  expect(candidates(mod).get("value")?.borrow).toBe(true);
  for (const pointerBits of [32, 64] as const) {
    const body = workBody(mod, pointerBits);
    expect(body).toContain("@sc_f_outer(");
    expect(body).not.toContain("@sc_rretain_");
    expect(body).not.toContain("@sc_rrelease_");
  }
});

test("propagates reference mutation through a recursive call group", () => {
  const mod = fixture();
  const outer = scalarHelper("outer", "inner");
  const inner = scalarHelper("inner", "outer");
  mod.functions.push(outer, inner);
  callHelper(mod, "outer");
  expect(validateModule(mod)).toEqual([]);
  expect(candidates(mod).get("value")?.borrow).toBe(true);
  inner.locals.push({ id: "owned", name: "owned", type: array, mutable: true });
  inner.body.unshift({ kind: "assign", localId: "owned", value: ref("owned", array), loc });
  expect(candidates(mod).get("value")?.borrow).toBe(true);
  inner.body.unshift({ kind: "arraySetLength", arr: ref("owned", array), length: num(0), loc });
  expect(candidates(mod).get("value")?.borrow).not.toBe(true);
  expect(workBody(mod)).toContain("@sc_rretain_");
});

test.each(["unknown", "callback", "async", "capture", "reference store"])(
  "rejects helpers with %s effects through callers",
  (effect) => {
    const mod = fixture();
    const inner = scalarHelper("inner");
    mod.functions.push(scalarHelper("outer", "inner"), inner);
    callHelper(mod, "outer");
    if (effect === "unknown")
      inner.body[0] = {
        kind: "return",
        loc,
        value: { kind: "call", callee: "unavailable", args: [], type: F64, loc },
      };
    if (effect === "callback")
      inner.body[0] = {
        kind: "return",
        loc,
        value: {
          kind: "callValue",
          callee: ref("callback", funcOf([], F64)),
          args: [],
          type: F64,
          loc,
        },
      };
    if (effect === "async") inner.async = true;
    if (effect === "capture") inner.captures = [];
    if (effect === "reference store")
      inner.body.unshift({ kind: "arraySetLength", arr: ref("items", array), length: num(0), loc });
    expect(candidates(mod).get("value")?.borrow).not.toBe(true);
  },
);

test("checks side effects in arguments even when the callee preserves references", () => {
  const mod = fixture();
  mod.functions.push(scalarHelper("helper"));
  callHelper(mod, "helper", {
    kind: "seqExpr",
    loc,
    type: F64,
    stmts: [{ kind: "arraySetLength", arr: ref("a", array), length: num(0), loc }],
    result: num(0),
  });
  expect(validateModule(mod)).toEqual([]);
  expect(candidates(mod).get("value")?.borrow).not.toBe(true);
  expect(workBody(mod)).toContain("@sc_rretain_");
});

test("iteratively propagates an unsafe leaf through a long call chain", () => {
  const functions = new Map<string, IrFunction>();
  for (let i = 0; i < 10000; i++) functions.set(`f${i}`, scalarHelper(`f${i}`, `f${i + 1}`));
  expect(findArrayPreservingFunctions(functions, new Map()).size).toBe(0);
  functions.set("f10000", scalarHelper("f10000"));
  expect(findArrayPreservingFunctions(functions, new Map()).size).toBe(10001);
});

function projectionHelper(name: string, callee?: string): IrFunction {
  return {
    name,
    params: [{ localId: "value", name: "value", type: optional }],
    returnType: F64,
    loc,
    locals: [{ id: "value", name: "value", type: optional, mutable: true }],
    body: [
      {
        kind: "return",
        loc,
        value: callee
          ? { kind: "call", callee, args: [unionValue], type: F64, loc }
          : { kind: "recordGet", obj: narrow, shapeId: "cell", field: "x", type: F64, loc },
      },
    ],
  };
}

function passOptional(mod: IrModule, callee: string): void {
  mod.functions[2]!.body[1] = {
    kind: "return",
    loc,
    value: { kind: "call", callee, args: [unionValue], type: F64, loc },
  };
}

test("keeps optional array boxes local across transitive projection helpers", () => {
  const mod = fixture();
  mod.functions.push(projectionHelper("outer", "inner"), projectionHelper("inner"));
  passOptional(mod, "outer");
  expect(validateModule(mod)).toEqual([]);
  expect(candidates(mod).get("value")?.borrow).toBe(true);
  for (const width of [32, 64] as const) {
    const body = workBody(mod, width);
    expect(body).toContain("alloca %ScrUnion");
    expect(body).toContain("@sc_bf_outer");
    expect(body).not.toContain("@sc_bf_read(");
    expect(body).not.toMatch(/@scr_union_(?:new|retain|release)/);
    expect(body).not.toContain("@sc_rretain_");
    expect(body).not.toContain("@sc_rrelease_");
  }
});

test("a mutating helper preserves the local box but requires its payload owner", () => {
  const mod = fixture();
  const helper = projectionHelper("helper");
  helper.params.push({ localId: "items", name: "items", type: array });
  helper.locals.push({ id: "items", name: "items", type: array, mutable: false });
  helper.body.unshift({ kind: "arraySetLength", arr: ref("items", array), length: num(0), loc });
  mod.functions.push(helper);
  mod.functions[2]!.body[1] = {
    kind: "return",
    loc,
    value: { kind: "call", callee: "helper", args: [unionValue, ref("a", array)], type: F64, loc },
  };
  expect(validateModule(mod)).toEqual([]);
  expect(candidates(mod).get("value")?.borrow).not.toBe(true);
  const body = workBody(mod);
  expect(body).toContain("alloca %ScrUnion");
  expect(body).toContain("@sc_rretain_");
  expect(body).toContain("@sc_rrelease_");
  expect(body).not.toContain("@scr_union_release");
});

test("an escaping leaf restores heap boxes throughout a recursive forwarding group", () => {
  const mod = fixture();
  const outer = projectionHelper("outer", "inner"),
    inner = projectionHelper("inner", "outer");
  mod.functions.push(outer, inner);
  passOptional(mod, "outer");
  expect(candidates(mod).has("value")).toBe(true);
  inner.locals.push({ id: "alias", name: "alias", type: optional, mutable: false });
  inner.body.unshift({ kind: "varDecl", localId: "alias", init: unionValue, loc });
  expect(validateModule(mod)).toEqual([]);
  expect(candidates(mod).has("value")).toBe(false);
  const body = workBody(mod);
  expect(body).toContain("@sc_bf_read(");
  expect(body).toContain("@scr_union_release");
});

test("a later mutating argument snapshots the payload before entering the helper", () => {
  const mod = fixture();
  const helper = projectionHelper("helper");
  helper.params.push({ localId: "count", name: "count", type: F64 });
  helper.locals.push({ id: "count", name: "count", type: F64, mutable: true });
  mod.functions.push(helper);
  const later: IrExpr = {
    kind: "seqExpr",
    loc,
    type: F64,
    stmts: [{ kind: "arraySetLength", arr: ref("a", array), length: num(0), loc }],
    result: num(1),
  };
  mod.functions[2]!.body[1] = {
    kind: "return",
    loc,
    value: { kind: "call", callee: "helper", args: [unionValue, later], type: F64, loc },
  };
  expect(validateModule(mod)).toEqual([]);
  expect(candidates(mod).get("value")?.borrow).not.toBe(true);
  const body = workBody(mod);
  expect(body).not.toContain("@scr_union_retain");
  expect(body.indexOf("@sc_rretain_")).toBeLessThan(body.indexOf("@scr_arr_set_len"));
  expect(body.indexOf("@scr_arr_set_len")).toBeLessThan(body.indexOf("@sc_bf_helper"));
});

function immediateFixture(): IrModule {
  const module = fixture();
  const consume: IrFunction = {
    name: "consume",
    loc,
    params: [{ localId: "value", name: "value", type: optional }],
    locals: [{ id: "value", name: "value", type: optional, mutable: true }],
    returnType: F64,
    body: [
      {
        kind: "return",
        value: { kind: "recordGet", obj: narrow, shapeId: "cell", field: "x", type: F64, loc },
        loc,
      },
    ],
  };
  const work = module.functions[2]!;
  work.locals = work.locals.filter((local) => local.id !== "value");
  work.body = [
    {
      kind: "return",
      value: {
        kind: "call",
        callee: "consume",
        args: [
          {
            kind: "call",
            callee: "read",
            args: [ref("a", array), ref("i", F64)],
            type: optional,
            loc,
          },
        ],
        type: F64,
        loc,
      },
      loc,
    },
  ];
  module.functions.push(consume);
  return module;
}
function immediateFacts(module: IrModule) {
  const functions = new Map(module.functions.map((f) => [f.name, f]));
  const unions = new Map(module.unions!.map((u) => [u.id, u]));
  const reads = new OptionalArrayReads(functions, unions);
  const preserving = findArrayPreservingFunctions(functions, unions, reads);
  const lifetimes = analyzeCallLifetimes(functions);
  return findCallArrayReads(module.functions[2]!, reads, preserving, lifetimes);
}
function immediateCall(module: IrModule): IrExpr & { kind: "call" } {
  const stmt = module.functions[2]!.body[0]!;
  if (stmt.kind !== "return" || stmt.value?.kind !== "call") throw new Error("missing call");
  return stmt.value;
}

test("immediate optional reads borrow preserved parameter edges on both pointer widths", () => {
  const module = immediateFixture();
  const read = immediateCall(module).args[0]!;
  expect(immediateFacts(module).get(read)?.borrow).toBe(true);
  for (const bits of [32, 64] as const) {
    const ir = workBody(module, bits);
    expect(ir).toContain("alloca %ScrUnion");
    expect(ir).toContain("@sc_bf_consume");
    expect(ir).toContain("local.array.dense");
    expect(ir).not.toContain("@sc_bf_read");
    expect(ir).not.toContain("@scr_union_new_ref");
    expect(ir).not.toContain("@scr_union_release");
    expect(ir).not.toContain("@sc_rretain_");
    expect(ir).not.toContain("@sc_rrelease_");
  }
});

test("a later argument that removes an array edge keeps an independent payload owner", () => {
  const module = immediateFixture();
  const consume = module.functions[3]!;
  consume.params.push({ localId: "other", name: "other", type: F64 });
  consume.locals.push({ id: "other", name: "other", type: F64, mutable: false });
  immediateCall(module).args.push({
    kind: "seqExpr",
    stmts: [{ kind: "arraySetLength", arr: ref("a", array), length: num(0), loc }],
    result: num(1),
    type: F64,
    loc,
  });
  const read = immediateCall(module).args[0]!;
  expect(immediateFacts(module).get(read)?.borrow).not.toBe(true);
  expect(validateModule(module)).toEqual([]);
  const ir = workBody(module);
  expect(ir).toContain("@sc_rretain_");
  expect(ir).toContain("@sc_rrelease_");
  expect(ir).toContain("@scr_arr_peek_ref");
  expect(ir).not.toContain("local.array.dense");
  expect(ir.match(/@sc_rretain_/g)).toHaveLength(1);
  expect(ir).not.toContain("@scr_union_release");
  expect(ir.indexOf("@sc_rretain_")).toBeLessThan(ir.indexOf("@sc_bf_consume"));
});

test("mutation inside the consuming helper also snapshots an immediate payload", () => {
  const module = immediateFixture();
  const consume = module.functions[3]!;
  consume.params.push({ localId: "array", name: "array", type: array });
  consume.locals.push({ id: "array", name: "array", type: array, mutable: false });
  consume.body.unshift({ kind: "arraySetLength", arr: ref("array", array), length: num(0), loc });
  immediateCall(module).args.push(ref("a", array));
  const read = immediateCall(module).args[0]!;
  expect(immediateFacts(module).get(read)?.borrow).not.toBe(true);
  expect(validateModule(module)).toEqual([]);
  const ir = workBody(module);
  expect(ir).toContain("@sc_bf_consume");
  expect(ir).toContain("@sc_rretain_");
  expect(ir).toContain("@sc_rrelease_");
});

test("escaping consumers keep a heap union across a borrowed call", () => {
  const module = immediateFixture();
  const consume = module.functions[3]!;
  consume.returnType = optional;
  consume.body = [{ kind: "return", value: unionValue, loc }];
  module.functions[2]!.returnType = optional;
  immediateCall(module).type = optional;
  expect(immediateFacts(module).size).toBe(0);
  const ir = workBody(module);
  expect(ir).toContain("@sc_bf_read");
  expect(ir).toContain("@sc_bf_consume");
  expect(ir).not.toContain("alloca %ScrUnion");
});

test("async and generator callers keep their established suspension representation", () => {
  for (const suspend of ["async", "generator"] as const) {
    const module = immediateFixture();
    const work = module.functions[2]!;
    if (suspend === "async") work.async = true;
    else
      work.generator = {
        yieldT: F64,
        nextT: F64,
        resultType: { kind: "record", shapeId: "result" },
      };
    expect(immediateFacts(module).size).toBe(0);
  }
});

test("indirect consumers do not receive immediate stack unions", () => {
  const module = immediateFixture();
  const call = immediateCall(module);
  module.functions[2]!.body = [
    {
      kind: "return",
      loc,
      value: {
        kind: "callValue",
        callee: {
          kind: "closure",
          fnName: "consume",
          captures: [],
          type: funcOf([optional], F64),
          loc,
        },
        args: call.args,
        type: F64,
        loc,
      },
    },
  ];
  expect(immediateFacts(module).size).toBe(0);
  expect(workBody(module)).toContain("@sc_bf_read");
});

test("each immediate argument has separate tag and payload storage", () => {
  const module = immediateFixture();
  const consume = module.functions[3]!;
  consume.params.push({ localId: "second", name: "second", type: optional });
  consume.locals.push({ id: "second", name: "second", type: optional, mutable: false });
  consume.body.unshift({
    kind: "exprStmt",
    expr: {
      kind: "unionIsTag",
      value: ref("second", optional),
      unionId: "optional",
      tag: 1,
      negated: false,
      type: BOOL,
      loc,
    },
    loc,
  });
  immediateCall(module).args.push({
    kind: "call",
    callee: "read",
    args: [ref("a", array), num(1)],
    type: optional,
    loc,
  });
  expect(immediateFacts(module).size).toBe(2);
  const ir = workBody(module);
  expect(ir.match(/alloca %ScrUnion/g)).toHaveLength(2);
  expect(ir.match(/@scr_arr_peek_ref/g)).toHaveLength(2);
  expect(ir).not.toContain("@sc_bf_read");
});

test("throwing later arguments borrow preserved payloads and release mutable snapshots", () => {
  const module = immediateFixture();
  const consume = module.functions[3]!;
  consume.params.push({ localId: "other", name: "other", type: F64 });
  consume.locals.push({ id: "other", name: "other", type: F64, mutable: false });
  const failure: IrFunction = {
    name: "failure",
    params: [],
    locals: [],
    returnType: F64,
    loc,
    body: [{ kind: "throw", value: num(7), loc }],
  };
  module.functions.push(failure);
  immediateCall(module).args.push({ kind: "call", callee: "failure", args: [], type: F64, loc });
  const ir = workBody(module);
  const later = ir.indexOf("@sc_f_failure");
  expect(later).toBeGreaterThan(0);
  expect(ir.slice(later)).toMatch(PENDING_CHECK);
  expect(ir.slice(later)).not.toContain("@sc_rrelease_");
  failure.params.push({ localId: "items", name: "items", type: array });
  failure.locals.push({ id: "items", name: "items", type: array, mutable: false });
  failure.body.unshift({ kind: "arraySetLength", arr: ref("items", array), length: num(0), loc });
  immediateCall(module).args[1] = {
    kind: "call",
    callee: "failure",
    args: [ref("a", array)],
    type: F64,
    loc,
  };
  const owned = workBody(module);
  const mutation = owned.indexOf("@sc_bf_failure");
  expect(mutation).toBeGreaterThan(0);
  expect(owned.slice(mutation)).toMatch(PENDING_CHECK);
  expect(owned.slice(mutation)).toContain("@sc_rrelease_");
});

test("a temporary array receiver lives through its indexed lookup", () => {
  const module = immediateFixture();
  const read = immediateCall(module).args[0]!;
  if (read.kind !== "call") throw new Error("missing read");
  read.args[0] = { kind: "arrayLit", elems: [], type: array, loc };
  expect(immediateFacts(module).get(read)?.borrow).not.toBe(true);
  const ir = workBody(module);
  expect(ir.indexOf("@scr_arr_new")).toBeLessThan(ir.indexOf("@scr_arr_peek_ref"));
  expect(ir).toContain("@scr_arr_release");
  expect(ir).not.toContain("@sc_bf_read");
});

test("helper recognition is reused by multiple sites and isolated to one finalized module", () => {
  const module = immediateFixture();
  const functions = new Map(module.functions.map((fn) => [fn.name, fn]));
  const unions = new Map(module.unions!.map((union) => [union.id, union]));
  const read = immediateCall(module).args[0]!;
  const index = new OptionalArrayReads(functions, unions);
  const helper = module.functions[1]!;
  const original = helper.body;
  let bodyReads = 0;
  Object.defineProperty(helper, "body", {
    configurable: true,
    get: () => {
      bodyReads++;
      return original;
    },
  });
  for (let i = 0; i < 100; i++) expect(index.get(read)?.presentTag).toBe(0);
  expect(bodyReads).toBe(0);
  Object.defineProperty(helper, "body", { configurable: true, writable: true, value: [] });
  expect(new OptionalArrayReads(functions, unions).get(read)).toBeNull();
});

test("read descriptors never share a mutable borrowing decision between uses", () => {
  const module = immediateFixture();
  const functions = new Map(module.functions.map((fn) => [fn.name, fn]));
  const unions = new Map(module.unions!.map((union) => [union.id, union]));
  const index = new OptionalArrayReads(functions, unions);
  const read = immediateCall(module).args[0]!;
  const first = index.get(read)!;
  first.borrow = true;
  expect(index.get(read)?.borrow).toBeUndefined();
  expect(index.get(read)?.array).toBe(first.array);
});

test("recognition checks the helper result representation as well as its body", () => {
  const module = immediateFixture();
  module.functions[1]!.returnType = F64;
  const functions = new Map(module.functions.map((fn) => [fn.name, fn]));
  const unions = new Map(module.unions!.map((union) => [union.id, union]));
  expect(new OptionalArrayReads(functions, unions).get(immediateCall(module).args[0]!)).toBeNull();
});

test("lowered inline reads share the sparse-aware optional lookup", () => {
  const mod = fixture();
  const source = mod.functions[1]!.body[0]!;
  const local = mod.functions[2]!.body[0]!;
  if (source.kind !== "return" || !source.value || local.kind !== "varDecl")
    throw new Error("missing optional read");
  local.init = structuredClone(source.value);
  expect(candidates(mod).get("value")?.borrow).toBe(true);
  for (const bits of [32, 64] as const) {
    const ir = workBody(mod, bits);
    expect(ir).toContain("local.array.dense");
    expect(ir).toContain("@scr_arr_peek_ref");
    expect(ir).not.toContain("@scr_arr_get_ref");
    expect(ir).not.toContain("@scr_union_new_ref");
  }
});

test.each(["different index", "different array", "effectful operand", "different state"])(
  "inline lookup refuses a %s",
  (reason) => {
    const mod = fixture();
    const ret = mod.functions[1]!.body[0]!;
    if (ret.kind !== "return" || ret.value?.kind !== "ternary") throw new Error("missing read");
    const value = ret.value;
    if (
      value.cond.kind !== "bin" ||
      value.cond.left.kind !== "arrayState" ||
      value.then.kind !== "unionWrap" ||
      value.then.value.kind !== "arrayGet"
    )
      throw new Error("missing shape");
    if (reason === "different index") value.then.value.index = num(2);
    else if (reason === "different array") value.then.value.arr = ref("other", array);
    else if (reason === "different state") value.cond.right = num(2);
    else {
      const next: IrExpr = { kind: "incDec", localId: "i", op: "+", prefix: false, type: F64, loc };
      value.cond.left.index = next;
      value.then.value.index = next;
    }
    const reads = new OptionalArrayReads(new Map(), new Map(mod.unions!.map((u) => [u.id, u])));
    expect(reads.get(value)).toBeNull();
  },
);

/** Retype the fixture's element as a scalar and consume the read by an
 * immediate projection (`if (a[i])` / `a[i] ?? d`) instead of a local. */
function scalarFixture(elem: IrType, consumer: "truthy" | "nullish" | "local"): IrModule {
  const retype = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value, (key, field: unknown) =>
        field &&
        typeof field === "object" &&
        (field as { kind?: string }).kind === "record" &&
        (field as { shapeId?: string }).shapeId === "cell"
          ? elem
          : field,
      ),
    ) as T;
  const mod = retype(fixture());
  mod.unions = [{ id: "optional", arms: [elem, UNDEFINED_T] }];
  const work = mod.functions[2]!;
  const read: IrExpr = {
    kind: "call",
    callee: "read",
    args: [ref("a", arrayOf(elem)), ref("i", F64)],
    type: optional,
    loc,
  };
  work.returnType = elem;
  if (consumer === "truthy") {
    work.returnType = BOOL;
    work.body = [
      { kind: "return", value: { kind: "toBool", operand: read, type: BOOL, loc }, loc },
    ];
  } else if (consumer === "nullish") {
    const fallback: IrExpr =
      elem.kind === "bool" ? { kind: "boolLit", value: true, type: BOOL, loc } : num(-1);
    work.body = [
      {
        kind: "return",
        value: { kind: "nullish", left: read, right: fallback, type: elem, loc },
        loc,
      },
    ];
  } else {
    work.body = [
      { kind: "varDecl", localId: "value", init: read, loc },
      {
        kind: "return",
        value: {
          kind: "unionNarrow",
          unionId: "optional",
          tag: 0,
          value: unionValue,
          type: elem,
          loc,
        },
        loc,
      },
    ];
  }
  return mod;
}

test.each([
  [F64, "truthy"],
  [F64, "nullish"],
  [F64, "local"],
  [BOOL, "truthy"],
  [BOOL, "nullish"],
  [BOOL, "local"],
] as const)("scalar %o optional reads consumed as %s need no heap union", (elem, consumer) => {
  const mod = scalarFixture(elem, consumer);
  expect(validateModule(mod)).toEqual([]);
  for (const bits of [32, 64] as const) {
    const ir = workBody(mod, bits);
    expect(ir).not.toContain("@scr_union_new");
    expect(ir).not.toContain("@scr_union_release");
    expect(ir).not.toContain("@scr_union_get");
    // Holes, sparse and noncanonical indices keep the runtime state check.
    expect(ir).toContain("@scr_arr_state");
    expect(ir).toContain(elem.kind === "f64" ? "@scr_arr_get_f64" : "@scr_arr_get_bool");
    if (consumer !== "local") expect(ir).toContain("local.array.dense");
  }
});
