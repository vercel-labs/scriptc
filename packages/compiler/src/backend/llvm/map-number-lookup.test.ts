import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "map-iteration.ts", start: 0, end: 1 };
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });

/** work(map, i): the key (or, for `read: "value"`, the value) at a live
 * index, after the walk's start and count reads the for-of desugar makes. */
function fixture(key: IrType, value: IrType, read: "key" | "value"): IrModule {
  const map: IrType = { kind: "map", key, value };
  const step = (method: string, args: IrExpr[], type: IrType): IrExpr =>
    ({ kind: "mapIntrinsic", method, receiver: ref("map", map), args, type, loc }) as IrExpr;
  const result = read === "key" ? key : value;
  const body: IrStmt[] = [
    { kind: "varDecl", localId: "start", init: step("iterStart", [], F64), loc },
    { kind: "varDecl", localId: "count", init: step("iterCount", [], F64), loc },
    {
      kind: "if",
      cond: step("iterLive", [ref("i", F64)], BOOL),
      then: [
        {
          kind: "return",
          value: step(read === "key" ? "iterKey" : "iterValue", [ref("i", F64)], result),
          loc,
        },
      ],
      else_: null,
      loc,
    },
    {
      kind: "return",
      value: step(read === "key" ? "iterKey" : "iterValue", [ref("start", F64)], result),
      loc,
    },
  ];
  const params = [
    { localId: "map", name: "map", type: map },
    { localId: "i", name: "i", type: F64 },
  ];
  const work: IrFunction = {
    name: "work",
    params,
    returnType: result,
    loc,
    locals: [
      ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: true })),
      { id: "start", name: "start", type: F64, mutable: false },
      { id: "count", name: "count", type: F64, mutable: false },
    ],
    body,
  };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: [],
    unions: [],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }, work],
  };
}

function emitted(mod: IrModule, bits: 32 | 64): { work: string; module: string } {
  expect(validateModule(mod)).toEqual([]);
  const module = emitLlvmModule(mod, { pointerBits: bits });
  const work = /^define internal [^\n]*@sc_(?:b)?f_work(?:\.i32)?\([^]*?^}/m.exec(module)![0];
  return { work, module };
}

test("iteration steps read the entries array inline on both ABIs", () => {
  for (const bits of [32, 64] as const) {
    const { work, module } = emitted(fixture(STRING, F64, "value"), bits);
    // Field 8 is the entry count and 11 the entries array; a zero hash
    // (entry field 2) marks a tombstone.
    expect(module).toMatch(/^define internal ptr @sc_map_iter_entry\(ptr %m, double %i\)/m);
    expect(module).toContain(`getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 8`);
    expect(module).toContain(`getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 11`);
    expect(module).toContain(`getelementptr inbounds %ScrMapEntry, ptr %e, i32 0, i32 2`);
    expect(module).toContain(`%n = load i32, ptr %np`);
    // The walk's start comes from the runtime, which skips a deleted prefix.
    expect(work).toContain("call double @scr_map_iter_start(");
    expect(work).toContain("call double @sc_map_iter_count(");
    expect(work).toContain("call ptr @sc_map_iter_entry(");
    expect(work).not.toContain("@scr_map_iter_live");
    expect(work).not.toContain("@scr_map_iter_count");
    // The value loads from field 1 of a live entry; the runtime accessor is
    // only the fallback for an index the guard excludes.
    expect(work).toContain("getelementptr inbounds %ScrMapEntry, ptr");
    expect(work).toMatch(/i32 0, i32 1\n\s+%t\d+ = load double/);
    expect(work).toContain("call double @scr_map_iter_val_f64(");
  }
});

test("string keys and reference values are retained inline, boolean slots compare against zero", () => {
  const key = emitted(fixture(STRING, F64, "key"), 64).work;
  expect(key).toMatch(/i32 0, i32 0\n\s+%t\d+ = load ptr/);
  expect(key).toContain("@scr_str_retain");
  expect(key).toContain("call ptr @scr_map_iter_key_str(");

  const flag = emitted(fixture(F64, BOOL, "value"), 64).work;
  expect(flag).toMatch(/load i64, ptr %t\d+\n\s+%t\d+ = icmp ne i64 %t\d+, 0/);
  expect(flag).toContain("call i1 @scr_map_iter_val_bool(");

  const text = emitted(fixture(F64, STRING, "value"), 64).work;
  expect(text).toContain("@scr_str_retain");
  expect(text).toContain("call ptr @scr_map_iter_val_ref(");
});

