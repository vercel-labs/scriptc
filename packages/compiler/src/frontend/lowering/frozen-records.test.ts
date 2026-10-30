import { describe, expect, test } from "vitest";
import {
  DYN,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type SrcLoc,
  type IrType,
} from "../../ir/ir.js";
import { freezableTypes } from "./frozen-records.js";
import type { Lowerer } from "./lowerer.js";

const loc: SrcLoc = { file: "frozen.ts", start: 0, end: 1 };

/** An untyped conversion of a `type`-typed value: a live-reference root. */
function dynFrom(type: IrType, count: number): IrStmt[] {
  const expr: IrExpr = {
    kind: "dynFrom",
    value: { kind: "varRef", localId: "s.0", type, loc },
    type: DYN,
    loc,
  };
  const body: IrStmt[] = [];
  for (let i = 0; i < count; i++) body.push({ kind: "exprStmt", expr, loc });
  return body;
}

function fn(body: IrStmt[]): IrFunction {
  return { name: "f", params: [], returnType: VOID, locals: [], body, loc };
}

function stub(shapes: [string, unknown][] = []): Lowerer {
  return {
    untypedIntegrity: true,
    classes: new Map(),
    shapes: new Map(shapes),
    unions: new Map(),
  } as unknown as Lowerer;
}

describe("freezableTypes", () => {
  test("seeds a program-sized live list without a spread argument limit", () => {
    // A spread (`stack.push(...live)`) throws RangeError above roughly 100k
    // arguments, which a large program's live-reference roots reach.
    const roots = 200_000;
    const { shapes, arrays } = freezableTypes(stub(), [fn(dynFrom(STRING, roots))]);
    expect(shapes.size).toBe(0);
    expect(arrays.size).toBe(0);
  });

  test("a live record type makes its shape freezable", () => {
    const lowerer = stub([["r0", { id: "r0", fields: [] }]]);
    const live = dynFrom({ kind: "record", shapeId: "r0" }, 1);
    expect([...freezableTypes(lowerer, [fn(live)]).shapes]).toEqual(["r0"]);
  });
});
