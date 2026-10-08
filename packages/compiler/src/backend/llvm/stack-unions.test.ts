import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  VOID,
  UNDEFINED_T,
  NULL_T,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import { canStackUnion } from "./stack-unions.js";

const loc = { file: "stack-unions.ts", start: 0, end: 0 };
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
const call = (callee: string, args: IrExpr[], type: IrType = F64): IrExpr => ({
  kind: "call",
  callee,
  args,
  type,
  loc,
});
const wrap = (value: IrExpr, tag = 0): IrExpr => ({
  kind: "unionWrap",
  value,
  tag,
  unionId: "optional",
  type: optional,
  loc,
});
const narrow = (value: IrExpr, type: IrType): IrExpr => ({
  kind: "unionNarrow",
  value,
  unionId: "optional",
  tag: 0,
  type,
  loc,
});
const effect = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const fresh = (): IrExpr => ({
  kind: "recordLit",
  fields: [{ name: "x", value: num(7) }],
  type: record,
  loc,
});

function fixture(arm: IrType = record): IrModule {
  const reader: IrFunction = {
    name: "read",
    params: [{ localId: "value", name: "value", type: optional }],
    returnType: arm,
    loc,
    locals: [{ id: "value", name: "value", type: optional, mutable: true }],
    body: [ret(narrow(ref("value"), arm))],
  };
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    records: [{ id: "cell", fields: [{ name: "x", type: F64 }] }],
    unions: [{ id: "optional", arms: [arm, UNDEFINED_T, NULL_T] }],
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }, reader],
  };
}

function body(ir: string, name: string): string {
  const found = new RegExp(`^define internal [^\\n]*@${name}\\([^]*?^}`, "m").exec(ir);
  expect(found, name).not.toBeNull();
  return found![0];
}

function emit(mod: IrModule, pointerBits: 32 | 64 = 64): string {
  expect(validateModule(mod)).toEqual([]);
  return emitLlvmModule(mod, { pointerBits });
}

function declareLocal(mod: IrModule, init: IrExpr): void {
  const fn = mod.functions[0]!;
  fn.locals.push({ id: "item", name: "item", type: optional, mutable: false });
  fn.body.push({ kind: "varDecl", localId: "item", init, loc });
}

test("reference arguments use a private box and keep an independent payload owner", () => {
  const mod = fixture();
  mod.functions[0]!.body.push(effect(call("read", [wrap(fresh())], record)));
  for (const width of [32, 64] as const) {
    const ir = emit(mod, width),
      main = body(ir, "sc_f_main");
    expect(main).toContain("alloca %ScrUnion");
    expect(main).toContain("@sc_bf_read(");
    expect(main).not.toContain("@scr_union_new_ref");
    expect(main).not.toContain("@scr_union_release");
    expect(main).toContain("@sc_rrelease_");
    const reader = body(ir, "sc_bf_read");
    expect(reader).not.toContain("@scr_union_release");
    expect(reader).toContain("@sc_rretain_");
  }
});

test("owned adapters release borrowed parameters while preserving returned payloads", () => {
  const mod = fixture();
  const ir = emit(mod);
  const adapter = body(ir, "sc_f_read");
  expect(adapter).toContain("%result = call ptr @sc_bf_read(ptr %p0)");
  expect(adapter).toContain("call void @scr_union_release(ptr %p0)");
  expect(adapter).toContain("ret ptr %result");
  expect(adapter.indexOf("@sc_bf_read")).toBeLessThan(adapter.indexOf("@scr_union_release"));
});

test("plain function values retain the owned ABI", () => {
  const mod = fixture();
  mod.functions[0]!.body.push(
    effect({
      kind: "closure",
      fnName: "read",
      captures: [],
      type: funcOf([optional], record),
      loc,
    }),
  );
  const ir = emit(mod);
  const wrapper = body(ir, "sc_w_read");
  expect(wrapper).toContain("@sc_f_read(");
  expect(wrapper).not.toContain("@sc_bf_read(");
});