/** work(map, k): map.has(k) on a number-keyed map. */
function lookupFixture(key: IrExpr = ref("k", F64)): IrModule {
  const map: IrType = { kind: "map", key: F64, value: F64 };
  const params = [
    { localId: "map", name: "map", type: map },
    { localId: "k", name: "k", type: F64 },
  ];
  const has: IrExpr = {
    kind: "mapIntrinsic",
    method: "has",
    receiver: ref("map", map),
    args: [key],
    type: BOOL,
    loc,
  };
  const work: IrFunction = {
    name: "work",
    params,
    returnType: BOOL,
    loc,
    locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: true })),
    body: [{ kind: "return", value: has, loc }],
  };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: [],
    unions: [],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }, work],
  };
}

test("hashed number-key lookups probe inline and call the runtime only for wide tables", () => {
  for (const bits of [32, 64] as const) {
    const sz = bits === 64 ? "i64" : "i32";
    const { work, module } = emitted(lookupFixture(), bits);
    expect(work).toContain("call ptr @sc_map_entry_f64(");
    const helper = /^define internal ptr @sc_map_entry_f64\(ptr %m, double %k\)[^]*?^}/m.exec(
      module,
    )![0];
    expect(helper).toContain("call ptr @sc_map_entry_f64_hashed(ptr %m, double %k)");
    const hashed =
      /^define internal ptr @sc_map_entry_f64_hashed\(ptr %m, double %k\) noinline [^]*?^}/m.exec(
        module,
      )![0];
    // The SameValueZero key word (canonical NaN, +0 for -0) and the
    // scr_key_mix multipliers 0xbf58476d1ce4e5b9 and 0x94d049bb133111eb.
    expect(hashed).toContain("select i1 %nan, i64 9221120237041090560, i64 %kzb");
    expect(hashed).toContain("mul i64 %x1, -4658895280553007687");
    expect(hashed).toContain("mul i64 %x3, -7723592293110705685");
    // Filter (field 10) before the small-map scan of the entry count (field
    // 8) only, and compact buckets (fields 13 and 14) tagged with the hash's
    // top byte.
    expect(hashed).toContain("br i1 %linear, label %filter, label %buckets");
    expect(hashed).toContain("getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 10");
    expect(hashed).toContain(`load i32, ptr %nep`);
    expect(hashed).toContain(`load i32, ptr %nbp`);
    expect(hashed).toContain("getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 14");
    expect(hashed).toContain("and i32 %ht32, -16777216");
    expect(hashed).toContain(`icmp ugt ${sz} %nb, 16777216`);
    expect(hashed).toContain(
      "call ptr @scr_map_entry_f64(ptr %m, double %k) memory(read) nounwind willreturn",
    );
  }
});

test("a key with an integer view tests the direct index on the integer", () => {
  for (const bits of [32, 64] as const) {
    const sz = bits === 64 ? "i64" : "i32";
    const integral = emitted(lookupFixture({ kind: "numLit", value: 12, type: F64, loc }), bits);
    expect(integral.work).toMatch(/call ptr @sc_map_entry_f64_int\(ptr %\S+, i64 12, double /);
    const helper =
      /^define internal ptr @sc_map_entry_f64_int\(ptr %m, i64 %ki, double %k\)[^]*?^}/m.exec(
        integral.module,
      )![0];
    // An unsigned compare also rejects negative keys; the hashed probe takes
    // the integer.
    expect(helper).toContain("icmp ult i64 %ki, %nd");
    expect(helper).toContain(`getelementptr inbounds i32, ptr %dense, ${sz} %i`);
    expect(helper).toContain("call ptr @sc_map_entry_f64_hashed_int(ptr %m, i64 %ki)");
    expect(helper).not.toContain("fptosi");
    // Its key word is the integer's double, which needs no NaN or -0
    // normalization; the runtime lookup gets that double.
    const hashed =
      /^define internal ptr @sc_map_entry_f64_hashed_int\(ptr %m, i64 %ki\) noinline [^]*?^}/m.exec(
        integral.module,
      )![0];
    expect(hashed).toContain("sitofp i64 %ki to double");
    expect(hashed).not.toContain("fcmp");
    expect(hashed).toContain("mul i64 %x1, -4658895280553007687");
    expect(hashed).toContain(
      "call ptr @scr_map_entry_f64(ptr %m, double %kf) memory(read) nounwind willreturn",
    );
    // A fractional key and a key without a proof keep the double lookup.
    for (const key of [{ kind: "numLit", value: 0.5, type: F64, loc } as IrExpr, ref("k", F64)]) {
      const { work } = emitted(lookupFixture(key), bits);
      expect(work).toContain("call ptr @sc_map_entry_f64(");
      expect(work).not.toContain("@sc_map_entry_f64_int(");
    }
  }
});

