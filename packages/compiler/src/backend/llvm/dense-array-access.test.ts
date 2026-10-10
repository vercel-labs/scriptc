import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  VOID,
  arrayOf,
  type IrExpr,
  type IrModule,
  type IrStmt,
} from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "dense-array-access.ts", start: 0, end: 0 };
const nums = arrayOf(F64);
const flags = arrayOf(BOOL);
const words = arrayOf(STRING);
const ref = (localId: string, type: IrExpr["type"]): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const index = ref("i", F64);

function module(name: string, returnType: IrExpr["type"], body: IrStmt[]): IrModule {
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name,
        params: [
          { name: "a", localId: "a", type: nums },
          { name: "b", localId: "b", type: flags },
          { name: "s", localId: "s", type: words },
          { name: "i", localId: "i", type: F64 },
        ],
        returnType,
        locals: [
          { id: "a", name: "a", type: nums, mutable: false },
          { id: "b", name: "b", type: flags, mutable: false },
          { id: "s", name: "s", type: words, mutable: false },
          { id: "i", name: "i", type: F64, mutable: false },
        ],
        body,
        loc,
      },
    ],
  };
}

function body(llvm: string, name: string): string {
  return new RegExp(`^define internal [^\\n]*@sc_bf_${name}\\([^]*?^}`, "m").exec(llvm)![0];
}

test.each([32, 64] as const)("strict scalar reads check dense storage inline (%i-bit)", (bits) => {
  const read: IrExpr = { kind: "arrayGet", arr: ref("a", nums), index, type: F64, loc };
  const llvm = emitLlvmModule(module("get", F64, [{ kind: "return", value: read, loc }]), {
    pointerBits: bits,
  });
  const fn = body(llvm, "get");
  // A double index must round-trip exactly; NaN/out-of-range conversions are frozen.
  expect(fn).toContain("fptosi double");
  expect(fn).toContain("freeze i64");
  expect(fn).toMatch(/icmp ult i64 .*/);
  expect(fn).toMatch(/load i8, ptr /);
  expect(fn).toMatch(/icmp eq i8 .*, 1$/m);
  expect(fn).toMatch(/load double, ptr /);
  expect(fn).toMatch(
    /call double @scr_arr_get_f64\(.*\) cold memory\(read, inaccessiblemem: readwrite\)/,
  );
  if (bits === 32) expect(fn).toContain("trunc i64");
});

test("reference reads retain inline and keep a cold +1 runtime fallback", () => {
  const read: IrExpr = { kind: "arrayGet", arr: ref("s", words), index, type: STRING, loc };
  const llvm = emitLlvmModule(module("word", STRING, [{ kind: "return", value: read, loc }]));
  const fn = body(llvm, "word");
  expect(fn).toMatch(/icmp ne ptr .*, null/);
  expect(fn).toContain("@scr_str_retain_v(");
  // The retaining getter writes reference counts, so it gets no read-only effect.
  expect(fn).toMatch(/call ptr @scr_arr_get_ref\(.*\) cold$/m);
});

test("element writes store inline, extend the length, and release replaced references", () => {
  const set = (arr: IrExpr, value: IrExpr): IrStmt => ({
    kind: "arraySet",
    arr,
    index,
    value,
    loc,
  });
  const llvm = emitLlvmModule(
    module("store", VOID, [
      set(ref("a", nums), { kind: "numLit", value: 2.5, type: F64, loc }),
      set(ref("b", flags), { kind: "boolLit", value: true, type: BOOL, loc }),
      set(ref("s", words), { kind: "strLit", value: "x", type: STRING, loc }),
    ]),
  );
  const fn = body(llvm, "store");
  expect(fn).toMatch(/store double 0x4004000000000000, ptr /);
  expect(fn).toMatch(/zext i1 .* to i64/);
  expect(fn).toMatch(/store i8 1, ptr /);
  expect(fn).toMatch(/icmp uge i64 .*/);
  expect(fn).toContain("call void @scr_str_release(");
  for (const acc of ["f64", "bool", "ref"]) {
    expect(fn).toMatch(new RegExp(`call void @scr_arr_set_${acc}\\(.*\\) cold$`, "m"));
  }
});

test.each([32, 64] as const)(
  "push appends inline below the capacity and keeps a cold runtime append (%i-bit)",
  (bits) => {
    const push = (receiver: IrExpr, value: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: { kind: "arrIntrinsic", method: "push", receiver, args: [value], type: F64, loc },
      loc,
    });
    const llvm = emitLlvmModule(
      module("append", VOID, [
        push(ref("a", nums), { kind: "numLit", value: 2.5, type: F64, loc }),
        push(ref("b", flags), { kind: "boolLit", value: true, type: BOOL, loc }),
        push(ref("s", words), { kind: "strLit", value: "x", type: STRING, loc }),
      ]),
      { pointerBits: bits },
    );
    const fn = body(llvm, "append");
    const size = bits === 32 ? "i32" : "i64";
    expect(fn.match(new RegExp(`icmp ult ${size} `, "g"))).toHaveLength(3);
    expect(fn).toMatch(/store double 0x4004000000000000, ptr /);
    expect(fn).toMatch(/zext i1 .* to i64/);
    expect(fn.match(/store i8 1, ptr /g)).toHaveLength(3);
    expect(fn.match(new RegExp(`add nuw ${size} .*, 1$`, "gm"))).toHaveLength(3);
    // Appends never release: the slot past the length holds no value.
    expect(fn).not.toContain("_release(");
    for (const acc of ["f64", "bool", "ref"]) {
      expect(fn).toMatch(new RegExp(`call double @scr_arr_push_${acc}\\(.*\\) cold$`, "m"));
    }
  },
);