test("local construction releases its payload at lexical exit without freeing the stack box", () => {
  const mod = fixture();
  declareLocal(mod, wrap(fresh()));
  mod.functions[0]!.body.push(effect(call("read", [ref("item")], record)));
  const main = body(emit(mod), "sc_f_main");
  expect(main).toContain("alloca %ScrUnion");
  expect(main).not.toMatch(/@scr_union_(?:new|retain|release)/);
  expect(main).toContain("@sc_rrelease_");
});

test.each(["return", "alias", "capture", "store"])(
  "keeps a %s consumer on the ordinary heap path",
  (reason) => {
    const mod = fixture();
    const work: IrFunction = {
      name: "work",
      params: [],
      locals: [],
      body: [],
      returnType: VOID,
      loc,
    };
    mod.functions.unshift(work);
    declareLocal(mod, wrap(fresh()));
    if (reason === "return") {
      work.returnType = optional;
      work.body.push(ret(ref("item")));
    }
    if (reason === "alias") {
      work.locals.push({ id: "alias", name: "alias", type: optional, mutable: false });
      work.body.push({ kind: "varDecl", localId: "alias", init: ref("item"), loc });
    }
    if (reason === "capture") {
      work.locals[0]!.boxed = true;
      mod.functions.push({
        name: "lifted",
        captures: [{ localId: "item", name: "item", type: optional }],
        params: [],
        locals: [{ id: "item", name: "item", type: optional, mutable: false, boxed: true }],
        body: [ret(ref("item"))],
        returnType: optional,
        loc,
      });
      work.body.push(
        effect({
          kind: "closure",
          fnName: "lifted",
          captures: ["item"],
          type: funcOf([], optional),
          loc,
        }),
      );
    }
    if (reason === "store") {
      mod.globals = [{ id: "%g.saved", name: "saved", type: optional, mutable: true }];
      work.body.push({ kind: "assign", localId: "%g.saved", value: ref("item"), loc });
    }
    expect(body(emit(mod), "sc_f_work")).toContain("@scr_union_new_ref");
  },
);

test("forwarded parameters never retain or release a borrowed stack box", () => {
  const mod = fixture();
  const outer: IrFunction = {
    name: "outer",
    params: [{ localId: "value", name: "value", type: optional }],
    locals: [{ id: "value", name: "value", type: optional, mutable: true }],
    body: [ret(call("read", [ref("value")], record))],
    returnType: record,
    loc,
  };
  mod.functions.push(outer);
  const ir = emit(mod),
    forwarded = body(ir, "sc_bf_outer");
  expect(forwarded).toContain("@sc_bf_read(");
  expect(forwarded).not.toMatch(/@scr_union_(?:retain|release)/);
  expect(body(ir, "sc_f_outer")).toContain("@scr_union_release");
});

test("mixed signatures transfer owned arguments and retain only borrowed snapshots", () => {
  const mod = fixture();
  const fn = mod.functions[1]!;
  fn.params.push({ localId: "saved", name: "saved", type: optional });
  fn.locals.push({ id: "saved", name: "saved", type: optional, mutable: true });
  fn.returnType = optional;
  fn.body = [
    effect(narrow(ref("value"), record)),
    { kind: "assign", localId: "saved", value: wrap(fresh()), loc },
    ret(ref("saved")),
  ];
  mod.functions[0]!.body.push(effect(call("read", [wrap(fresh()), wrap(fresh())], optional)));
  const ir = emit(mod),
    main = body(ir, "sc_f_main"),
    adapter = body(ir, "sc_f_read");
  expect(main.match(/call ptr @scr_union_new_ref/g)).toHaveLength(1);
  expect(main).toContain("alloca %ScrUnion");
  expect(adapter).toContain("@scr_union_release(ptr %p0)");
  expect(adapter).not.toContain("@scr_union_release(ptr %p1)");
  expect(body(ir, "sc_bf_read")).toContain("@scr_union_release");
});

