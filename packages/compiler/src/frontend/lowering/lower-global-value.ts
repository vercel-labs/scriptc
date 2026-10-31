import * as ts from "../ts7/adapter.js";
import { DYN, STRING, arrayOf, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { TEMPORAL_GLOBAL } from "../builtin-modules.js";

/** A stored global object has identity and survives module/function boundaries.
 * Known globals without a value implementation refuse at runtime; absent host
 * capabilities answer undefined. The checker supplies names, never values. */
export function lowerGlobalValue(lowerer: Lowerer, expr: ts.Expression): IrExpr {
  return lowerGlobalValueOfType(lowerer, lowerer.typeOf(expr), locOf(expr));
}

/** The global object a sloppy-mode function receives as `this` when it is
 * called with undefined or null: the value `globalThis` reads. */
export function lowerSloppyGlobalReceiver(lowerer: Lowerer, node: ts.Node, loc: SrcLoc): IrExpr {
  const symbol = lowerer.checker.resolveName(
    "globalThis",
    ts.SymbolFlags.Value,
    ts.getSourceFileOfNode(node),
    false,
  );
  return lowerGlobalValueOfType(
    lowerer,
    symbol === undefined ? undefined : lowerer.checker.getTypeOfSymbol(symbol),
    loc,
  );
}

function lowerGlobalValueOfType(lowerer: Lowerer, type: ts.Type | undefined, loc: SrcLoc): IrExpr {
  // The temporal global is typed for the programs that name it (TS 7's
  // lib slice) but absent in Node 24: reads answer undefined.
  const names = (type === undefined ? [] : lowerer.checker.getPropertiesOfType(type))
    .map((property) => ts.symbolName(property))
    .filter((name) => name !== TEMPORAL_GLOBAL);
  return {
    kind: "libCall",
    fn: "global.native",
    // One immortal name table per program (keyed by its contents): reading
    // the global object in a hot path allocates nothing, and the runtime
    // recognizes a table it has already registered.
    args: [
      {
        kind: "templateStrings",
        key: `%globalThis.names:${names.join(",")}`,
        cooked: names,
        type: arrayOf(STRING),
        loc,
      },
    ],
    type: DYN,
    loc,
  };
}
