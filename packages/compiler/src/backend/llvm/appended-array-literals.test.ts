import { expect, test } from "vitest";
import { F64, VOID, arrayOf, type IrExpr, type IrModule, type IrStmt } from "../../ir/ir.js";
import { emitLlvmModule } from "./emitter.js";
import { findAppendedArrayLiterals } from "./appended-array-literals.js";

const loc = { file: "appended-array-literals.ts", start: 0, end: 0 };
const nums = arrayOf(F64);
const empty = (): IrExpr => ({ kind: "arrayLit", elems: [], type: nums, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: nums, loc });
const push = (receiver: IrExpr): IrStmt => ({
  kind: "exprStmt",
  expr: {
    kind: "arrIntrinsic",
    method: "push",
    receiver,
    args: [{ kind: "numLit", value: 1, type: F64, loc }],
    type: F64,
    loc,
  },
  loc,
});

function module(body: IrStmt[], locals: string[]): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name: "fill",
        params: [],
        returnType: VOID,
        locals: locals.map((id) => ({ id, name: id, type: nums, mutable: true })),
        body,
        loc,
      },
    ],
  };
}

test("only empty literals stored where the module appends construct small", () => {
  const pushed = empty(),
    reassigned = empty(),
    idle = empty(),
    returned = empty();
  const body: IrStmt[] = [
    { kind: "varDecl", localId: "xs", init: pushed, loc },
    { kind: "varDecl", localId: "ys", init: idle, loc },
    push(ref("xs")),
    { kind: "assign", localId: "xs", value: reassigned, loc },
    { kind: "exprStmt", expr: returned, loc },
  ];
  const found = findAppendedArrayLiterals(module(body, ["xs", "ys"]));
  expect(found.has(pushed)).toBe(true);
  expect(found.has(reassigned)).toBe(true);
  expect(found.has(idle)).toBe(false);
  expect(found.has(returned)).toBe(false);

  // Only `fill` builds arrays. They may hold int32 slots (element kind 7),
  // which does not change the choice of constructor.
  const llvm = emitLlvmModule(module(body, ["xs", "ys"]));
  expect(llvm.match(/call ptr @scr_arr_new_small\(i32 [07]\)/g)).toHaveLength(2);
  expect(llvm.match(/call ptr @scr_arr_new\(i32 [07], i64 0\)/g)).toHaveLength(2);
});

test("a binding with the same id in another function does not count", () => {
  const literal = empty();
  const mod = module([{ kind: "varDecl", localId: "xs", init: literal, loc }], ["xs"]);
  mod.functions.push({
    name: "other",
    params: [],
    returnType: VOID,
    locals: [{ id: "xs", name: "xs", type: nums, mutable: true }],
    body: [{ kind: "varDecl", localId: "xs", init: empty(), loc }, push(ref("xs"))],
    loc,
  });
  expect(findAppendedArrayLiterals(mod).has(literal)).toBe(false);
});

test("a field appended through a binding read from it counts", () => {
  const cls = { kind: "class", className: "Heap" } as unknown as IrExpr["type"];
  const self: IrExpr = { kind: "varRef", localId: "this", type: cls, loc };
  const init = empty();
  const read: IrExpr = {
    kind: "fieldGet",
    obj: self,
    className: "Heap",
    field: "d",
    type: nums,
    loc,
  };
  const mod = module(
    [
      { kind: "fieldSet", obj: self, className: "Heap", field: "d", value: init, loc },
      { kind: "varDecl", localId: "d", init: read, loc },
      push(ref("d")),
    ],
    ["this", "d"],
  );
  expect(findAppendedArrayLiterals(mod).has(init)).toBe(true);
});
