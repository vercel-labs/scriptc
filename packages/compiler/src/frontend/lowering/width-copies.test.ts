import { describe, expect, test } from "vitest";
import {
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { conversionCopy } from "./width-copies.js";
import { ARM_EXTRACTION_HELPER, COPY_HELPERS, ROUTING_HELPERS } from "./width-lift.js";

const loc: SrcLoc = { file: "copies.ts", start: 0, end: 1 };
const CIRCLE: IrType = { kind: "record", shapeId: "circle" };
const SHAPE: IrType = { kind: "union", unionId: "shape" };
const OPTIONAL: IrType = { kind: "union", unionId: "circle|undefined" };
const CIRCLES: IrType = { kind: "array", elem: CIRCLE };
const SHAPES: IrType = { kind: "array", elem: SHAPE };

function call(callee: string, arg: IrExpr, type: IrType): IrExpr {
  return { kind: "call", callee, args: [arg], type, loc };
}

/** The checked extraction of the present arm, as `??` builds it. */
function taken(type: IrType): IrExpr {
  return call(
    `${ARM_EXTRACTION_HELPER}.0`,
    { kind: "varRef", localId: "left.0", type: OPTIONAL, loc },
    type,
  );
}

function wrap(value: IrExpr): IrExpr {
  return { kind: "unionWrap", unionId: "shape", tag: 0, value, type: SHAPE, loc };
}

function helper(name: string, param: IrType, returns: IrType, body: IrStmt[]): IrFunction {
  return {
    name,
    params: [{ localId: "v.0", name: "v", type: param }],
    returnType: returns,
    locals: [{ id: "v.0", name: "v", type: param, mutable: false }],
    body,
    loc,
  };
}

function lookup(...fns: IrFunction[]): (name: string) => IrFunction | undefined {
  return (name) => fns.find((fn) => fn.name === name);
}

const noUnions = (): undefined => undefined;

describe("conversionCopy", () => {
  test("a value that only gains a union tag is kept", () => {
    const operand = taken(CIRCLE);
    expect(conversionCopy(wrap(operand), operand, lookup(), noUnions)).toBeNull();
  });

  test("an array converted to another element type is a copy", () => {
    const operand = taken(CIRCLES);
    const conversion = call(`${COPY_HELPERS.arr}.0`, operand, SHAPES);
    expect(conversionCopy(conversion, operand, lookup(), noUnions)).toEqual({
      kind: "arr",
      from: CIRCLES,
      to: SHAPES,
    });
  });

  test("a copy under a union tag is a copy", () => {
    const operand = taken(CIRCLE);
    const wider: IrType = { kind: "record", shapeId: "wider" };
    const conversion = wrap(call(`${COPY_HELPERS.width}.0`, operand, wider));
    expect(conversionCopy(conversion, operand, lookup(), noUnions)?.kind).toBe("width");
  });

  test("a number converts freely, whatever the conversion calls", () => {
    const operand = taken(F64);
    const conversion = call(`${COPY_HELPERS.arr}.0`, operand, SHAPES);
    expect(conversionCopy(conversion, operand, lookup(), noUnions)).toBeNull();
  });

  test("an object built in place of the value is a copy", () => {
    const operand = taken(CIRCLE);
    const conversion: IrExpr = {
      kind: "recordLit",
      fields: [{ name: "r", value: operand }],
      type: { kind: "record", shapeId: "wider" },
      loc,
    };
    expect(conversionCopy(conversion, operand, lookup(), noUnions)?.kind).toBe("other");
  });

  const v: IrExpr = { kind: "varRef", localId: "v.0", type: CIRCLE, loc };
  const isCircle: IrExpr = {
    kind: "unionIsTag",
    unionId: "shape",
    tag: 0,
    negated: false,
    value: v,
    type: { kind: "bool" },
    loc,
  };
  const tagged: IrStmt = {
    kind: "if",
    cond: isCircle,
    then: [{ kind: "return", value: wrap(v), loc }],
    else_: null,
    loc,
  };

  test("a routing helper whose arms all tag the value keeps it", () => {
    const name = `${ROUTING_HELPERS.recordWrap}.0`;
    const route = helper(name, CIRCLE, SHAPE, [tagged, { kind: "return", value: wrap(v), loc }]);
    const operand = taken(CIRCLE);
    const conversion = call(name, operand, SHAPE);
    expect(conversionCopy(conversion, operand, lookup(route), noUnions)).toBeNull();
  });

  test("a routing helper that copies in one arm copies", () => {
    const name = `${ROUTING_HELPERS.recordRoute}.0`;
    const wider: IrType = { kind: "record", shapeId: "wider" };
    const copied = wrap(call(`${COPY_HELPERS.width}.0`, v, wider));
    const route = helper(name, CIRCLE, SHAPE, [tagged, { kind: "return", value: copied, loc }]);
    const operand = taken(CIRCLE);
    const conversion = call(name, operand, SHAPE);
    expect(conversionCopy(conversion, operand, lookup(route), noUnions)).toEqual({
      kind: "width",
      from: CIRCLE,
      to: wider,
    });
  });

  test("a routing helper that is not in the program is not trusted", () => {
    const operand = taken(CIRCLE);
    const conversion = call(`${ROUTING_HELPERS.retag}.0`, operand, SHAPE);
    expect(conversionCopy(conversion, operand, lookup(), noUnions)?.kind).toBe("other");
  });

  const narrowFn: IrType = { kind: "func", params: [CIRCLES], ret: F64 };
  const wideFn: IrType = { kind: "func", params: [SHAPES], ret: F64 };

  test("an adapter that only forwards keeps the function", () => {
    const body = helper("%closure.0", F64, F64, [{ kind: "return", value: v, loc }]);
    const adapter = helper("%fn.adapt.0", narrowFn, wideFn, [
      {
        kind: "return",
        value: { kind: "closure", fnName: "%closure.0", captures: [], type: wideFn, loc },
        loc,
      },
    ]);
    const operand = taken(narrowFn);
    const conversion = call("%fn.adapt.0", operand, wideFn);
    expect(conversionCopy(conversion, operand, lookup(adapter, body), noUnions)).toBeNull();
  });

  test("an adapter whose closure copies an argument of each call copies", () => {
    const argument: IrExpr = { kind: "varRef", localId: "v.0", type: SHAPES, loc };
    const body = helper("%closure.1", SHAPES, F64, [
      { kind: "exprStmt", expr: call(`${COPY_HELPERS.arr}.1`, argument, CIRCLES), loc },
    ]);
    const adapter = helper("%fn.adapt.1", narrowFn, wideFn, [
      {
        kind: "return",
        value: { kind: "closure", fnName: "%closure.1", captures: [], type: wideFn, loc },
        loc,
      },
    ]);
    const operand = taken(narrowFn);
    const conversion = call("%fn.adapt.1", operand, wideFn);
    expect(conversionCopy(conversion, operand, lookup(adapter, body), noUnions)?.kind).toBe("arr");
  });

  test("a checked conversion copies a layout and keeps a promise of numbers", () => {
    const checked = (from: IrType, to: IrType): [IrExpr, IrExpr] => {
      const operand = taken(from);
      const boxed: IrExpr = { kind: "dynFrom", value: operand, type: DYN, loc };
      return [{ kind: "dynCheck", value: boxed, type: to, loc }, operand];
    };
    const arms = (id: string): readonly IrType[] | undefined =>
      id === "f64|string" ? [F64, { kind: "string" }] : undefined;
    const [numbers, numbersOperand] = checked(
      { kind: "promise", inner: F64 },
      { kind: "promise", inner: { kind: "union", unionId: "f64|string" } },
    );
    expect(conversionCopy(numbers, numbersOperand, lookup(), arms)).toBeNull();
    const [lists, listsOperand] = checked(
      { kind: "promise", inner: CIRCLES },
      { kind: "promise", inner: SHAPES },
    );
    expect(conversionCopy(lists, listsOperand, lookup(), arms)).toEqual({
      kind: "checked",
      from: CIRCLES,
      to: SHAPES,
    });
  });
});
