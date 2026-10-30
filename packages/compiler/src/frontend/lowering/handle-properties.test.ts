import { expect, test } from "vitest";
import { VOID, type IrExpr, type IrFunction, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { applyHandleProperties } from "./handle-properties.js";
import { ENTRY_NAME, type Lowerer } from "./lowerer.js";

const loc: SrcLoc = { file: "main.ts", start: 0, end: 1 };
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  name,
  body,
  params: [],
  locals: [],
  returnType: VOID,
  loc,
});

test("renames a libCall the IR reaches from several statements once", () => {
  const call: IrExpr = { kind: "libCall", fn: "dyn.defineProperty", args: [], type: VOID, loc };
  const use: IrStmt = { kind: "exprStmt", expr: call, loc };
  const functions = [fn(ENTRY_NAME, [use, use]), fn("helper", [use])];
  applyHandleProperties({ writesOntoChildren: true } as unknown as Lowerer, functions);
  expect(call).toMatchObject({ kind: "libCall", fn: "child.propsDefine" });
  expect(functions[0]!.body[0]).toMatchObject({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "child.propsInstall" },
  });
});
