import { expect, test } from "vitest";
import {
  BOOL,
  BYTES_U8,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrModule,
  type IrStmt,
} from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "bitwise-emission.ts", start: 0, end: 0 };

function fixture(): IrModule {
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const body: IrStmt[] = (["&", "|", "^", "<<", ">>", ">>>"] as const).map((op) => ({
    kind: "exprStmt",
    expr: { kind: "bin", op, left: num(5), right: num(3), type: F64, loc },
    loc,
  }));
  body.push({
    kind: "exprStmt",
    expr: { kind: "unary", op: "~", operand: num(5), type: F64, loc },
    loc,
  });
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [{ name: "__main", params: [], returnType: VOID, locals: [], body, loc }],
  };
}

test("LLVM emits bitwise number operators as native i32 instructions", () => {
  const llvm = emitLlvmModule(fixture());
  expect(llvm).not.toContain(["@", "scr", "_bit_"].join(""));
  expect(llvm).toMatch(/ = and i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = or i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = xor i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = shl i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = ashr i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = lshr i32 .*?, .*?$/m);
  expect(llvm).toMatch(/ = and i32 .*?, 31$/m);
  expect(llvm).toMatch(/ = xor i32 .*?, -1$/m);
  expect(llvm).toMatch(/ = uitofp i32 .*? to double$/m);
  expect(llvm).toMatch(/ = sitofp i32 .*? to double$/m);
});

test.each([32, 64] as const)(
  "string zero-length comparisons use the %i-bit byte count only",
  (bits) => {
    const receiver: IrExpr = { kind: "varRef", localId: "text", type: STRING, loc };
    const length: IrExpr = {
      kind: "strIntrinsic",
      method: "length",
      receiver,
      args: [],
      type: F64,
      loc,
    };
    const mod = fixture();
    mod.functions = [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      ...([0, 1] as const).map((number) => ({
        name: `length_${number}`,
        params: [{ name: "text", localId: "text", type: STRING }],
        returnType: BOOL,
        locals: [{ id: "text", name: "text", type: STRING, mutable: false }],
        loc,
        body: [
          {
            kind: "return" as const,
            loc,
            value: {
              kind: "bin" as const,
              op: "===" as const,
              left: length,
              right: { kind: "numLit" as const, value: number, type: F64, loc },
              type: BOOL,
              loc,
            },
          },
        ],
      })),
    ];
    const llvm = emitLlvmModule(mod, { pointerBits: bits });
    const zero = /^define internal [^\n]*@sc_[bf]+_length_0(?:\.i32)?\([^]*?^}/m.exec(llvm)![0];
    const one = /^define internal [^\n]*@sc_[bf]+_length_1(?:\.i32)?\([^]*?^}/m.exec(llvm)![0];
    expect(zero).toContain(`getelementptr inbounds i${bits}`);
    expect(zero).not.toContain("_str_utf16_len");
    expect(one).toContain("@sc_str_utf16_len");
  },
);

test("reference identity and instanceof borrow their operands", () => {
  const node = { kind: "object" as const, className: "Node" };
  const a: IrExpr = { kind: "varRef", localId: "a", type: node, loc };
  const b: IrExpr = { kind: "varRef", localId: "b", type: node, loc };
  const next: IrExpr = {
    kind: "fieldGet",
    obj: b,
    className: "Node",
    field: "next",
    type: node,
    loc,
  };
  const fn = (name: string, value: IrExpr) => ({
    name,
    params: [
      { name: "a", localId: "a", type: node },
      { name: "b", localId: "b", type: node },
    ],
    returnType: BOOL,
    locals: [
      { id: "a", name: "a", type: node, mutable: false },
      { id: "b", name: "b", type: node, mutable: false },
    ],
    loc,
    body: [{ kind: "return" as const, value, loc }],
  });
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    classes: [
      { name: "Node", fields: [{ name: "next", type: node }], methods: [], loc },
      { name: "Leaf", base: "Node", fields: [{ name: "next", type: node }], methods: [], loc },
    ],
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      fn("same", { kind: "bin", op: "===", left: a, right: next, type: BOOL, loc }),
      fn("leaf", { kind: "instanceOf", value: next, className: "Leaf", type: BOOL, loc }),
    ],
  };
  const llvm = emitLlvmModule(mod);
  for (const name of ["same", "leaf"]) {
    const body = new RegExp(
      `^define internal [^\\n]*@sc_bf_${name}(?:\\.i32)?\\([^]*?^}`,
      "m",
    ).exec(llvm)?.[0];
    expect(body, name).toBeDefined();
    expect(body, name).not.toMatch(/call ptr @sc_retain_Node/);
    expect(body, name).not.toMatch(/call void @sc_release_Node/);
  }
});

