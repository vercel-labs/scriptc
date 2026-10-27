import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "./ts7/adapter.js";
import {
  ambientDtsPath,
  isFallbackDtsPath,
  isNodeTypesPath,
  overridesDtsPath,
  tsgoPath,
} from "./dts-paths.js";
import { nearestPackageImports } from "./resolve.js";
import { canonicalBuiltinModule } from "./builtin-modules.js";
import { moduleSourceCandidates } from "./module-source-candidates.js";

export function isNodeGlobal(program: ts.Program, expression: ts.Identifier): boolean {
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(expression);
  const declarations = symbol ? symbol.declarations : [];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      const source = ts.getSourceFileOfNode(declaration);
      return (
        source.isDeclarationFile &&
        (isFallbackDtsPath(source.fileName) || isNodeTypesPath(source.fileName))
      );
    })
  );
}

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
  const decl = symbol ? symbol.declarations[0] : undefined;
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
    const targetDecl = target.declarations[0];
    if (targetDecl !== undefined && ts.getSourceFileOfNode(targetDecl).isDeclarationFile) {
      for (
        let parent: ts.Node | undefined = targetDecl.parent;
        parent !== undefined && !ts.isSourceFile(parent);
        parent = parent.parent
      ) {
        if (ts.isModuleDeclaration(parent) && ts.isStringLiteral(parent.name)) {
          return (
            canonicalBuiltinModule(parent.name.text) === moduleName &&
            ts.symbolName(target) === memberName
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
export function isBuiltinNamespaceImport(
  program: ts.Program,
  ident: ts.Identifier,
  moduleName: string,
): boolean {
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(ident);
  const decl = symbol ? symbol.declarations[0] : undefined;
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
    ? symbol.declarations.find((candidate): candidate is ts.VariableDeclaration =>
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
    current.arguments.nodes.length === 1 &&
    ts.isPropertyAccessExpression(current.expression) &&
    !current.expression.questionDotToken &&
    (current.expression.name.text === "endsWith" || current.expression.name.text === "startsWith")
  ) {
    const receiver = staticString(program, current.expression.expression, seen);
    const needle = staticString(program, current.arguments.nodes[0]!, seen);
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
  if (importMetaUrl(current)) return pathToFileURL(ts.getSourceFileOfNode(current).fileName).href;
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    for (const span of current.templateSpans.nodes) {
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
    current.arguments.nodes.length === 1 &&
    ts.isIdentifier(current.expression) &&
    isBuiltinMemberImport(program, current.expression, "url", "fileURLToPath")
  ) {
    const href = staticString(program, current.arguments.nodes[0]!, seen);
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
    (isBuiltinMemberImport(program, current.expression, "url", "URL") ||
      (current.expression.text === "URL" && isNodeGlobal(program, current.expression)))
  ) {
    const args = current.arguments?.nodes ?? [];
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
      current.arguments.nodes.length === 1 &&
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
  if (call.questionDotToken || call.arguments.nodes[0] === undefined) return null;
  const callee = strip(call.expression);
  const isFork =
    (ts.isIdentifier(callee) && isBuiltinMemberImport(program, callee, "child_process", "fork")) ||
    (ts.isPropertyAccessExpression(callee) &&
      !callee.questionDotToken &&
      callee.name.text === "fork" &&
      ts.isIdentifier(callee.expression) &&
      isBuiltinNamespaceImport(program, callee.expression, "child_process"));
  if (!isFork) {
    return null;
  }
  return staticForkModulePath(program, call.arguments.nodes[0]);
}

/** The ways a string or template literal can spell one character of a
 * module name: the character, \xHH, \uHHHH, \u{H…}, a legacy octal escape,
 * or the character after a backslash where that is not another escape. */
function spelledCharacter(ch: string): string {
  const code = ch.charCodeAt(0);
  const hex = code.toString(16);
  const forms = [
    ch,
    "\\\\x" + hex.padStart(2, "0"),
    "\\\\u" + hex.padStart(4, "0"),
    "\\\\u\\{0*" + hex + "\\}",
    "\\\\" + code.toString(8),
  ];
  if (!"bfnrtvux0123456789".includes(ch)) forms.push("\\\\" + ch);
  return "(?:" + forms.join("|") + ")";
}

/** "child_process" with escapes and line continuations in any of its
 * characters (case-insensitive, a superset). */
const SPELLED_CHILD_PROCESS = new RegExp(
  [..."child_process"].map(spelledCharacter).join("(?:\\\\(?:\\r\\n|[\\n\\r\\u2028\\u2029]))*"),
  "i",
);

/** Whether a call in the program can reach node:child_process's fork. A
 * fork binding is an import or alias whose chain names the module in a
 * module specifier (a string), or a '#' specifier the nearest package.json
 * "imports" field maps. Node's type declarations and scriptc's own declare
 * the module, and alias it only as node:child_process, so they are not
 * read; any other file that names the module in a string holds
 * "child_process" in its text, or an escape that spells it. */
function namesChildProcess(program: ts.Program): boolean {
  const known = program.analysis.namesChildProcess;
  if (known !== null) return known;
  const own = new Set([ambientDtsPath(), overridesDtsPath()]);
  // Implementation files are already fetched; any other file is read as
  // the host serves it, without fetching its syntax tree.
  const texts = new Map<string, string>();
  for (const sourceFile of program.getImplementationSourceFiles())
    texts.set(tsgoPath(sourceFile.fileName), sourceFile.text);
  const scopes = new Set<unknown>();
  let names = false;
  for (const fileName of program.getSourceFileNames()) {
    const path = tsgoPath(fileName);
    if (isNodeTypesPath(fileName) || isFallbackDtsPath(fileName) || own.has(path)) continue;
    const text = texts.get(path) ?? program.getSourceText(fileName) ?? "";
    if (
      text.includes("child_process") ||
      (text.includes("\\") && SPELLED_CHILD_PROCESS.test(text))
    ) {
      names = true;
      break;
    }
    const imports = nearestPackageImports(fileName);
    if (imports === undefined || scopes.has(imports)) continue;
    scopes.add(imports);
    if (JSON.stringify(imports).includes("child_process")) {
      names = true;
      break;
    }
  }
  program.analysis.namesChildProcess = names;
  return names;
}

/** Source-order static fork targets in the supplied files, deduplicated by
 * resolved path. */
export function forkTargetPaths(program: ts.Program, files: readonly ts.SourceFile[]): string[] {
  // Without a binding of node:child_process no call is a fork, and the
  // checker queries below are skipped.
  if (!namesChildProcess(program)) return [];
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const sourceFile of files) {
    if (sourceFile.isDeclarationFile || sourceFile.fileName.endsWith(".json")) continue;
    const calls = moduleSourceCandidates(program, sourceFile).calls;
    const bindings: ts.Node[] = [];
    for (const call of calls) {
      if (call.questionDotToken || call.arguments.nodes[0] === undefined) continue;
      const callee = strip(call.expression);
      if (ts.isIdentifier(callee)) bindings.push(callee);
      else if (
        ts.isPropertyAccessExpression(callee) &&
        !callee.questionDotToken &&
        callee.name.text === "fork" &&
        ts.isIdentifier(callee.expression)
      ) {
        bindings.push(callee.expression);
      }
    }
    // Discovery needs binding provenance, not every symbol and type in an
    // otherwise unreachable body. Keep aliases and ambient bindings under
    // the checker's authority while avoiding its whole-file miss fallback.
    program.getTypeChecker().prefetchSymbolNodesExact(bindings);
    for (const node of calls) {
      const target = forkCallModulePath(program, node);
      if (target !== null && !seen.has(target)) {
        seen.add(target);
        targets.push(target);
      }
    }
  }
  return targets;
}
