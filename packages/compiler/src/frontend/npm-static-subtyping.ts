import * as ts from "./ts7/adapter.js";
import { npmStaticPackageOfPath } from "./npm-static.js";

/** JS subclasses can extend inferred fields and method arities. The native
 * class collector validates their shared layout and dispatch ABI; a consumer
 * upcast should not fail solely on the checker's structural override model. */
export function isNpmStaticSubclassArgument(
  program: ts.Program,
  diagnostic: ts.Diagnostic,
): boolean {
  if (diagnostic.code !== 2345 || diagnostic.fileName === undefined) return false;
  const source = program.getSourceFile(diagnostic.fileName);
  if (!source) return false;
  const checker = program.getTypeChecker();
  const runtimeClass = (type: ts.Type): boolean => {
    const symbol = type.getSymbol();
    return (
      symbol !== undefined &&
      symbol.declarations.some(
        (declaration) =>
          (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) &&
          /\.[cm]?js$/.test(ts.getSourceFileOfNode(declaration).fileName) &&
          npmStaticPackageOfPath(ts.getSourceFileOfNode(declaration).fileName) !== null,
      )
    );
  };
  const subtype = (actual: ts.Type, expected: ts.Type): boolean => {
    if (!runtimeClass(actual)) return false;
    const targets = expected.isUnionType() ? ts.constituentTypes(expected) : [expected];
    const seen = new Set<ts.Type>();
    const visit = (type: ts.Type): boolean => {
      const target = type.isTypeReference() ? type.getTarget() : type;
      if (!target?.isClassOrInterface() || seen.has(target)) return false;
      seen.add(target);
      for (const base of checker.getBaseTypes(type.isClassOrInterface() ? type : target)) {
        if (
          targets.some(
            (expected) =>
              runtimeClass(expected) &&
              base.getSymbol() === expected.getSymbol() &&
              checker.isTypeAssignableTo(base, expected),
          )
        )
          return true;
        if (visit(base)) return true;
      }
      return false;
    };
    return visit(actual);
  };
  let accepted = false;
  ts.walkPreorder(source, (node) => {
    if (node.end < diagnostic.pos || ts.tokenStartOfNode(node) > diagnostic.end) return "skip";
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return undefined;
    const index =
      node.arguments?.nodes.findIndex(
        (argument) =>
          ts.tokenStartOfNode(argument) === diagnostic.pos && argument.end === diagnostic.end,
      ) ?? -1;
    if (index < 0) return undefined;
    const parameter = checker.getResolvedSignature(node)?.getParameters()[index];
    if (parameter && node.arguments?.nodes)
      accepted = subtype(
        checker.getTypeAtLocation(node.arguments.nodes[index]!),
        checker.getTypeOfSymbol(parameter),
      );
    return undefined;
  });
  return accepted;
}
