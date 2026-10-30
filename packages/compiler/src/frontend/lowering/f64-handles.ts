import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** Whether `node`'s value is an f64 handle: an object whose class
 * type-mapper.ts represents as an f64 id into a runtime registry (a
 * readline Interface, a Timeout or Immediate, an AsyncLocalStorage, a
 * diagnostics_channel Channel). Its checker type is an object type that
 * maps to f64; the Number wrapper interface maps to f64 for primitives. */
export function isF64HandleTyped(lowerer: Lowerer, node: ts.Node): boolean {
  const type = lowerer.checker.getTypeAtLocation(node);
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const symbol = type.getSymbol();
  if (symbol !== undefined && ts.symbolName(symbol) === "Number") return false;
  return lowerer.mapTypeOf(type)?.kind === "f64";
}