test("a shared argument expression gets a stack box only at a projection-only position", () => {
  const mod = fixture(),
    fn = mod.functions[1]!;
  fn.params.push({ localId: "saved", name: "saved", type: optional });
  fn.locals.push({ id: "saved", name: "saved", type: optional, mutable: true });
  fn.returnType = optional;
  fn.body = [effect(narrow(ref("value"), record)), ret(ref("saved"))];
  const argument = wrap(fresh());
  mod.functions[0]!.body.push(effect(call("read", [argument, argument], optional)));
  const ir = emit(mod),
    main = body(ir, "sc_f_main");
  expect(main.match(/call ptr @scr_union_new_ref/g)).toHaveLength(1);
  expect(main.match(/alloca %ScrUnion/g)).toHaveLength(1);
  expect(body(ir, "sc_bf_read")).toContain("@scr_union_retain_v");
  expect(body(ir, "sc_bf_read")).not.toContain("@scr_union_release");
  expect(body(ir, "sc_f_read")).toContain("@scr_union_release(ptr %p1)");
});

test("mutable caller bindings take owned snapshots before later arguments", () => {
  const mod = fixture();
  declareLocal(mod, wrap(fresh()));
  mod.functions[0]!.locals[0]!.mutable = true;
  const fn = mod.functions[1]!;
  fn.params.push({ localId: "count", name: "count", type: F64 });
  fn.locals.push({ id: "count", name: "count", type: F64, mutable: true });
  const second: IrExpr = {
    kind: "seqExpr",
    type: F64,
    loc,
    stmts: [{ kind: "assign", localId: "item", value: wrap(fresh()), loc }],
    result: num(),
  };
  mod.functions[0]!.body.push(effect(call("read", [ref("item"), second], record)));
  const main = body(emit(mod), "sc_f_main");
  expect(main).toContain("@scr_union_retain_v");
  expect(main).toContain("@scr_union_new_ref");
  expect(main).not.toContain("alloca %ScrUnion");
  expect(main.indexOf("@scr_union_retain_v")).toBeLessThan(main.indexOf("@sc_bf_read"));
  expect(main.lastIndexOf("@scr_union_release")).toBeGreaterThan(main.indexOf("@sc_bf_read"));
});

test("globals borrow across preserving calls and snapshot across mutations", () => {
  const mod = fixture();
  mod.globals = [{ id: "%g.item", name: "item", type: optional, mutable: false }];
  mod.functions[0]!.body.push(effect(call("read", [ref("%g.item")], record)));
  expect(body(emit(mod), "sc_f_main")).not.toContain("@scr_union_retain_v");
  mod.globals![0]!.mutable = true;
  mod.functions[1]!.body.unshift({ kind: "assign", localId: "%g.item", value: wrap(fresh()), loc });
  const main = body(emit(mod), "sc_f_main");
  expect(main).toContain("@scr_union_retain_v");
  expect(main).toContain("@scr_union_release");
});

test("scalar payloads initialize their complete ABI slot on both pointer widths", () => {
  for (const value of [num(-0), { kind: "boolLit", value: true, type: BOOL, loc } as IrExpr]) {
    const mod = fixture(value.type);
    mod.functions[0]!.body.push(effect(call("read", [wrap(value)], value.type)));
    for (const width of [32, 64] as const) {
      const main = body(emit(mod, width), "sc_f_main");
      expect(main).toContain("alloca %ScrUnion");
      expect(main).not.toMatch(/@scr_union_new_(?:bool|f64)/);
      expect(main).toContain(value.type.kind === "bool" ? "store i64" : "store double");
    }
  }
});

test("unit arms initialize tags and slots without acquiring payload ownership", () => {
  for (const [unit, type, tag] of [
    ["undefined", UNDEFINED_T, 1],
    ["null", NULL_T, 2],
  ] as const) {
    const mod = fixture();
    mod.functions[1]!.returnType = BOOL;
    mod.functions[1]!.body = [
      ret({
        kind: "unionIsTag",
        value: ref("value"),
        unionId: "optional",
        tag,
        negated: false,
        type: BOOL,
        loc,
      }),
    ];
    mod.functions[0]!.body.push(
      effect(call("read", [wrap({ kind: "unitLit", unit, type, loc }, tag)], BOOL)),
    );
    const main = body(emit(mod), "sc_f_main");
    expect(main).toContain("store i64 0");
    expect(main).toContain(`store i32 ${tag}`);
    expect(main).not.toMatch(/@scr_union_(?:new|retain|release)/);
  }
});

