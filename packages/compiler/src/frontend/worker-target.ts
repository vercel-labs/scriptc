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
import { resolveWorkerEntrySource } from "./resolve.js";
import {
  boundLoadValues,
  specifierBoundContextOf,
  type SpecifierBoundContext,
  type SpecifierValue,
} from "./specifier-bounds.js";

function workerNamespace(program: ts.Program, expression: ts.Expression): boolean {
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    isNodeGlobal(program, expression.expression) &&
    expression.arguments.nodes.length === 1 &&
    ts.isStringLiteralLike(expression.arguments.nodes[0]!)
  )
    return canonicalBuiltinModule(expression.arguments.nodes[0]!.text) === "worker_threads";
  if (!ts.isIdentifier(expression)) return false;
  if (isBuiltinNamespaceImport(program, expression, "worker_threads")) return true;
  const checker = program.getTypeChecker(),
    symbol = checker.getSymbolAtLocation(expression);
  const declaration = symbol ? symbol.declarations[0] : undefined;
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
  const declaration = symbol ? symbol.declarations[0] : undefined;
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
    if (isNodeGlobal(program, expression))
      return resolve(ts.getSourceFileOfNode(expression).fileName);
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

/** The compiled source behind a worker entry path (see
 * resolveWorkerEntrySource). An unresolvable path stays as spelled, so
 * program loading reports the missing file. */
export function workerSourcePath(path: string): string {
  return resolveWorkerEntrySource(path) ?? path;
}

/** The path a bounded Worker entry value names, as Node resolves the Worker
 * filename: a URL through fileURLToPath, an absolute path as itself. A
 * relative string is resolved against the invocation's cwd in Node, so it
 * fixes no build-time file and stays in the residual arm. */
export function workerEntryValuePath(value: SpecifierValue): string | null {
  try {
    if (value.kind === "url") return fileURLToPath(value.href);
    return isAbsolute(value.text) ? resolve(value.text) : null;
  } catch {
    return null;
  }
}

/** The compiled sources a computed Worker entry may name (wave2 §4.2): every
 * value the shared specifier bounder answers, resolved the way Node resolves
 * the filename. Values that name no build-time file — the Top residual, a
 * cwd-relative string — are absent, and so is a bounded value whose file
 * does not exist: a bound is a superset of what the site loads, so a missing
 * file is the site's run-time ERR_SCRIPTC_WORKER_ENTRY arm (boundedWorkerArms
 * gives it no native arm), not a root whose absence fails the build. A
 * written literal keeps reporting its missing file (workerSourcePath). */
function boundedWorkerEntrySources(
  ctx: SpecifierBoundContext,
  expression: ts.Expression,
): string[] {
  const bound = boundLoadValues(ctx, expression);
  if (bound.kind === "top") return [];
  const sources: string[] = [];
  for (const value of bound.values) {
    const path = workerEntryValuePath(value);
    const source = path === null ? null : resolveWorkerEntrySource(path);
    if (source !== null && !sources.includes(source)) sources.push(source);
  }
  return sources;
}

export function workerTargetPaths(program: ts.Program, files: readonly ts.SourceFile[]): string[] {
  const targets = new Set<string>();
  const checker = program.getTypeChecker();
  let ctx: SpecifierBoundContext | null = null;
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
      if (!isWorkerConstructor(program, expression) || !construction.arguments?.nodes[0]) continue;
      const path = workerModulePath(program, construction.arguments.nodes[0]);
      if (path !== null) {
        targets.add(workerSourcePath(path));
        continue;
      }
      ctx ??= specifierBoundContextOf(program);
      for (const source of boundedWorkerEntrySources(ctx, construction.arguments.nodes[0]))
        targets.add(source);
    }
  }
  return [...targets];
}
