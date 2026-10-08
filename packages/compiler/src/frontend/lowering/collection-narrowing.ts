import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** instanceof uses Map<any, any>/Set<any> in the standard declarations.
 * Recover an unambiguous native collection's stored arguments when that
 * test erased a readonly view's arguments. Never choose between layouts. */
export function concreteCollectionNarrow(
  lowerer: Lowerer,
  node: ts.Node,
  narrowed: ts.Type,
): ts.Type | null {
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return null;
  const symbol = narrowed.getSymbol();
  const name = symbol?.name;
  if (name !== "Map" && name !== "Set") return null;
  if (
    !symbol ||
    !lowerer.checker
      .declarationsOf(symbol)
      .some((decl) => lowerer.isStdlibFile(decl.getSourceFile()))
  )
    return null;
  const args = lowerer.checker.getTypeArguments(narrowed as ts.TypeReference);
  if (args.length === 0 || !args.every((arg) => (arg.flags & ts.TypeFlags.Any) !== 0)) return null;
  const binding = lowerer.checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(node) ? node.name : node,
  );
  if (!binding) return null;
  const stored = lowerer.checker.getTypeOfSymbol(binding);
  const arms = stored.isUnionType() ? ts.constituentTypes(stored) : [stored];
  const candidates = arms.filter((arm) => {
    const mapped = lowerer.mapTypeOf(arm);
    return mapped?.kind === (name === "Map" ? "map" : "set");
  });
  return candidates.length === 1 ? candidates[0]! : null;
}
