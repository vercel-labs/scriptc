import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "./ts7/adapter.js";
import {
  isNodeGlobal,
  isBuiltinMemberImport,
  isBuiltinNamespaceImport,
  staticForkString,
} from "./fork-target.js";
import { moduleSourceCandidates } from "./module-source-candidates.js";
import { canonicalBuiltinModule } from "./builtin-modules.js";

function workerNamespace(program: ts.Program, expression: ts.Expression): boolean {
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    isNodeGlobal(program, expression.expression) &&
    expression.arguments.length === 1 &&
    ts.isStringLiteralLike(expression.arguments[0]!)
  )
    return canonicalBuiltinModule(expression.arguments[0]!.text) === "worker_threads";
  if (!ts.isIdentifier(expression)) return false;
  if (isBuiltinNamespaceImport(program, expression, "worker_threads")) return true;
  const checker = program.getTypeChecker(),
    symbol = checker.getSymbolAtLocation(expression);
  const declaration = symbol ? checker.declarationsOf(symbol)[0] : undefined;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    declaration.initializer !== undefined &&
    ts.isCallExpression(declaration.initializer) &&
    workerNamespace(program, declaration.initializer)
  );
}

/** Share constructor provenance between root discovery and lowering. Local
 * classes and shadowed require functions must never add native worker roots. */
export function isWorkerConstructor(program: ts.Program, expression: ts.Expression): boolean {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertion(expression) ||
    ts.isNonNullExpression(expression)
  )
    expression = expression.expression;
  if (ts.isPropertyAccessExpression(expression))
    return expression.name.text === "Worker" && workerNamespace(program, expression.expression);
  if (!ts.isIdentifier(expression)) return false;
  if (isBuiltinMemberImport(program, expression, "worker_threads", "Worker")) return true;
  const checker = program.getTypeChecker(),
    symbol = checker.getSymbolAtLocation(expression);
  const declaration = symbol ? checker.declarationsOf(symbol)[0] : undefined;
  if (
    declaration &&
    ts.isBindingElement(declaration) &&
    ts.isObjectBindingPattern(declaration.parent)
  ) {
    const variable = declaration.parent.parent;
    const member = declaration.propertyName ?? declaration.name;
    return (
      ts.isIdentifier(member) &&
      member.text === "Worker" &&
      ts.isVariableDeclaration(variable) &&
      ts.isVariableDeclarationList(variable.parent) &&
      (variable.parent.flags & ts.NodeFlags.Const) !== 0 &&
      variable.initializer !== undefined &&
      workerNamespace(program, variable.initializer)
    );
  }
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    declaration.initializer !== undefined &&
    ts.isPropertyAccessExpression(declaration.initializer) &&
    isWorkerConstructor(program, declaration.initializer)
  );
}

export function workerModulePath(program: ts.Program, expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression) && expression.text === "__filename") {
    if (isNodeGlobal(program, expression)) return resolve(expression.getSourceFile().fileName);
  }
  const value = staticForkString(program, expression);
  if (value === null) return null;
  try {
    if (value.startsWith("file:")) return fileURLToPath(value);
    // Relative string filenames are resolved against the invocation's cwd in
    // Node. Only absolute paths and source-relative URLs fix the build graph.
    return isAbsolute(value) ? resolve(value) : null;
  } catch {
    return null;
  }
}

export function workerTargetPaths(program: ts.Program, files: readonly ts.SourceFile[]): string[] {
  const targets = new Set<string>();
  const checker = program.getTypeChecker();
  for (const source of files) {
    if (source.isDeclarationFile || source.fileName.endsWith(".json")) continue;
    const constructions = moduleSourceCandidates(program, source).constructions;
    checker.prefetchSymbolNodesExact(
      constructions.flatMap(({ expression }) =>
        ts.isIdentifier(expression)
          ? [expression]
          : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
            ? [expression.expression]
            : [],
      ),
    );
    for (const construction of constructions) {
      const expression = construction.expression;
      if (!isWorkerConstructor(program, expression) || !construction.arguments?.[0]) continue;
      const path = workerModulePath(program, construction.arguments[0]);
      if (path !== null) targets.add(path);
    }
  }
  return [...targets];
}
