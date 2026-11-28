/* The declaration projection's iteration markers.
 *
 * For a loop over an iterable a package produces, the projection wraps the
 * iterable in a generated marker call (decl-projection.ts,
 * `__scriptc_iter_N(src)`). The marker's generated declaration answers the
 * declaration world's element type for the loop binding, so the body narrows
 * as tsc does, while the value the loop iterates is still the wrapped
 * expression. The lowering recognizes the marker by its name and its
 * ambient declaration in the generated file, and treats the call as its
 * argument. */
import * as ts from "../ts7/adapter.js";
import { isDeclBoundaryFile, isDeclIterMarkerName } from "../decl-projection.js";
import type { Lowerer } from "./lowerer.js";

/** The iterable expression a projection marker wraps, or null for any other
 * call. */
export function declIterationSource(lowerer: Lowerer, node: ts.Node): ts.Expression | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isIdentifier(callee) || !isDeclIterMarkerName(callee.text)) return null;
  const args = node.arguments.nodes;
  if (args.length !== 1) return null;
  const source = args[0]!;
  if (ts.isSpreadElement(source)) return null;
  let symbol: ts.Symbol | undefined;
  try {
    symbol = lowerer.checker.getSymbolAtLocation(callee);
  } catch {
    return null;
  }
  const declaration = symbol?.valueDeclaration;
  if (declaration === undefined || !ts.isFunctionDeclaration(declaration)) return null;
  if (declaration.body !== undefined) return null;
  if (!isDeclBoundaryFile(ts.getSourceFileOfNode(declaration).fileName)) return null;
  return source;
}
