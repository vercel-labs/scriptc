import * as ts from "../ts7/adapter.js";

/** A `Pick<C, K>` / `Omit<C, K>` view: the lib alias it instantiates and
 * its source type argument `C`. */
export interface ClassView {
  name: "Pick" | "Omit";
  source: ts.Type;
}

/** The lib's Pick or Omit alias (declared only in declaration files). */
function libViewName(symbol: ts.Symbol): "Pick" | "Omit" | null {
  const name = ts.symbolName(symbol);
  if (name !== "Pick" && name !== "Omit") return null;
  return symbol.declarations.every((d) => ts.getSourceFileOfNode(d).isDeclarationFile)
    ? name
    : null;
}

/** `type` as a Pick/Omit view, spelled inline (`Pick<C, K>`) or through
 * non-generic user aliases (`type View = Pick<C, K>`, `type V2 = View`).
 * An aliased instantiation carries the USER's alias symbol and no alias
 * type arguments, so the alias declaration's type node names the view.
 * Generic user aliases (`type V<T> = Pick<T, K>`) are not resolved. */
export function classViewOf(checker: ts.TypeChecker, type: ts.Type, depth = 0): ClassView | null {
  const alias = type.getAliasSymbol();
  if (alias === undefined) return null;
  const direct = libViewName(alias);
  if (direct !== null) {
    const source = type.getAliasTypeArguments()[0];
    return source === undefined ? null : { name: direct, source };
  }
  if (depth >= 8 || type.getAliasTypeArguments().length > 0) return null;
  const decl = alias.declarations.find(ts.isTypeAliasDeclaration);
  if (decl === undefined || (decl.typeParameters?.nodes.length ?? 0) > 0) return null;
  let node: ts.TypeNode = decl.type;
  while (ts.isParenthesizedTypeNode(node)) node = node.type;
  if (!ts.isTypeReferenceNode(node)) return null;
  let target = checker.getSymbolAtLocation(node.typeName);
  if (target !== undefined && (target.flags & ts.SymbolFlags.Alias) !== 0)
    target = checker.getAliasedSymbol(target);
  if (target === undefined) return null;
  const viewName = libViewName(target);
  if (viewName !== null) {
    const argument = node.typeArguments?.nodes[0];
    return argument === undefined
      ? null
      : { name: viewName, source: checker.getTypeFromTypeNode(argument) };
  }
  if ((target.flags & ts.SymbolFlags.TypeAlias) === 0) return null;
  return classViewOf(checker, checker.getDeclaredTypeOfSymbol(target), depth + 1);
}
