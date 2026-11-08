import * as ts from "../../ts7/adapter.js";
import { SYMBOL_T, type IrExpr } from "../../../ir/ir.js";
import type { Lowerer } from "../lowerer.js";
import { stdlibGlobalNameOf } from "../surfaces.js";

/** Symbol keys have runtime identity and never overlap the statically
 * resolved builtin globals. Keep their shared native storage across modules. */
export function globalSymbolKey(
  lowerer: Lowerer,
  receiver: ts.Expression,
  key: ts.Expression,
): IrExpr | null {
  if (
    stdlibGlobalNameOf(lowerer, receiver) !== "globalThis" ||
    lowerer.mapTypeOf(lowerer.typeOf(key))?.kind !== "symbol"
  )
    return null;
  const value = lowerer.lowerExpr(key);
  if (value.type.kind === "symbol") return value;
  // A symbol the checker types and the value holds untyped (a JavaScript
  // loop variable or callback parameter over an array of symbols): the
  // checked conversion yields the symbol, so the access reaches the symbol
  // store instead of the string conversion, which throws for a symbol.
  if (value.type.kind !== "dyn") return null;
  const checked = lowerer.coerceToExpected(value, SYMBOL_T);
  return checked.type.kind === "symbol" ? checked : null;
}
