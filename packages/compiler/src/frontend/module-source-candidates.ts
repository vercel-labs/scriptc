import * as ts from "./ts7/adapter.js";

export interface ModuleSourceCandidates {
  calls: ts.CallExpression[];
  specifiers: string[];
}

const MODULE_SOURCE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.CallExpression,
]);

/** Root discovery and import admission inspect the same immutable syntax.
 * Share only their syntactic candidates: binding, filesystem resolution,
 * and admission decisions still run in each consumer's current context. */
export function moduleSourceCandidates(
  program: ts.Program,
  source: ts.SourceFile,
): ModuleSourceCandidates {
  const cached = program.analysis.moduleSourceCandidates.get(source);
  if (cached !== undefined) return cached;
  const result: ModuleSourceCandidates = { calls: [], specifiers: [] };
  ts.walkPreorder(
    source,
    (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        result.specifiers.push(node.moduleSpecifier.text);
        return "skip";
      }
      if (ts.isCallExpression(node)) {
        result.calls.push(node);
        const arg = node.arguments[0];
        if (
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
          arg !== undefined &&
          ts.isStringLiteralLike(arg)
        ) {
          result.specifiers.push(arg.text);
        }
      }
      return undefined;
    },
    MODULE_SOURCE_KINDS,
  );
  program.analysis.moduleSourceCandidates.set(source, result);
  return result;
}
