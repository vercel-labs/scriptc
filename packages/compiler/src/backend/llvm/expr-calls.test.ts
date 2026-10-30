import { expect, test } from "vitest";
import {
  F64,
  STRING,
  VOID,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "lending.ts", start: 0, end: 0 };
const strings: IrType = { kind: "array", elem: STRING };
const callback = funcOf([STRING], F64);
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
const local = (id: string, type: IrType, extra: object = {}) => ({
  id,
  name: id,
  type,
  mutable: false,
  ...extra,
});
const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
const len = (value: IrExpr): IrExpr => ({
  kind: "strIntrinsic",
  method: "length",
  receiver: value,
  args: [],
  type: F64,
  loc,
});

/** `(s: string) => s.length`, optionally rebinding its parameter first. */
function lambda(name: string, rebinds = false): IrFunction {
  return {
    name,
    params: [{ localId: "s", name: "s", type: STRING }],
    returnType: F64,
    captures: [],
    locals: [local("s", STRING)],
    body: [
      ...(rebinds ? [{ kind: "assign" as const, localId: "s", value: ref("s", STRING), loc }] : []),
      ret(len(ref("s", STRING))),
    ],
    loc,
  };
}

/** `apply(f, xs)` calls the unknown callback with a parameter, or with
 * `xs[0]`, an element its targets may overwrite. */
function apply(arg: "param" | "element"): IrFunction {
  const value: IrExpr =
    arg === "param"
      ? ref("word", STRING)
      : {
          kind: "arrayGet",
          arr: ref("xs", strings),
          index: { kind: "numLit", value: 0, type: F64, loc },
          type: STRING,
          loc,
        };
  return {
    name: "apply",
    params: [
      { localId: "f", name: "f", type: callback },
      { localId: "word", name: "word", type: STRING },
      { localId: "xs", name: "xs", type: strings },
    ],
    returnType: F64,
    locals: [local("f", callback), local("word", STRING), local("xs", strings)],
    body: [ret({ kind: "callValue", callee: ref("f", callback), args: [value], type: F64, loc })],
    loc,
  };
}

function moduleWith(functions: IrFunction[], main: IrStmt[] = []): IrModule {
  const store = local("store", strings, { mutable: true, boxed: true });
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [store], body: main, loc },
      ...functions,
    ],
  };
}

const make = (fnName: string, captures: string[] = []): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "closure", fnName, captures, type: callback, loc },
  loc,
});

function body(llvm: string, symbol: string): string {
  const start = llvm.indexOf(`define internal double @${symbol}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  return llvm.slice(start, llvm.indexOf("\n}\n", start));
}

test("closures over bodies that borrow every reference parameter carry a lending entry", () => {
  const llvm = emitLlvmModule(
    moduleWith([lambda("lends"), lambda("owns", true)], [make("lends"), make("owns")]),
  );
  // The borrowing body sits behind the owned closure entry.
  expect(body(llvm, "sc_bf_lends")).not.toContain("@scr_str_release");
  expect(body(llvm, "sc_f_lends")).toContain("call double @sc_bf_lends(ptr %sc_env, ptr %p0)");
  expect(body(llvm, "sc_f_lends")).toContain("call void @scr_str_release(ptr %p0)");
  expect(llvm).toContain("store ptr @sc_bf_lends, ptr");
  // A rebound parameter is owned: no borrowing body, no lending entry.
  expect(llvm).not.toContain("@sc_bf_owns");
  expect(llvm.match(/i64 0, i32 7\n/g)).toHaveLength(1);
});

test("unknown callbacks borrow stable arguments through the lending entry", () => {
  const lent = body(emitLlvmModule(moduleWith([apply("param"), lambda("lends")])), "sc_bf_apply");
  expect(lent).toMatch(/getelementptr inbounds %ScrClosure, ptr %[^,]+, i64 0, i32 7/);
  const [lending, owning] = lent.split(/^callback\.own\d+:$/m);
  // The lending branch passes the caller's reference; the owned entry
  // receives a reference of its own.
  expect(lending).not.toContain("@scr_str_retain");
  expect(owning).toContain("@scr_str_retain");
});

test("arguments a callback target may release keep the owned convention", () => {
  // The lambda overwrites array elements, so `xs[0]` cannot be lent to it.
  const writer = lambda("writer");
  writer.locals.push(local("store", strings, { boxed: true }));
  writer.captures = [{ localId: "store", name: "store", type: strings }];
  writer.body.unshift({
    kind: "exprStmt",
    expr: {
      kind: "arrIntrinsic",
      method: "fill",
      receiver: ref("store", strings),
      args: [
        ref("s", STRING),
        { kind: "numLit", value: 0, type: F64, loc },
        { kind: "numLit", value: 1, type: F64, loc },
      ],
      type: strings,
      loc,
    },
    loc,
  });
  const fill = (writes: boolean): string =>
    body(
      emitLlvmModule(
        moduleWith([apply("element"), writer], writes ? [make("writer", ["store"])] : []),
      ),
      "sc_bf_apply",
    );
  expect(fill(true)).not.toContain("callback.lend");
  // Without that closure value among the targets, the element is lent.
  expect(fill(false)).toContain("callback.lend");
});
