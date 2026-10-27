import type { IrExpr, IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { accessorCall } from "./lower-classes.js";
import { iterableGenerator, iterableUnionOf } from "./iterable-values.js";

/** The generator a class instance's `[Symbol.iterator]` returns, when that
 * method is a generator method taking no arguments (or the iterator an
 * Iterable<T> value opens over its current arm): `obj[Symbol.iterator]()`,
 * called once, as for-of, spread and Array.from call it. Null for other
 * values, and for classes whose iterator the program can replace at run
 * time (an instance property, a prototype write). */
export function classGeneratorIterable(lowerer: Lowerer, value: IrExpr): IrExpr | null {
  // An Iterable<T> value opens an iterator over its current arm.
  const iterable = iterableUnionOf(lowerer, value.type);
  if (iterable) return iterableGenerator(lowerer, value, iterable);
  if (value.type.kind !== "object" || !iteratesThroughGenerator(lowerer, value.type)) return null;
  const className = value.type.className;
  const ret = lowerer.findMethodOn(lowerer.classes.get(className)!, "sym:iterator")!.sig.ret;
  return accessorCall(lowerer, className, "sym:iterator", value, [], ret, value.loc);
}

/** Whether values of `type` iterate through a generator method (the check
 * classGeneratorIterable makes, from the type alone). */
export function iteratesThroughGenerator(lowerer: Lowerer, type: IrType): boolean {
  if (iterableUnionOf(lowerer, type)) return true;
  if (type.kind !== "object") return false;
  const info = lowerer.classes.get(type.className);
  if (!info || info.def.runtime || info.fields.has("sym:iterator")) return false;
  if (
    lowerer.prototypeMethodAccesses.has("sym:iterator") ||
    lowerer.replacedSymbolMethods.has("sym:iterator")
  )
    return false;
  const found = lowerer.findMethodOn(info, "sym:iterator");
  return (
    !!found &&
    found.sig.params.length === 0 &&
    found.sig.ret.kind === "generator" &&
    !found.sig.ret.async
  );
}
