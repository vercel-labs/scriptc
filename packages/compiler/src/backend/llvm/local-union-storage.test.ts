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
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";
import { emitLlvmModule } from "./emitter.js";
import { findLocalUnionStorage } from "./local-union-storage.js";

const loc = { file: "local-unions.ts", start: 0, end: 1 };
const optional: IrType = { kind: "union", unionId: "optional" };
const map: IrType = { kind: "map", key: F64, value: STRING };
const ref = (localId: string, type: IrType = optional): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const wrap = (value: IrExpr, tag: number): IrExpr => ({
  kind: "unionWrap",
  value,
  tag,
  unionId: "optional",
  type: optional,
  loc,
});
const text = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const missing = (): IrExpr =>
  wrap({ kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }, 1);

function fixture(): IrModule {
  const work: IrFunction = {
    name: "work",
    loc,
    returnType: STRING,
    params: [
      { localId: "map", name: "map", type: map },
      { localId: "choose", name: "choose", type: BOOL },
    ],
    locals: [
      { id: "map", name: "map", type: map, mutable: true },
      { id: "choose", name: "choose", type: BOOL, mutable: true },
      { id: "item", name: "item", type: optional, mutable: true },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "item",
        loc,
        init: {
          kind: "ternary",
          cond: ref("choose", BOOL),
          then: wrap(text("start"), 0),
          else_: missing(),
          type: optional,
          loc,
        },
      },
      {
        kind: "assign",
        localId: "item",
        loc,
        value: {
          kind: "mapIntrinsic",
          method: "get",
          receiver: ref("map", map),
          args: [{ kind: "numLit", value: 1, type: F64, loc }],
          type: optional,
          loc,
        },
      },
      { kind: "return", loc, value: { kind: "toString", operand: ref("item"), type: STRING, loc } },
    ],
  };
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    unions: [{ id: "optional", arms: [STRING, UNDEFINED_T] }],
    functions: [{ name: "main", params: [], locals: [], body: [], returnType: VOID, loc }, work],
  };
}
function facts(mod: IrModule) {
  const lifetimes = analyzeCallLifetimes(new Map(mod.functions.map((fn) => [fn.name, fn])));
  return findLocalUnionStorage(
    mod.functions[1]!,
    lifetimes,
    new Map(mod.unions!.map((u) => [u.id, u])),
  );
}
function body(mod: IrModule, pointerBits: 32 | 64): string {
  expect(validateModule(mod)).toEqual([]);
  return /^define internal [^\n]*@sc_(?:b)?f_work\([^]*?^}/m.exec(
    emitLlvmModule(mod, { pointerBits }),
  )![0];
}

test("conditional and reassigned locals own payload snapshots without heap wrappers on either ABI", () => {
  const mod = fixture();
  expect(facts(mod).get("item")?.ownerType).toEqual(STRING);
  for (const bits of [32, 64] as const) {
    const ir = body(mod, bits);
    expect(ir).toContain("@scr_map_get_f64_ref");
    expect(ir).toContain("@scr_str_release");
    expect(ir).not.toMatch(/@scr_union_(?:new|retain|release)/);
    expect(ir).toContain("store i64 0");
  }
});

test("conditional immutable locals share the projection-only storage path", () => {
  const mod = fixture();
  mod.functions[1]!.locals[2]!.mutable = false;
  mod.functions[1]!.body.splice(1, 1);
  expect(facts(mod).has("item")).toBe(true);
  expect(body(mod, 64)).not.toMatch(/@scr_union_(?:new|retain|release)/);
});

test("projection-only calls borrow reassigned local boxes across unrelated mutations", () => {
  const mod = fixture();
  mod.functions.push({
    name: "observe",
    loc,
    returnType: STRING,
    params: [
      { localId: "value", name: "value", type: optional },
      { localId: "map", name: "map", type: map },
    ],
    locals: [
      { id: "value", name: "value", type: optional, mutable: true },
      { id: "map", name: "map", type: map, mutable: true },
    ],
    body: [
      {
        kind: "exprStmt",
        loc,
        expr: {
          kind: "mapIntrinsic",
          method: "clear",
          receiver: ref("map", map),
          args: [],
          type: VOID,
          loc,
        },
      },
      {
        kind: "return",
        loc,
        value: { kind: "toString", operand: ref("value"), type: STRING, loc },
      },
    ],
  });
  mod.functions[1]!.body[2] = {
    kind: "return",
    loc,
    value: {
      kind: "call",
      callee: "observe",
      args: [ref("item"), ref("map", map)],
      type: STRING,
      loc,
    },
  };
  expect(facts(mod).has("item")).toBe(true);
  expect(body(mod, 64)).not.toMatch(/@scr_union_(?:new|retain|release)/);
});

