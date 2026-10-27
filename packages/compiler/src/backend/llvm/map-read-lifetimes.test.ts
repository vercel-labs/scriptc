import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";
import { emitLlvmModule } from "./emitter.js";
import { keepUnionsBoxed } from "./test-boxed-unions.js";
import {
  borrowsMapReadInputs,
  findMapReadLifetimes,
  findReadNumberMapWrites,
} from "./map-read-lifetimes.js";

const loc = { file: "map-reads.ts", start: 0, end: 1 };
const record: IrType = { kind: "record", shapeId: "cell" };
const optional: IrType = { kind: "union", unionId: "optional" };
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });

function fixture(value: IrType = record, key: IrType = F64): IrModule {
  const map: IrType = { kind: "map", key, value };
  const params = [
    { localId: "map", name: "map", type: map },
    { localId: "key", name: "key", type: key },
  ];
  const work: IrFunction = {
    name: "work",
    params,
    returnType: BOOL,
    loc,
    locals: [
      ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: true })),
      { id: "value", name: "value", type: optional, mutable: false },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "value",
        loc,
        init: {
          kind: "mapIntrinsic",
          method: "get",
          receiver: ref("map", map),
          args: [ref("key", key)],
          type: optional,
          loc,
        },
      },
      {
        kind: "return",
        loc,
        value: {
          kind: "unionIsTag",
          value: ref("value", optional),
          unionId: "optional",
          tag: 0,
          negated: false,
          type: BOOL,
          loc,
        },
      },
    ],
  };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: [{ id: "cell", fields: [{ name: "x", type: F64 }] }],
    unions: [{ id: "optional", arms: [value, UNDEFINED_T] }],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }, work],
  };
}

function facts(mod: IrModule) {
  const lifetimes = analyzeCallLifetimes(new Map(mod.functions.map((fn) => [fn.name, fn])));
  return findMapReadLifetimes(
    mod.functions[1]!,
    new Map(mod.unions!.map((union) => [union.id, union])),
    lifetimes,
  );
}

function body(mod: IrModule, bits: 32 | 64 = 64): string {
  expect(validateModule(mod)).toEqual([]);
  // Record values are nullable pointers; the other fixtures pin stack boxes.
  const nullable = mod.unions?.[0]?.arms[0]?.kind === "record";
  const llvm = emitLlvmModule(nullable ? mod : keepUnionsBoxed(mod), { pointerBits: bits });
  return /^define internal [^\n]*@sc_(?:b)?f_work(?:\.i32)?\([^]*?^}/m.exec(llvm)![0];
}

test("local map results keep scalar and owned reference payloads without heap wrappers on both ABIs", () => {
  const keys: IrType[] = [F64, STRING];
  const values: IrType[] = [F64, BOOL, STRING];
  for (const key of keys)
    for (const value of values) {
      const mod = fixture(value, key);
      expect(facts(mod).locals.has("value")).toBe(true);
      for (const bits of [32, 64] as const) {
        const ir = body(mod, bits);
        expect(ir).toContain("alloca %ScrUnion");
        expect(ir).toContain("select i1");
        expect(ir).not.toContain("@scr_union_new");
        expect(ir).not.toContain("@scr_union_release");
        if (key === F64) {
          // Number keys read the entry's slot inline; booleans are stored 0/1.
          expect(ir).toContain("call ptr @sc_map_entry_f64(");
          expect(ir).not.toContain("@scr_map_get_");
        } else {
          // String keys read every value kind through the entry (behind the
          // inline absent-key filter); reference values retain inline.
          expect(ir).toContain("call ptr @sc_map_entry_str(");
          expect(ir).not.toContain("@scr_map_get_");
        }
        // Nothing can change the map before the tag test, so a reference
        // result is the entry's own (findMapReadBorrows): no retain or release.
        if (value === STRING) {
          expect(ir).not.toContain("@scr_str_retain");
          expect(ir).not.toContain("@scr_str_release");
        }
      }
    }
});

test("nullable record results are the looked-up pointer itself on both ABIs", () => {
  const mod = fixture(record);
  for (const bits of [32, 64] as const) {
    const ir = body(mod, bits);
    expect(ir).not.toContain("%ScrUnion");
    expect(ir).not.toContain("@scr_union_");
    expect(ir).toMatch(/icmp (?:eq|ne) ptr %\w+, null/);
    // The pointer is the entry's own reference until the tag test.
    expect(ir).not.toContain("@sc_rrelease_");
  }
});