test("state and presence queries answer dense slots inline", () => {
  const state: IrExpr = { kind: "arrayState", arr: ref("b", flags), index, type: F64, loc };
  const has: IrExpr = { kind: "arrayHas", arr: ref("s", words), index, type: BOOL, loc };
  const llvm = emitLlvmModule(
    module("query", BOOL, [
      {
        kind: "return",
        value: {
          kind: "logical",
          op: "&&",
          left: {
            kind: "bin",
            op: "===",
            left: state,
            right: { kind: "numLit", value: 1, type: F64, loc },
            type: BOOL,
            loc,
          },
          right: has,
          type: BOOL,
          loc,
        },
        loc,
      },
    ]),
  );
  const fn = body(llvm, "query");
  expect(fn).toMatch(/uitofp i8 .* to double/);
  expect(fn).toMatch(/icmp ne i8 .*, 0/);
  expect(fn).toMatch(/call double @scr_arr_state\(.*\) cold memory\(read/);
  expect(fn).toMatch(/call i1 @scr_arr_has\(.*\) cold memory\(read/);
});

test("statement-position splices insert values without result or item arrays", () => {
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const splice = (items: IrExpr[] | null): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "arrIntrinsic",
      method: items ? "spliceInsert" : "splice",
      receiver: ref("s", words),
      args: [
        index,
        num(0),
        ...(items ? [{ kind: "arrayLit" as const, elems: items, type: words, loc }] : []),
      ],
      type: words,
      loc,
    },
    loc,
  });
  const llvm = emitLlvmModule(
    module("insert", VOID, [
      splice([{ kind: "strLit", value: "x", type: STRING, loc }]),
      splice(null),
    ]),
  );
  const fn = body(llvm, "insert");
  expect(fn.match(/call void @scr_arr_splice_drop\(/g)).toHaveLength(2);
  expect(fn).toMatch(/call void @scr_arr_splice_drop\(.*, i64 1, ptr %t\d+\)/);
  expect(fn).toMatch(/call void @scr_arr_splice_drop\(.*, i64 0, ptr null\)/);
  expect(fn).not.toContain("@scr_arr_new");
  expect(fn).not.toContain("@scr_arr_splice_insert");
  expect(fn).not.toContain("@scr_arr_release");
});

test("length assignments skip the runtime when the length is unchanged", () => {
  const llvm = emitLlvmModule(
    module("reset", VOID, [{ kind: "arraySetLength", arr: ref("s", words), length: index, loc }]),
  );
  const fn = body(llvm, "reset");
  expect(fn).toMatch(/uitofp nneg i64 .* to double/);
  expect(fn).toMatch(/fcmp oeq double %p?\S*, %t\d+/);
  expect(fn.match(/call void @scr_arr_set_len\(/g)).toHaveLength(1);
  expect(fn).toMatch(/br i1 %t\d+, label %arr\.len\.done\d*, label %arr\.len\.set\d*/);
});

test("a discarded conditional splice drops the result of its literal arm", () => {
  const insert = (items: IrExpr): IrExpr => ({
    kind: "arrIntrinsic",
    method: "spliceInsert",
    receiver: ref("s", words),
    args: [index, { kind: "numLit", value: 0, type: F64, loc }, items],
    type: words,
    loc,
  });
  const word: IrExpr = { kind: "strLit", value: "x", type: STRING, loc };
  const llvm = emitLlvmModule(
    module("pick", VOID, [
      {
        kind: "exprStmt",
        expr: {
          kind: "seqExpr",
          stmts: [],
          result: {
            kind: "ternary",
            cond: { kind: "boolLit", value: true, type: BOOL, loc },
            then: insert({
              kind: "seqExpr",
              stmts: [],
              result: { kind: "arrayLit", elems: [word], type: words, loc },
              type: words,
              loc,
            }),
            else_: insert({ kind: "arrayLit", elems: [word], type: words, loc }),
            type: words,
            loc,
          },
          type: words,
          loc,
        },
        loc,
      },
    ]),
  );
  const fn = body(llvm, "pick");
  expect(fn.match(/call void @scr_arr_splice_drop\(/g)).toHaveLength(1);
  expect(fn.match(/call ptr @scr_arr_splice_insert\(/g)).toHaveLength(1);
  expect(fn).toMatch(/drop\.t\d*:/);
});

test("an empty literal's capacity hint sizes its first dense storage", () => {
  const llvm = emitLlvmModule(
    module("fresh", words, [
      {
        kind: "return",
        value: { kind: "arrayLit", elems: [], capacity: 3, type: words, loc },
        loc,
      },
    ]),
  );
  expect(body(llvm, "fresh")).toMatch(/call ptr @scr_arr_new\(.*, i64 3\)/);
});
