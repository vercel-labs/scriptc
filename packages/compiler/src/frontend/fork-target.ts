import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "./ts7/adapter.js";
import { canonicalBuiltinModule } from "./builtin-modules.js";
import { moduleSourceCandidates } from "./module-source-candidates.js";

function strip(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertion(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** True when an identifier is a named import of one Node builtin member.
 * The declaration-file fallback preserves re-export facades in the same
 * way as lowering's builtinImportOf helper. */
export function isBuiltinMemberImport(
  program: ts.Program,
  ident: ts.Identifier,
  moduleName: string,
  memberName: string,
): boolean {
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(ident);
  const decl = symbol ? checker.declarationsOf(symbol)[0] : undefined;
  if (decl !== undefined && ts.isImportSpecifier(decl)) {
    const importDecl = decl.parent?.parent?.parent;
    if (ts.isImportDeclaration(importDecl) && ts.isStringLiteral(importDecl.moduleSpecifier)) {
      const member = decl.propertyName?.text ?? decl.name.text;
      if (
        canonicalBuiltinModule(importDecl.moduleSpecifier.text) === moduleName &&
        member === memberName
      ) {
        return true;
      }
    }
  }
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const target = checker.getAliasedSymbol(symbol);
    const targetDecl = checker.declarationsOf(target)[0];
    if (targetDecl !== undefined && targetDecl.getSourceFile().isDeclarationFile) {
      for (
        let parent: ts.Node | undefined = targetDecl.parent;
        parent !== undefined && !ts.isSourceFile(parent);
        parent = parent.parent
      ) {
        if (ts.isModuleDeclaration(parent) && ts.isStringLiteral(parent.name)) {
          return (
            canonicalBuiltinModule(parent.name.text) === moduleName && target.name === memberName
          );
        }
      }
    }
  }
  return false;
}

/** True when an identifier is the namespace/default binding for one Node
 * builtin module. JavaScript default imports of CommonJS builtins expose the
 * same module object as namespace imports, matching lowering's provenance. */
function isBuiltinNamespaceImport(
  program: ts.Program,
  ident: ts.Identifier,
  moduleName: string,
): boolean {
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(ident);
  const decl = symbol ? checker.declarationsOf(symbol)[0] : undefined;
  let importDecl: ts.ImportDeclaration | undefined;
  if (decl !== undefined && ts.isNamespaceImport(decl)) {
    const candidate = decl.parent?.parent;
    if (ts.isImportDeclaration(candidate)) importDecl = candidate;
  } else if (decl !== undefined && ts.isImportClause(decl) && decl.name !== undefined) {
    if (ts.isImportDeclaration(decl.parent)) importDecl = decl.parent;
  }
  return (
    importDecl !== undefined &&
    ts.isStringLiteral(importDecl.moduleSpecifier) &&
    canonicalBuiltinModule(importDecl.moduleSpecifier.text) === moduleName
  );
}

function constInitializer(program: ts.Program, expr: ts.Expression): ts.Expression | null {
  const current = strip(expr);
  if (!ts.isIdentifier(current)) return null;
  const symbol = program.getTypeChecker().getSymbolAtLocation(current);
  const decl = symbol
    ? program
        .getTypeChecker()
        .declarationsOf(symbol)
        .find((candidate): candidate is ts.VariableDeclaration =>
          ts.isVariableDeclaration(candidate),
        )
    : undefined;
  if (
    decl === undefined ||
    decl.initializer === undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  return decl.initializer;
}

function importMetaUrl(expr: ts.Expression): boolean {
  const current = strip(expr);
  return (
    ts.isPropertyAccessExpression(current) &&
    !current.questionDotToken &&
    current.name.text === "url" &&
    ts.isMetaProperty(current.expression) &&
    current.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    current.expression.name.text === "meta"
  );
}

function staticBoolean(
  program: ts.Program,
  expr: ts.Expression,
  seen: Set<ts.Symbol>,
): boolean | null {
  const current = strip(expr);
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
  const init = constInitializer(program, current);
  if (init !== null && ts.isIdentifier(current)) {
    const symbol = program.getTypeChecker().getSymbolAtLocation(current);
    if (symbol === undefined || seen.has(symbol)) return null;
    seen.add(symbol);
    const value = staticBoolean(program, init, seen);
    seen.delete(symbol);
    return value;
  }
  if (
    ts.isCallExpression(current) &&
    !current.questionDotToken &&
    current.arguments.length === 1 &&
    ts.isPropertyAccessExpression(current.expression) &&
    !current.expression.questionDotToken &&
    (current.expression.name.text === "endsWith" || current.expression.name.text === "startsWith")
  ) {
    const receiver = staticString(program, current.expression.expression, seen);
    const needle = staticString(program, current.arguments[0]!, seen);
    if (receiver === null || needle === null) return null;
    return current.expression.name.text === "endsWith"
      ? receiver.endsWith(needle)
      : receiver.startsWith(needle);
  }
  return null;
}

/** A deliberately small compile-time string evaluator for fork target paths.
 * It follows const aliases, import.meta.url, templates, conditionals, the
 * relative URL constructor, and fileURLToPath. No user function executes. */
export function staticForkString(
  program: ts.Program,
  expr: ts.Expression,
  seen: Set<ts.Symbol> = new Set(),
): string | null {
  return staticString(program, expr, seen);
}

function staticString(
  program: ts.Program,
  expr: ts.Expression,
  seen: Set<ts.Symbol>,
): string | null {
  const current = strip(expr);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (importMetaUrl(current)) return pathToFileURL(current.getSourceFile().fileName).href;
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    for (const span of current.templateSpans) {
      const part = staticString(program, span.expression, seen);
      if (part === null) return null;
      value += part + span.literal.text;
    }
    return value;
  }
  if (ts.isConditionalExpression(current)) {
    const condition = staticBoolean(program, current.condition, seen);
    return condition === null
      ? null
      : staticString(program, condition ? current.whenTrue : current.whenFalse, seen);
  }
  const init = constInitializer(program, current);
  if (init !== null && ts.isIdentifier(current)) {
    const symbol = program.getTypeChecker().getSymbolAtLocation(current);
    if (symbol === undefined || seen.has(symbol)) return null;
    seen.add(symbol);
    const value = staticString(program, init, seen);
    seen.delete(symbol);
    return value;
  }
  if (
    ts.isCallExpression(current) &&
    !current.questionDotToken &&
    current.arguments.length === 1 &&
    ts.isIdentifier(current.expression) &&
    isBuiltinMemberImport(program, current.expression, "url", "fileURLToPath")
  ) {
    const href = staticString(program, current.arguments[0]!, seen);
    if (href === null) return null;
    try {
      return fileURLToPath(href);
    } catch {
      return null;
    }
  }
  if (
    ts.isNewExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === "URL"
  ) {
    const args = current.arguments ?? [];
    if (args.length < 1 || args.length > 2) return null;
    const input = staticString(program, args[0]!, seen);
    const base = args[1] === undefined ? null : staticString(program, args[1], seen);
    if (input === null || (args.length === 2 && base === null)) return null;
    try {
      return base === null ? new URL(input).href : new URL(input, base).href;
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolves the supported fork modulePath expression to an absolute source
 * path. Plain runtime strings are intentionally excluded: worker selection
 * is part of the compiled graph, not a runtime filesystem lookup. */
export function staticForkModulePath(program: ts.Program, expr: ts.Expression): string | null {
  const current = strip(expr);
  const init = constInitializer(program, current);
  if (init !== null && ts.isIdentifier(current)) return staticForkModulePath(program, init);
  const supported =
    (ts.isCallExpression(current) &&
      !current.questionDotToken &&
      current.arguments.length === 1 &&
      ts.isIdentifier(current.expression) &&
      isBuiltinMemberImport(program, current.expression, "url", "fileURLToPath")) ||
    (ts.isNewExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "URL");
  if (!supported) return null;
  const value = staticString(program, current, new Set());
  if (value === null) return null;
  try {
    const path = value.startsWith("file:") ? fileURLToPath(value) : value;
    return resolve(path);
  } catch {
    return null;
  }
}

export function forkCallModulePath(program: ts.Program, call: ts.CallExpression): string | null {
  const callee = strip(call.expression);
  const isFork =
    (ts.isIdentifier(callee) && isBuiltinMemberImport(program, callee, "child_process", "fork")) ||
    (ts.isPropertyAccessExpression(callee) &&
      !callee.questionDotToken &&
      callee.name.text === "fork" &&
      ts.isIdentifier(callee.expression) &&
      isBuiltinNamespaceImport(program, callee.expression, "child_process"));
  if (call.questionDotToken || call.arguments[0] === undefined || !isFork) {
    return null;
  }
  return staticForkModulePath(program, call.arguments[0]);
}

/** Source-order static fork targets in the supplied files, deduplicated by
 * resolved path. */
export function forkTargetPaths(program: ts.Program, files: readonly ts.SourceFile[]): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const sourceFile of files) {
    if (sourceFile.isDeclarationFile || sourceFile.fileName.endsWith(".json")) continue;
    for (const node of moduleSourceCandidates(program, sourceFile).calls) {
      const target = forkCallModulePath(program, node);
      if (target !== null && !seen.has(target)) {
        seen.add(target);
        targets.push(target);
      }
    }
  }
  return targets;
}