test("direct helper arguments have independent stack boxes and call-scoped payload owners", () => {
  const mod = fixture(STRING);
  const fn = mod.functions[1]!;
  const init = fn.body[0]!;
  if (init.kind !== "varDecl" || !init.init) throw new Error("missing lookup");
  const helper: IrFunction = {
    name: "inspect",
    loc,
    returnType: BOOL,
    params: ["left", "right"].map((id) => ({ localId: id, name: id, type: optional })),
    locals: ["left", "right"].map((id) => ({ id, name: id, type: optional, mutable: false })),
    body: [
      {
        kind: "return",
        loc,
        value: {
          kind: "unionIsTag",
          value: ref("left", optional),
          unionId: "optional",
          tag: 0,
          negated: false,
          type: BOOL,
          loc,
        },
      },
    ],
  };
  fn.body = [
    {
      kind: "return",
      loc,
      value: {
        kind: "call",
        callee: helper.name,
        args: [init.init, { ...init.init }],
        type: BOOL,
        loc,
      },
    },
  ];
  mod.functions.push(helper);
  expect(facts(mod).arguments.size).toBe(2);
  const ir = body(mod);
  expect(ir.match(/alloca %ScrUnion/g)).toHaveLength(2);
  expect(ir).not.toContain("@scr_union_new");
  expect(ir).not.toContain("@scr_union_release");
  const call = ir.indexOf("@sc_bf_inspect");
  expect(call).toBeGreaterThan(0);
  expect(ir.slice(call).match(/call void @scr_str_release\(/g)).toHaveLength(2);
});

test("escaping local boxes retain ordinary ownership", () => {
  const mod = fixture(STRING);
  const fn = mod.functions[1]!;
  fn.returnType = optional;
  fn.body[1] = { kind: "return", value: ref("value", optional), loc };
  expect(facts(mod).locals.size).toBe(0);
  expect(body(mod)).toContain("@scr_union_new_ref");
});

test("stored union boxes and dynamic views stay on the general path", () => {
  const union: IrType = { kind: "union", unionId: "stored" };
  const mod = fixture(union);
  mod.unions!.push({ id: "stored", arms: [record, UNDEFINED_T] });
  expect(facts(mod).locals.size).toBe(0);
  expect(facts(fixture(record, DYN)).locals.size).toBe(0);
  expect(facts(fixture(DYN)).locals.size).toBe(0);
});

test("typed read helpers borrow string keys while mutations retain the owned convention", () => {
  const mod = fixture(record, STRING);
  const fn = mod.functions[1]!;
  const init = fn.body[0]!;
  if (init.kind !== "varDecl" || init.init?.kind !== "mapIntrinsic")
    throw new Error("missing lookup");
  const keyFacts = () =>
    analyzeCallLifetimes(new Map(mod.functions.map((f) => [f.name, f]))).parameters.get(fn.name);
  expect(keyFacts()).toEqual(new Set([1]));
  const ir = body(mod);
  expect(ir).not.toContain("@scr_map_retain");
  expect(ir).not.toContain("@scr_str_retain");
  expect(ir).not.toContain("@scr_str_release");
  const mutation: IrExpr = { ...init.init, method: "delete", type: BOOL };
  expect(borrowsMapReadInputs(mutation)).toBe(false);
  fn.body.push({ kind: "exprStmt", expr: mutation, loc });
  expect(keyFacts()).toBeUndefined();
});

test("reference-preserving keys borrow receivers across unrelated later assignments", () => {
  const mod = fixture();
  const fn = mod.functions[1]!;
  const init = fn.body[0]!;
  if (init.kind !== "varDecl" || init.init?.kind !== "mapIntrinsic")
    throw new Error("missing lookup");
  init.init.args[0] = { kind: "call", callee: "key", args: [], type: F64, loc };
  mod.functions.push({
    name: "key",
    params: [],
    locals: [],
    body: [{ kind: "return", value: { kind: "numLit", value: 0, type: F64, loc }, loc }],
    returnType: F64,
    loc,
  });
  expect(body(mod)).not.toContain("@scr_map_retain_v");
  const work = mod.functions[1]!;
  const type = work.params[0]!.type;
  work.body.splice(1, 0, { kind: "assign", localId: "map", value: ref("map", type), loc });
  const ir = body(mod);
  expect(ir.indexOf("@scr_map_retain_v")).toBeGreaterThan(0);
  expect(ir.indexOf("@scr_map_retain_v")).toBeGreaterThan(ir.indexOf("@sc_f_key"));
});

test("string-key lookups test the absent-key filter inline on 64-bit targets only", () => {
  const mod = keepUnionsBoxed(fixture(F64, STRING));
  expect(validateModule(mod)).toEqual([]);
  const helper = (bits: 32 | 64) =>
    /^define internal ptr @sc_map_entry_str(?:\.i32)?\([^]*?^}/m.exec(
      emitLlvmModule(mod, { pointerBits: bits }),
    )![0];
  const wide = helper(64);
  // The cached hash is the capacity word's high half; the filter bits are its
  // bits 44..55 (scr_map.c scr_map_filter_bits). %ScrMapIx field 10 is the filter.
  expect(wide).toContain("getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 10");
  expect(wide).toContain("icmp uge i64 %cap, 4294967296");
  expect(wide).toContain("lshr i64 %cap, 44");
  expect(wide).toContain("lshr i64 %cap, 50");
  expect(wide).toContain("ret ptr null");
  expect(wide).toContain("call ptr @scr_map_entry_str(ptr %m, ptr %k)");
  // 32-bit strings cache no hash: every lookup takes the runtime.
  const narrow = helper(32);
  expect(narrow).not.toContain("%ScrMapIx");
  expect(narrow).toContain("call ptr @scr_map_entry_str(ptr %m, ptr %k)");
});

test("number-key writes look the key up inline only after a read of the same collection and key", () => {
  const map: IrType = { kind: "map", key: F64, value: F64 };
  const other: IrType = { kind: "map", key: F64, value: F64 };
  const set: IrType = { kind: "set", elem: F64 };
  const call = (
    kind: "mapIntrinsic" | "setIntrinsic",
    method: string,
    receiver: IrExpr,
    args: IrExpr[],
    type: IrType,
  ): IrExpr => ({ kind, method, receiver, args, type, loc }) as IrExpr;
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const k = ref("k", F64);
  const count = call(
    "mapIntrinsic",
    "set",
    ref("map", map),
    [
      k,
      {
        kind: "bin",
        op: "+",
        left: {
          kind: "nullish",
          left: call("mapIntrinsic", "get", ref("map", map), [k], optional),
          right: num(0),
          type: F64,
          loc,
        },
        right: num(1),
        type: F64,
        loc,
      } as IrExpr,
    ],
    VOID,
  );
  const afterRead = call("mapIntrinsic", "set", ref("map", map), [ref("j", F64), num(1)], VOID);
  const guarded = call("setIntrinsic", "add", ref("seen", set), [k], VOID);
  const unread = call("mapIntrinsic", "set", ref("map", map), [num(7), num(1)], VOID);
  const elsewhere = call(
    "mapIntrinsic",
    "set",
    ref("map", map),
    [k, call("mapIntrinsic", "get", ref("other", other), [k], F64)],
    VOID,
  );
  const fn: IrFunction = {
    name: "work",
    params: [],
    returnType: VOID,
    loc,
    locals: [],
    body: [
      { kind: "exprStmt", expr: count, loc },
      {
        kind: "varDecl",
        localId: "v",
        init: call("mapIntrinsic", "get", ref("map", map), [ref("j", F64)], optional),
        loc,
      },
      { kind: "exprStmt", expr: afterRead, loc },
      {
        kind: "if",
        cond: {
          kind: "unary",
          op: "!",
          operand: call("setIntrinsic", "has", ref("seen", set), [k], BOOL),
          type: BOOL,
          loc,
        },
        then: [{ kind: "exprStmt", expr: guarded, loc }],
        else_: null,
        loc,
      },
      { kind: "exprStmt", expr: unread, loc },
      { kind: "exprStmt", expr: elsewhere, loc },
    ],
  };
  const writes = findReadNumberMapWrites(fn);
  expect(writes.has(count)).toBe(true);
  expect(writes.has(afterRead)).toBe(true);
  expect(writes.has(guarded)).toBe(false);
  expect(writes.has(unread)).toBe(false);
  expect(writes.has(elsewhere)).toBe(false);
});

test("a number-key write after a read stores into the found entry and appends through the runtime", () => {
  const map: IrType = { kind: "map", key: F64, value: F64 };
  const params = [
    { localId: "map", name: "map", type: map },
    { localId: "k", name: "k", type: F64 },
  ];
  const work: IrFunction = {
    name: "work",
    params,
    returnType: BOOL,
    loc,
    locals: [
      ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: true })),
      { id: "present", name: "present", type: BOOL, mutable: false },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "present",
        init: {
          kind: "mapIntrinsic",
          method: "has",
          receiver: ref("map", map),
          args: [ref("k", F64)],
          type: BOOL,
          loc,
        },
        loc,
      },
      {
        kind: "exprStmt",
        expr: {
          kind: "mapIntrinsic",
          method: "set",
          receiver: ref("map", map),
          args: [ref("k", F64), { kind: "numLit", value: 2, type: F64, loc }],
          type: VOID,
          loc,
        },
        loc,
      },
      { kind: "return", value: ref("present", BOOL), loc },
    ],
  };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: [],
    unions: [],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }, work],
  };
  expect(validateModule(mod)).toEqual([]);
  for (const bits of [32, 64] as const) {
    const ir = emitLlvmModule(mod, { pointerBits: bits });
    const body = /^define internal [^\n]*@sc_(?:b)?f_work\([^]*?^}/m.exec(ir)![0];
    expect(body.match(/call ptr @sc_map_entry_f64\(/g)).toHaveLength(2);
    expect(body).toMatch(
      /mapn\.set\.hit\d*:\n\s+(%t\d+) = getelementptr inbounds %ScrMapEntry, ptr %t\d+, i32 0, i32 1\n\s+store i64 %t\d+, ptr \1\n/,
    );
    expect(body).toContain("call void @scr_map_set_f64_f64(");
  }
});