test.each([
  "escape",
  "assignment expression",
  "capture",
  "unknown source",
  "uninitialized",
  "multiple reference arms",
])("%s keeps the entire local on the owning heap path", (reason) => {
  const mod = fixture();
  const fn = mod.functions[1]!;
  if (reason === "escape") {
    fn.returnType = optional;
    fn.body[2] = { kind: "return", value: ref("item"), loc };
  } else if (reason === "assignment expression") {
    fn.body.splice(1, 0, {
      kind: "exprStmt",
      loc,
      expr: { kind: "assignExpr", localId: "item", value: missing(), type: optional, loc },
    });
  } else if (reason === "capture") {
    fn.locals[2]!.boxed = true;
  } else if (reason === "unknown source") {
    mod.functions.push({
      name: "source",
      loc,
      returnType: optional,
      params: [],
      locals: [],
      body: [{ kind: "return", loc, value: missing() }],
    });
    fn.body[1] = {
      kind: "assign",
      localId: "item",
      value: { kind: "call", callee: "source", args: [], type: optional, loc },
      loc,
    };
  } else if (reason === "uninitialized") {
    fn.body[0] = { kind: "varDecl", localId: "item", init: null, loc };
  } else {
    mod.unions![0]!.arms.push({ kind: "array", elem: F64 });
  }
  expect(facts(mod).has("item")).toBe(false);
});

test("copies of another binding retain the reference payload instead of the box", () => {
  const mod = fixture();
  const fn = mod.functions[1]!;
  fn.params.push({ localId: "other", name: "other", type: optional });
  fn.locals.push({ id: "other", name: "other", type: optional, mutable: true });
  fn.body[1] = { kind: "assign", localId: "item", value: ref("other"), loc };
  expect(facts(mod).get("item")?.ownerType).toEqual(STRING);
  for (const bits of [32, 64] as const) {
    const ir = body(mod, bits);
    expect(ir).toContain("@scr_str_retain");
    expect(ir).not.toMatch(/@scr_union_(?:new|retain)/);
  }
});

test("immediate tag and string conversions keep temporary payload ownership", () => {
  const mod = fixture();
  const fn = mod.functions[1]!;
  fn.body = [
    {
      kind: "return",
      loc,
      value: { kind: "toString", operand: wrap(text("temporary"), 0), type: STRING, loc },
    },
  ];
  expect(body(mod, 64)).not.toMatch(/@scr_union_(?:new|retain|release)/);
  fn.returnType = BOOL;
  fn.body = [
    {
      kind: "return",
      loc,
      value: { kind: "toBool", operand: wrap(text("temporary"), 0), type: BOOL, loc },
    },
  ];
  expect(body(mod, 64)).not.toMatch(/@scr_union_(?:new|retain|release)/);
});

const unionEq = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "unionEq",
  unionId: "optional",
  negated: false,
  sameValue: false,
  left,
  right,
  type: BOOL,
  loc,
});

function equalityFixture(): IrModule {
  const mod = fixture();
  const fn = mod.functions[1]!;
  fn.returnType = BOOL;
  fn.body = [
    fn.body[0]!,
    {
      kind: "return",
      loc,
      value: {
        kind: "logical",
        op: "||",
        left: unionEq(ref("item"), wrap(text("department"), 0)),
        right: unionEq(wrap(text("level"), 0), ref("item")),
        type: BOOL,
        loc,
      },
    },
  ];
  return mod;
}

test("strict equality against a wrapped literal borrows the local and stack-boxes the literal", () => {
  const mod = equalityFixture();
  expect(facts(mod).has("item")).toBe(true);
  for (const bits of [32, 64] as const) {
    const ir = body(mod, bits);
    expect(ir).toContain("@sc_str_eq");
    expect(ir).not.toMatch(/@scr_union_(?:new|retain|release)/);
  }
});

test("closure bodies keep their own union locals on the stack", () => {
  const mod = equalityFixture();
  mod.functions[1]!.captures = [];
  expect(facts(mod).has("item")).toBe(true);
  expect(body(mod, 64)).not.toMatch(/@scr_union_(?:new|retain|release)/);
});

test("equality whose other operand captures the whole local keeps the heap path", () => {
  const mod = equalityFixture();
  const fn = mod.functions[1]!;
  fn.body[1] = {
    kind: "return",
    loc,
    value: unionEq(ref("item"), {
      kind: "ternary",
      cond: ref("choose", BOOL),
      then: ref("item"),
      else_: missing(),
      type: optional,
      loc,
    }),
  };
  expect(facts(mod).has("item")).toBe(false);
});
