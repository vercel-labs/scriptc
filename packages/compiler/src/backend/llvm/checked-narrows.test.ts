import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  VOID,
  UNDEFINED_T,
  arrayOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { CheckedNarrows } from "./checked-narrows.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "checked-narrow.ts", start: 0, end: 0 };
const element: IrType = { kind: "record", shapeId: "cell" };
const optional: IrType = { kind: "union", unionId: "optional" };
const array = arrayOf(element);
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
const params = [
  { localId: "a", name: "a", type: array },
  { localId: "i", name: "i", type: F64 },
];
const locals = params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false }));

/** The optional array read the frontend emits for `a[i]`. */
const read: IrFunction = {
  name: "read",
  params,
  returnType: optional,
  locals,
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
          left: { kind: "arrayState", arr: ref("a", array), index: ref("i", F64), type: F64, loc },
          right: { kind: "numLit", value: 1, type: F64, loc },
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

/** A checked extraction of the element arm; `undefinedArm` replaces the
 * throwing undefined branch, as a defaulting helper would. */
function check(name: string, undefinedArm?: IrStmt): IrFunction {
  const u = ref("u.0", optional);
  const thrown: IrStmt = {
    kind: "throw",
    value: {
      kind: "libCall",
      fn: "error.new",
      args: [{ kind: "strLit", value: "undefined is not an element", type: STRING, loc }],
      type: { kind: "object", className: "%TypeError" },
      loc,
    },
    loc,
  };
  const arm = (tag: number, then: IrStmt): IrStmt => ({
    kind: "if",
    cond: {
      kind: "unionIsTag",
      unionId: "optional",
      tag,
      negated: false,
      value: u,
      type: BOOL,
      loc,
    },
    then: [then],
    else_: null,
    loc,
  });
  return {
    name,
    params: [{ localId: "u.0", name: "u", type: optional }],
    returnType: element,
    locals: [{ id: "u.0", name: "u", type: optional, mutable: false }],
    loc,
    body: [
      arm(0, {
        kind: "return",
        value: { kind: "unionNarrow", unionId: "optional", tag: 0, value: u, type: element, loc },
        loc,
      }),
      arm(1, undefinedArm ?? thrown),
      { kind: "throw", value: { kind: "strLit", value: "invalid tag", type: STRING, loc }, loc },
    ],
  };
}

function fixture(helper: IrFunction): IrModule {
  const narrowed: IrExpr = {
    kind: "call",
    callee: helper.name,
    args: [
      { kind: "call", callee: "read", args: [ref("a", array), ref("i", F64)], type: optional, loc },
    ],
    type: element,
    loc,
  };
  const work: IrFunction = {
    name: "work",
    params,
    returnType: F64,
    locals,
    loc,
    body: [
      {
        kind: "return",
        value: { kind: "recordGet", obj: narrowed, shapeId: "cell", field: "x", type: F64, loc },
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
      read,
      helper,
      work,
    ],
  };
}

function workBody(mod: IrModule, pointerBits: 32 | 64 = 64): string {
  return /^define internal [^\n]*@sc_(?:b)?f_work\([^]*?^}/m.exec(
    emitLlvmModule(mod, { pointerBits }),
  )![0];
}

test("recognizes checked extractions by their complete body", () => {
  const defaulted = check("defaulted", {
    kind: "return",
    value: {
      kind: "unionNarrow",
      unionId: "optional",
      tag: 0,
      value: ref("u.0", optional),
      type: element,
      loc,
    },
    loc,
  });
  const narrows = new CheckedNarrows(
    new Map([check("check"), defaulted, read].map((fn) => [fn.name, fn])),
  );
  const call = (callee: string): IrExpr => ({
    kind: "call",
    callee,
    args: [ref("value", optional)],
    type: element,
    loc,
  });
  expect(narrows.get(call("check"))?.tag).toBe(0);
  // Two successful arms, or any non-throwing arm, is not a checked extraction.
  expect(narrows.get(call("defaulted"))).toBeNull();
  expect(narrows.get(call("read"))).toBeNull();
});

test("a field read through a checked array element borrows the element on both ABIs", () => {
  const mod = fixture(check("check"));
  expect(validateModule(mod)).toEqual([]);
  for (const pointerBits of [32, 64] as const) {
    const body = workBody(mod, pointerBits);
    expect(body).toContain("narrow.present");
    expect(body).not.toContain("@sc_bf_read(");
    expect(body).not.toContain("@sc_rretain_");
    expect(body).not.toContain("@sc_rrelease_");
    // The helper still runs, and throws, for every other arm.
    expect(body).toMatch(/call ptr @\S*check\S*\(ptr /);
  }
});

test("a helper that does not throw for every other arm keeps the ordinary call", () => {
  const mod = fixture(
    check("fallback", {
      kind: "return",
      value: {
        kind: "recordLit",
        fields: [{ name: "x", value: { kind: "numLit", value: 0, type: F64, loc } }],
        type: element,
        loc,
      },
      loc,
    }),
  );
  expect(validateModule(mod)).toEqual([]);
  const body = workBody(mod);
  expect(body).not.toContain("narrow.present");
  expect(body).toContain("fallback");
});