test("identity bitwise forms over a proven int32 return the operand's number", () => {
  const text: IrExpr = { kind: "varRef", localId: "text", type: STRING, loc };
  const length: IrExpr = {
    kind: "strIntrinsic",
    method: "length",
    receiver: text,
    args: [],
    type: F64,
    loc,
  };
  const x: IrExpr = { kind: "varRef", localId: "x", type: F64, loc };
  const zero: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
  const returning = (name: string, value: IrExpr) => ({
    name,
    params: [
      { name: "text", localId: "text", type: STRING },
      { name: "x", localId: "x", type: F64 },
    ],
    returnType: F64,
    locals: [
      { id: "text", name: "text", type: STRING, mutable: false },
      { id: "x", name: "x", type: F64, mutable: false },
    ],
    loc,
    body: [{ kind: "return" as const, loc, value }],
  });
  const bin = (op: "|" | ">>>" | "&", left: IrExpr, right: IrExpr): IrExpr => ({
    kind: "bin",
    op,
    left,
    right,
    type: F64,
    loc,
  });
  const mod = fixture();
  mod.functions = [
    { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
    returning("length_or", bin("|", length, zero)),
    returning("length_ushr", bin(">>>", length, zero)),
    returning("unknown_or", bin("|", x, zero)),
    returning("length_and", bin("&", length, { kind: "numLit", value: 255, type: F64, loc })),
  ];
  const llvm = emitLlvmModule(mod);
  const body = (name: string): string =>
    new RegExp(`^define internal [^\\n]*@sc_[bf]+_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
      llvm,
    )![0];
  for (const name of ["length_or", "length_ushr"]) {
    expect(body(name)).not.toMatch(/ = (or|lshr) i32 /);
    expect(body(name)).not.toMatch(/ = [su]itofp i32 /);
    expect(body(name)).not.toContain("uint32.coerce");
  }
  // Unproven operands keep the full ToInt32; other operators still compute.
  expect(body("unknown_or")).toContain("uint32.coerce.slow");
  expect(body("length_and")).toMatch(/ = and i32 .*, 255$/m);
});

test("sums that only feed a bitwise conversion of int32 operands add in 32 bits", () => {
  const ref = (localId: string, type = F64): IrExpr => ({ kind: "varRef", localId, type, loc });
  const length: IrExpr = {
    kind: "strIntrinsic",
    method: "length",
    receiver: ref("text", STRING),
    args: [],
    type: F64,
    loc,
  };
  const read = (localId: string): IrExpr => ({
    kind: "bytesIntrinsic",
    method: "get",
    receiver: ref(localId, localId === "floats" ? { kind: "bytes", elem: "f64" } : BYTES_U8),
    args: [ref("x")],
    type: F64,
    loc,
    invalidNaN: true,
  });
  const bin = (op: "+" | "-" | "*" | "|" | ">>>", left: IrExpr, right: IrExpr): IrExpr => ({
    kind: "bin",
    op,
    left,
    right,
    type: F64,
    loc,
  });
  const zero: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
  const params = [
    { name: "text", localId: "text", type: STRING },
    { name: "x", localId: "x", type: F64 },
    { name: "bytes", localId: "bytes", type: BYTES_U8 },
    { name: "floats", localId: "floats", type: { kind: "bytes", elem: "f64" } as const },
  ];
  const returning = (name: string, value: IrExpr) => ({
    name,
    params,
    returnType: F64,
    locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
    loc,
    body: [{ kind: "return" as const, loc, value }],
  });
  const mod = fixture();
  mod.functions = [
    { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
    returning("proven_add", bin("|", bin("+", length, length), zero)),
    returning("proven_sub", bin(">>>", bin("-", zero, bin("+", length, length)), zero)),
    returning("read_add", bin("|", bin("+", length, read("bytes")), zero)),
    returning(
      "read_chain",
      bin("|", bin("-", bin("+", read("bytes"), length), read("bytes")), zero),
    ),
    returning(
      "code_add",
      bin(
        "|",
        bin("+", length, {
          kind: "strIntrinsic",
          method: "charCodeAt",
          receiver: ref("text", STRING),
          args: [ref("x")],
          type: F64,
          loc,
        }),
        zero,
      ),
    ),
    returning("unknown_add", bin("|", bin("+", length, ref("x")), zero)),
    returning("float_read_add", bin("|", bin("+", length, read("floats")), zero)),
    returning("product", bin("|", bin("*", length, length), zero)),
    returning("number_add", bin("+", length, read("bytes"))),
  ];
  const llvm = emitLlvmModule(mod);
  const body = (name: string): string =>
    new RegExp(`^define internal [^\\n]*@sc_[bf]+_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
      llvm,
    )![0];
  // Wrapping 32-bit arithmetic, never `nsw`: the exact sum may leave int32.
  expect(body("proven_add")).toMatch(/ = add i32 /);
  expect(body("proven_sub")).toMatch(/ = sub i32 /);
  for (const name of ["proven_add", "proven_sub", "read_add", "read_chain", "code_add"]) {
    expect(body(name), name).not.toMatch(/ = (add|sub) nsw i32 /);
    expect(body(name), name).not.toContain("uint32.coerce");
  }
  // A NaN-coded read converts to 0 through the sum: the result selects 0
  // unless every NaN-coded operand is ordered.
  expect(body("read_add")).toMatch(/ = fcmp ord double .*, 0\.0$/m);
  expect(body("read_add")).toMatch(/ = add i32 /);
  expect(body("read_add")).toMatch(/ = select i1 .*, i32 .*, i32 0$/m);
  expect(body("read_chain")).toMatch(/ = and i1 /);
  expect(body("read_chain")).toMatch(/ = sub i32 /);
  // A code unit without an integer view converts once, behind the same test.
  expect(body("code_add")).toMatch(/ = fcmp ord double .*, 0\.0$/m);
  expect(body("code_add")).toMatch(/ = fptosi double .* to i32$/m);
  expect(body("code_add")).toMatch(/ = select i1 .*, i32 .*, i32 0$/m);
  // Unproven, fractional-capable and multiplied operands keep the double
  // arithmetic and the full ToInt32; a sum used as a number adds nothing.
  for (const name of ["unknown_add", "float_read_add", "product"]) {
    expect(body(name), name).toContain("uint32.coerce.slow");
    expect(body(name), name).not.toMatch(/ = (add|mul) i32 /);
  }
  expect(body("number_add")).not.toMatch(/ = add i32 |fcmp ord/);
});
