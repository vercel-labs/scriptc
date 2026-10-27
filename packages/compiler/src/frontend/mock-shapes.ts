/* node:test's mock function representation. A Mock<F> is the hybrid
 * record { %call: F, mock: MockFunctionContext<F> } (type-mapper.ts's
 * function-with-properties mapping). The context is a record the wrapper
 * closure and the mock field share:
 *
 *   calls       MockFunctionCall<F>[]  the call log, read as a copy
 *   %impl       F                       the current implementation
 *   %original   F                       the implementation restore() brings back
 *   %once       { at, fn }[]            mockImplementationOnce, by call index
 *   %unmock     (() => void)[]          for mock.method, the closure that
 *                                       writes the original back to the
 *                                       object; empty for mock.fn
 *
 * A MockFunctionCall<F> is { arguments, error, result, this }: the
 * arguments as a tuple of F's parameters (a checked-dynamic array for
 * mock.fn()'s `(...args: any[]) => undefined`), the result as F's return
 * type or undefined (a checked-dynamic value for functions returning void
 * or undefined, since a record field cannot have a unit type), and error
 * and this as checked-dynamic values. */
import { DYN, F64, NULL_T, UNDEFINED_T, VOID, typeKey, type IrType } from "../ir/ir.js";
import type { TypeMapperCtx } from "./type-mapper.js";

/** The mock records intern into the type mapper's registries. */
export type MockShapeRegistries = TypeMapperCtx;

/** `T | undefined`, as the checker's `ReturnType | undefined` maps. */
function orUndefined(t: IrType, reg: MockShapeRegistries): IrType {
  if (t.kind === "void" || t.kind === "undefinedT") return DYN;
  if (t.kind === "dyn") return t;
  const arms = t.kind === "union" ? [...(reg.unions.get(t.unionId)?.arms ?? [])] : [t];
  if (arms.some((a) => a.kind === "undefinedT")) return t;
  arms.push(UNDEFINED_T);
  arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: reg.unions.intern(arms) };
}

/** The arguments type of a call record: a tuple of the parameters, or the
 * rest array itself for a function whose only parameter is a rest array,
 * or a checked-dynamic array for a function returning nothing whose only
 * parameter is a checked-dynamic rest (mock.fn()'s default, `(...args:
 * any[]) => undefined`). Null for other rest shapes. A function without parameters records the
 * empty tuple, which maps to an array of the unit-only union, as
 * type-mapper.ts maps `[]`. */
function mockArgumentsType(fn: IrType & { kind: "func" }, reg: MockShapeRegistries): IrType | null {
  if (fn.rest && fn.restAbi === undefined) {
    const returnsNothing = fn.ret.kind === "void" || fn.ret.kind === "undefinedT";
    return fn.params.length === 0 && returnsNothing ? DYN : null;
  }
  if (fn.rest) {
    if (fn.params.length !== 1 || fn.params[0]!.kind !== "array") return null;
    return fn.params[0]!;
  }
  if (fn.params.length === 0) {
    const arms = [NULL_T, UNDEFINED_T].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    return { kind: "array", elem: { kind: "union", unionId: reg.unions.intern(arms) } };
  }
  const fields = fn.params.map((type, i) => ({ name: String(i), type }));
  return { kind: "record", shapeId: reg.shapes.intern(fields, true) };
}

export function mockCallRecordType(
  fn: IrType & { kind: "func" },
  reg: MockShapeRegistries,
): IrType | null {
  const args = mockArgumentsType(fn, reg);
  if (args === null) return null;
  const fields = [
    { name: "arguments", type: args },
    { name: "error", type: DYN },
    { name: "result", type: orUndefined(fn.ret, reg) },
    { name: "this", type: DYN },
  ];
  return {
    kind: "record",
    shapeId: reg.shapes.intern(fields, false, undefined, ["arguments", "error", "result", "this"]),
  };
}

export function mockContextType(
  fn: IrType & { kind: "func" },
  reg: MockShapeRegistries,
): IrType | null {
  const call = mockCallRecordType(fn, reg);
  if (call === null) return null;
  const onceEntry: IrType = {
    kind: "record",
    shapeId: reg.shapes.intern([
      { name: "at", type: F64 },
      { name: "fn", type: fn },
    ]),
  };
  const fields = [
    { name: "%impl", type: fn },
    { name: "%once", type: { kind: "array", elem: onceEntry } as IrType },
    { name: "%original", type: fn },
    {
      name: "%unmock",
      type: { kind: "array", elem: { kind: "func", params: [], ret: VOID } } as IrType,
    },
    { name: "calls", type: { kind: "array", elem: call } as IrType },
  ];
  return { kind: "record", shapeId: reg.shapes.intern(fields, false, undefined, ["calls"]) };
}

/** Mock<F>: the hybrid record { %call: F, mock: MockFunctionContext<F> },
 * interned as type-mapper.ts's function-with-properties mapping interns it. */
export function mockType(fn: IrType & { kind: "func" }, reg: MockShapeRegistries): IrType | null {
  const ctx = mockContextType(fn, reg);
  if (ctx === null) return null;
  const fields = [
    { name: "%call", type: fn },
    { name: "mock", type: ctx },
  ];
  return { kind: "record", shapeId: reg.shapes.intern(fields, false, undefined, ["mock"]) };
}
