import * as ts from "./ts7/adapter.js";
import { bodyReadsArguments } from "./arguments-usage.js";
import { isJsSourceFileName } from "./tsc-codes.js";

/** Inferred JavaScript signatures can understate executable bodies. Only
 * forgive a checker diagnostic when that body proves the rejected form;
 * authored TypeScript/JSDoc signatures retain their own contract. */
export function inferredJsDiagnosticSuppressed(
  program: ts.Program,
  diagnostic: ts.Diagnostic,
): boolean {
  if (diagnostic.fileName === undefined || ![2554, 2490, 2565].includes(diagnostic.code))
    return false;
  const file = program.getSourceFile(diagnostic.fileName);
  if (!file) return false;
  const checker = program.getTypeChecker();
  let suppressed = false;
  ts.walkPreorder(file, (node) => {
    if (node.end < diagnostic.pos || ts.tokenStartOfNode(node) > diagnostic.end) return "skip";
    if (
      diagnostic.code === 2565 &&
      isJsSourceFileName(file.fileName) &&
      ts.isPropertyAccessExpression(node)
    ) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (
        symbol &&
        symbol.declarations.some(
          (decl) =>
            ts.isPropertyDeclaration(decl) &&
            !decl.type &&
            !decl.initializer &&
            !/@type\b/.test(file.text.slice(decl.pos, ts.tokenStartOfNode(decl))),
        )
      ) {
        // Bare JS fields exist with value undefined before the first write;
        // native storage includes that arm even when inference omits it.
        suppressed = true;
        return "stop";
      }
    }
    if (diagnostic.code === 2554 && ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node);
      const declaration = signature && signature.declaration;
      if (
        declaration &&
        isJsSourceFileName(ts.getSourceFileOfNode(declaration).fileName) &&
        (ts.isFunctionDeclaration(declaration) ||
          ts.isFunctionExpression(declaration) ||
          ts.isMethodDeclaration(declaration)) &&
        node.arguments.nodes.length > declaration.parameters.nodes.length &&
        ts.tokenStartOfNode(node.arguments.nodes[declaration.parameters.nodes.length]!) ===
          diagnostic.pos &&
        node.arguments.nodes[node.arguments.nodes.length - 1]!.end === diagnostic.end &&
        bodyReadsArguments(declaration)
      ) {
        suppressed = true;
        return "stop";
      }
    }
    if (
      diagnostic.code === 2490 &&
      ts.isYieldExpression(node) &&
      node.asteriskToken &&
      node.expression &&
      ts.flattenDiagnosticMessageText(diagnostic, " ").includes("'throw()'")
    ) {
      const iterable = checker.getTypeAtLocation(node.expression);
      const iterator = checker
        .getPropertiesOfType(iterable)
        .find((property) => ts.symbolName(property).startsWith("__@iterator@"));
      if (!iterator) return undefined;
      const signatures = checker.getCallSignatures(
        checker.getTypeOfSymbolAtLocation(iterator, node.expression),
      );
      if (signatures.length !== 1) return undefined;
      const iteratorType = checker.getReturnTypeOfSignature(signatures[0]!);
      const throwMethod = checker.getPropertyOfType(iteratorType, "throw");
      if (!throwMethod) return undefined;
      const throwSignatures = checker.getCallSignatures(
        checker.getTypeOfSymbolAtLocation(throwMethod, node.expression),
      );
      const declaration =
        throwSignatures.length === 1 ? throwSignatures[0]!.declaration : undefined;
      // A sole throw cannot return an invalid IteratorResult. Avoid inferring
      // termination through arbitrary control flow or explicit return types.
      if (
        declaration &&
        ts.isMethodDeclaration(declaration) &&
        declaration.type === undefined &&
        isJsSourceFileName(ts.getSourceFileOfNode(declaration).fileName) &&
        declaration.body?.statements?.nodes.length === 1 &&
        ts.isThrowStatement(declaration.body.statements.nodes[0]!)
      ) {
        suppressed = true;
        return "stop";
      }
    }
    return undefined;
  });
  return suppressed;
}
