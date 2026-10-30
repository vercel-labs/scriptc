import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import { findMapEntryFusions } from "./map-entry-fusion.js";

const loc = { file: "map-fusion.ts", start: 0, end: 1 };
const optional: IrType = { kind: "union", unionId: "optional" };
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });

function mapType(key: IrType, value: IrType): IrType {
  return { kind: "map", key, value };
}

function get(map: IrExpr, key: IrExpr): IrExpr {
  return { kind: "mapIntrinsic", method: "get", receiver: map, args: [key], type: optional, loc };
}

function set(map: IrExpr, key: IrExpr, value: IrExpr): IrStmt {
  return {
    kind: "exprStmt",
    loc,
    expr: {
      kind: "mapIntrinsic",
      method: "set",
      receiver: map,
      args: [key, value],
      type: VOID,
      loc,
    },
  };
}

/** `(cur is undefined ? 0 : narrow(cur)) + 1` over the optional local. */
function increment(value: IrType): IrExpr {
  const cur = ref("cur", optional);
  if (value.kind === "bool") return { kind: "boolLit", value: true, type: BOOL, loc };
  return {
    kind: "bin",
    op: "+",
    left: {
      kind: "ternary",
      cond: {
        kind: "unionIsTag",
        value: cur,
        unionId: "optional",
        tag: 1,
        negated: false,
        type: BOOL,
        loc,
      },
      then: { kind: "numLit", value: 0, type: F64, loc },
      else_: { kind: "unionNarrow", unionId: "optional", tag: 0, value: cur, type: F64, loc },
      type: F64,
      loc,
    },
    right: { kind: "numLit", value: 1, type: F64, loc },
    type: F64,
    loc,
  };
}

function fixture(
  body: (map: IrExpr, key: IrExpr, other: IrExpr) => IrStmt[],
  key: IrType = STRING,
  value: IrType = F64,
): IrModule {
  const map = mapType(key, value);
  const params = [
    { localId: "map", name: "map", type: map },
    { localId: "other", name: "other", type: map },
    { localId: "key", name: "key", type: key },
  ];
  const work: IrFunction = {
    name: "work",
    params,
    returnType: VOID,
    loc,
    locals: [
      ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: true })),
      { id: "cur", name: "cur", type: optional, mutable: false },
    ],
    body: body(ref("map", map), ref("key", key), ref("other", map)),
  };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    unions: [{ id: "optional", arms: [value, UNDEFINED_T] }],
    functions: [{ name: "main", params: [], locals: [], returnType: VOID, body: [], loc }, work],
  };
}

const declare = (map: IrExpr, key: IrExpr): IrStmt => ({
  kind: "varDecl",
  localId: "cur",
  init: get(map, key),
  loc,
});

function pairs(mod: IrModule): number {
  return findMapEntryFusions(mod.functions[1]!).writes.size;
}

function body(mod: IrModule, bits: 32 | 64 = 64): string {
  expect(validateModule(mod)).toEqual([]);
  const llvm = emitLlvmModule(mod, { pointerBits: bits });
  return /^define internal [^\n]*@sc_(?:b)?f_work\([^]*?^}/m.exec(llvm)![0];
}

test("a read followed by a write of the same map pairs, and the write reuses the entry", () => {
  for (const value of [F64, BOOL]) {
    const mod = fixture(
      (map, k) => [declare(map, k), set(map, k, increment(value))],
      STRING,
      value,
    );
    expect(pairs(mod)).toBe(1);
    for (const bits of [32, 64] as const) {
      const ir = body(mod, bits);
      expect(ir).toContain("mapfuse.hit");
      // The miss still inserts through the runtime.
      expect(ir).toMatch(/call void @scr_map_set_str_(?:f64|bool)\(/);
      expect(ir).toContain("@sc_map_entry_str(");
    }
  }
});

test("number keys pair, and the write compares the key's bits with the read's", () => {
  for (const value of [F64, BOOL]) {
    const mod = fixture((map, k) => [declare(map, k), set(map, k, increment(value))], F64, value);
    expect(pairs(mod)).toBe(1);
    for (const bits of [32, 64] as const) {
      const ir = body(mod, bits);
      expect(ir).toContain("mapfuse.hit");
      expect(ir).toContain("alloca double ; fused map read: key");
      expect(ir).toMatch(/icmp eq i64 %t\d+, %t\d+/);
      // The miss still inserts through the runtime.
      expect(ir).toMatch(/call void @scr_map_set_f64_(?:f64|bool)\(/);
      expect(ir).toContain("@sc_map_entry_f64(");
    }
  }
});

test("the single-statement form pairs an unconditional nested read", () => {
  const mod = fixture((map, k) => [
    set(map, k, {
      kind: "bin",
      op: "+",
      left: {
        kind: "nullish",
        left: get(map, k),
        right: { kind: "numLit", value: 0, type: F64, loc },
        type: F64,
        loc,
      },
      right: { kind: "numLit", value: 1, type: F64, loc },
      type: F64,
      loc,
    }),
  ]);
  expect(pairs(mod)).toBe(1);
});

test("reads behind a condition, intervening statements and other effects do not pair", () => {
  // The read only runs on one arm.
  const conditional = fixture((map, k) => [
    set(map, k, {
      kind: "ternary",
      cond: { kind: "boolLit", value: true, type: BOOL, loc },
      then: {
        kind: "nullish",
        left: get(map, k),
        right: { kind: "numLit", value: 0, type: F64, loc },
        type: F64,
        loc,
      },
      else_: { kind: "numLit", value: 0, type: F64, loc },
      type: F64,
      loc,
    }),
  ]);
  expect(pairs(conditional)).toBe(0);
  // A mutation of any map between the read and the write.
  const between = fixture((map, k, other) => [
    declare(map, k),
    set(other, k, { kind: "numLit", value: 1, type: F64, loc }),
    set(map, k, increment(F64)),
  ]);
  expect(findMapEntryFusions(between.functions[1]!).reads.size).toBe(1);
  expect(
    [...findMapEntryFusions(between.functions[1]!).writes.keys()].map(
      (w) => w.kind === "mapIntrinsic" && w.receiver.kind === "varRef" && w.receiver.localId,
    ),
  ).toEqual(["other"]);
  // A call in the written value may run arbitrary code.
  const call = fixture((map, k) => [
    declare(map, k),
    set(map, k, { kind: "call", callee: "main", args: [], type: F64, loc }),
  ]);
  expect(pairs(call)).toBe(0);
});

test("writes to another map or key stay correct at run time", () => {
  // The pairing is syntactic; identity checks decide reuse when it runs.
  const mod = fixture((map, k, other) => [declare(map, k), set(other, k, increment(F64))]);
  expect(pairs(mod)).toBe(1);
  const ir = body(mod);
  expect(ir).toMatch(/icmp eq ptr %\w+, %\w+/);
  expect(ir).toContain("mapfuse.miss");
});

test("reference values never fuse", () => {
  const mod = fixture(
    (map, k) => [declare(map, k), set(map, k, { kind: "strLit", value: "x", type: STRING, loc })],
    STRING,
    STRING,
  );
  expect(pairs(mod)).toBe(0);
});