test("a key view converted in a branch is not reused by a later lookup of the same constant", () => {
  // work(map, k, taken): if (taken) return map.has((k = 2 ** 40)); return map.has(2 ** 40).
  const wide = 2 ** 40;
  const mod = lookupFixture();
  const work = mod.functions[1]!;
  const map = work.params[0]!.type;
  const has = (key: IrExpr): IrExpr => ({
    kind: "mapIntrinsic",
    method: "has",
    receiver: ref("map", map),
    args: [key],
    type: BOOL,
    loc,
  });
  const literal: IrExpr = { kind: "numLit", value: wide, type: F64, loc };
  const taken = { localId: "taken", name: "taken", type: BOOL };
  work.params.push(taken);
  work.locals.push({ id: "taken", name: "taken", type: BOOL, mutable: true });
  work.body = [
    {
      kind: "if",
      cond: ref("taken", BOOL),
      then: [
        {
          kind: "return",
          value: has({
            kind: "assignExpr",
            localId: "k",
            value: literal,
            type: F64,
            loc,
          }),
          loc,
        },
      ],
      else_: null,
      loc,
    },
    { kind: "return", value: has(literal), loc },
  ];
  for (const bits of [32, 64] as const) {
    const { work: text } = emitted(mod, bits);
    // The lookup after the branch takes the literal, not a conversion made
    // inside the branch.
    expect(text).toMatch(/call ptr @sc_map_entry_f64_int\(ptr %\S+, i64 1099511627776, double /);
    expect(text).not.toMatch(/@sc_map_entry_f64_int\(ptr %\S+, i64 %/);
  }
});

/** work(map): map.size, and keep(map): map returned as an owned value. */
function sizeFixture(): IrModule {
  const map: IrType = { kind: "map", key: F64, value: F64 };
  const params = [{ localId: "map", name: "map", type: map }];
  const locals = params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: true }));
  const size: IrExpr = {
    kind: "mapIntrinsic",
    method: "size",
    receiver: ref("map", map),
    args: [],
    type: F64,
    loc,
  };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: [],
    unions: [],
    functions: [
      { name: "main", params: [], locals: [], returnType: VOID, body: [], loc },
      {
        name: "work",
        params,
        returnType: F64,
        loc,
        locals,
        body: [{ kind: "return", value: size, loc }],
      },
      {
        name: "keep",
        params,
        returnType: map,
        loc,
        locals,
        body: [{ kind: "return", value: ref("map", map), loc }],
      },
    ],
  };
}

test("Map.size and Map retains need no runtime call in release builds", () => {
  const mod = sizeFixture();
  expect(validateModule(mod)).toEqual([]);
  for (const bits of [32, 64] as const) {
    const module = emitLlvmModule(mod, { pointerBits: bits, inlineRc: "release" });
    const fn = (name: string) =>
      new RegExp(`^define internal [^\\n]*@sc_(?:b)?f_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
        module,
      )![0];
    // Field 9 is the live entry count (scr_map.h).
    expect(module).toMatch(/^define internal double @sc_map_size\(ptr %m\)/m);
    expect(module).toContain(`getelementptr inbounds %ScrMapIx, ptr %m, i32 0, i32 9`);
    expect(fn("work")).toContain("call double @sc_map_size(");
    expect(module).not.toContain("call double @scr_map_size(");
    expect(fn("keep")).toContain("@sc_rc_retain_map(");
    expect(module).not.toContain("call ptr @scr_map_retain_v(");
  }
});