test("checked payload errors retain caller cleanup and owned adapter cleanup", () => {
  const mod = fixture();
  const reader = mod.functions[1]!;
  reader.body.unshift(
    effect({
      kind: "libCall",
      fn: "error.nodeThrow",
      type: record,
      loc,
      args: [
        num(),
        { kind: "strLit", value: "", type: STRING, loc },
        { kind: "strLit", value: "failure", type: STRING, loc },
      ],
    }),
  );
  mod.functions[0]!.body.push(effect(call("read", [wrap(fresh())], record)));
  const ir = emit(mod),
    main = body(ir, "sc_f_main");
  expect(main).toContain("@scr_exc_pending");
  expect(main).toMatch(/exc\.u\d+:\n\s+call void @sc_rrelease_/);
  expect(main).toContain("@sc_rrelease_");
  expect(body(ir, "sc_bf_read")).not.toContain("@scr_union_release");
  expect(body(ir, "sc_f_read")).toContain("@scr_union_release");
});

test("representation matching rejects absent, mismatched and effectful unit arms", () => {
  const mod = fixture();
  const unions = new Map(mod.unions!.map((union) => [union.id, union]));
  expect(canStackUnion(wrap(fresh()), unions)).toBe(true);
  expect(canStackUnion(wrap(num()), unions)).toBe(false);
  expect(canStackUnion(wrap(fresh(), 9), unions)).toBe(false);
  expect(canStackUnion(ref("value"), unions)).toBe(false);
  expect(canStackUnion(wrap(fresh()), new Map())).toBe(false);
  const effectful: IrExpr = {
    kind: "seqExpr",
    stmts: [effect(num())],
    result: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
    type: UNDEFINED_T,
    loc,
  };
  expect(canStackUnion(wrap(effectful, 1), unions)).toBe(false);
});

test("adjacent throwing calls release argument snapshots before the next call", () => {
  const mod = fixture();
  const reader = mod.functions[1]!;
  reader.returnType = F64;
  reader.body = [
    ret({
      kind: "recordGet",
      obj: narrow(ref("value"), record),
      shapeId: "cell",
      field: "x",
      type: F64,
      loc,
    }),
  ];
  reader.body.unshift(
    effect({
      kind: "libCall",
      fn: "error.nodeThrow",
      type: record,
      loc,
      args: [
        num(),
        { kind: "strLit", value: "", type: STRING, loc },
        { kind: "strLit", value: "failure", type: STRING, loc },
      ],
    }),
  );
  mod.globals = [{ id: "%g.item", name: "item", type: optional, mutable: true }];
  reader.body.unshift({ kind: "assign", localId: "%g.item", value: wrap(fresh()), loc });
  const calls = Array.from({ length: 80 }, () => call("read", [ref("%g.item")], F64));
  mod.functions[0]!.body = [
    effect({ kind: "arrayLit", elems: calls, type: { kind: "array", elem: F64 }, loc }),
  ];
  const main = body(emit(mod), "sc_f_main");
  expect(main.match(/call ptr @scr_union_retain_v/g)).toHaveLength(calls.length);
  // Each snapshot has one normal release and one exceptional release.
  // Earlier calls must not add owners to every later exception edge.
  expect(main.match(/call void @scr_union_release/g)).toHaveLength(calls.length * 2);
  const first = main.indexOf("@sc_bf_read"),
    second = main.indexOf("@sc_bf_read", first + 1);
  expect(main.slice(first, second)).toContain("@scr_union_release");
});

test("a borrowed call returns a new owner before releasing argument snapshots", () => {
  const mod = fixture();
  mod.functions[1]!.body.unshift({ kind: "assign", localId: "%g.item", value: wrap(fresh()), loc });
  mod.globals = [{ id: "%g.item", name: "item", type: optional, mutable: true }];
  mod.functions[0]!.body.push(effect(call("read", [ref("%g.item")], record)));
  const main = body(emit(mod), "sc_f_main");
  const callAt = main.indexOf("@sc_bf_read"),
    unionReleaseAt = main.indexOf("@scr_union_release");
  const payloadReleaseAt = main.indexOf("@sc_rrelease_");
  expect(callAt).toBeLessThan(unionReleaseAt);
  expect(unionReleaseAt).toBeLessThan(payloadReleaseAt);
  expect(main.match(/call void @sc_rrelease_/g)).toHaveLength(1);
});
