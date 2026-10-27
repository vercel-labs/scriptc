import { expect, test } from "vitest";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import {
  F64,
  VOID,
  bytesOf,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
} from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";

const loc = { file: "bytes-field-borrow.ts", start: 0, end: 0 };
const units = bytesOf("u16");
const scanner = { kind: "object" as const, className: "Scanner" };
const self = (): IrExpr => ({ kind: "varRef", localId: "this", type: scanner, loc });
const chars = (): IrExpr => ({
  kind: "fieldGet",
  obj: self(),
  className: "Scanner",
  field: "chars",
  type: units,
  loc,
});
const local = (): IrExpr => ({ kind: "varRef", localId: "c", type: units, loc });
const read = (index: number): IrExpr => ({
  kind: "bytesIntrinsic",
  method: "get",
  receiver: local(),
  args: [{ kind: "numLit", value: index, type: F64, loc }],
  type: F64,
  loc,
});

/** `const c = this.chars; ...between; return c[0] + c[1]`. */
function method(name: string, between: IrStmt[]): IrFunction {
  return {
    name,
    params: [{ localId: "this", name: "this", type: scanner }],
    returnType: F64,
    locals: [
      { id: "this", name: "this", type: scanner, mutable: false },
      { id: "c", name: "c", type: units, mutable: false },
    ],
    body: [
      { kind: "varDecl", localId: "c", init: chars(), loc },
      ...between,
      {
        kind: "return",
        value: { kind: "bin", op: "+", left: read(0), right: read(1), type: F64 },
        loc,
      },
    ],
    loc,
  } as IrFunction;
}

test("a typed-array local read from a field the rest of its block never writes borrows it", () => {
  const replace: IrStmt = {
    kind: "fieldSet",
    obj: self(),
    className: "Scanner",
    field: "chars",
    value: {
      kind: "bytesNew",
      source: { kind: "numLit", value: 4, type: F64, loc },
      type: units,
      loc,
    },
    loc,
  };
  const mod: IrModule = {
    irVersion: 16,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc },
      method("%Scanner.peek", []),
      method("%Scanner.swap", [replace]),
    ],
    classes: [{ name: "Scanner", fields: [{ name: "chars", type: units }], methods: [], loc }],
  };
  expect(validateModule(mod)).toEqual([]);
  const llvm = emitLlvmModule(mod, { pointerBits: 64 });
  const body = (name: string): string =>
    new RegExp(`^define [^\\n]*@sc_bf__x25_Scanner_${name}\\b[^]*?^}`, "m").exec(llvm)?.[0] ?? "";
  expect(body("peek")).not.toBe("");
  // The field keeps the array alive while the borrowed local reads it.
  expect(body("peek")).not.toContain("bytes_retain");
  expect(body("peek")).not.toContain("bytes_release");
  // Replacing the field could free the array the local holds: it keeps a reference.
  expect(body("swap")).toContain("call ptr @scr_bytes_retain_v(");
});
