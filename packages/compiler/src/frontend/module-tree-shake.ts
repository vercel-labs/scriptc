/* Module-level tree shaking for installed packages.
 *
 * Node evaluates every module its import graph reaches, so the compiled graph
 * normally keeps every package module a barrel re-exports, including modules
 * the program never reads a binding from. Those modules still have to
 * compile, and a module the program never uses can carry a construct the
 * native build has no lowering for and refuse the whole package for it.
 *
 * This pass answers the narrower question a build needs: which package
 * modules can be left out of the COMPILED order without changing what the
 * program observes. A module is left out when it is not live (no live module
 * reads one of its exports) and its top level is side-effect free, so not
 * evaluating it is indistinguishable from evaluating it, a side-effect import
 * of it included.
 *
 * Liveness is deliberately conservative. It understands named imports and
 * named re-exports through a barrel; a namespace or default import, an
 * `export *`, or a `require()` marks the target live with every name, so a
 * module this pass does not understand is never dropped. A module only a
 * dynamic `import()` reaches is not in the order this pass sees; lowering
 * adds such modules after it, so they are never candidates. The pass only
 * ever removes modules from the order; it adds none and never changes an
 * order it keeps. */

import * as ts from "./ts7/adapter.js";
import type { CycleEdge } from "./program.js";

/** The modules of `order` that the program cannot observe. */
export function droppedPackageModules(
  entry: ts.SourceFile,
  order: readonly ts.SourceFile[],
  edges: ReadonlyMap<ts.SourceFile, readonly CycleEdge[]>,
): Set<ts.SourceFile> {
  const infos = new Map<ts.SourceFile, ModuleInfo>();
  for (const sf of order) infos.set(sf, moduleInfo(sf, edges.get(sf) ?? []));
  const live = new Set<ts.SourceFile>();
  const used = new Map<ts.SourceFile, Set<string> | "all">();
  const queue: ts.SourceFile[] = [];

  const markAll = (sf: ts.SourceFile): void => {
    if (used.get(sf) === "all") return;
    used.set(sf, "all");
    if (!live.has(sf)) {
      live.add(sf);
      queue.push(sf);
    }
  };
  const markNames = (sf: ts.SourceFile, names: readonly string[]): void => {
    const current = used.get(sf);
    if (current === "all") return;
    const set = current ?? new Set<string>();
    let grew = false;
    for (const name of names) {
      if (!set.has(name)) {
        set.add(name);
        grew = true;
      }
    }
    if (current === undefined) used.set(sf, set);
    if (grew || !live.has(sf)) {
      if (!live.has(sf)) {
        live.add(sf);
        queue.push(sf);
      }
    }
  };

  // Program code (everything outside an installed package) and the entry are
  // roots: every binding they import is read by code this pass does not
  // analyze deeper.
  for (const sf of order) {
    const info = infos.get(sf);
    if (info === undefined || info.package === null || sf === entry) {
      live.add(sf);
      queue.push(sf);
      markImports(info, markAll, markNames);
    }
  }

  // A live module evaluates everything it statically imports, even a module
  // whose exports it never reads. An impure target must therefore be kept,
  // and its own imports with it. Iterate until no target is newly kept; a
  // module imported only by dropped modules is never reached here, so an
  // impure module the program cannot reach is dropped with its importer.
  for (;;) {
    while (queue.length > 0) {
      const sf = queue.shift()!;
      const info = infos.get(sf);
      if (info === undefined) continue;
      const names = used.get(sf) ?? "all";
      if (names !== "all") {
        // Follow every used name to where the module gets it. A barrel's code
        // does nothing else; a module with code of its own may also read any of
        // its imports, which the markImports below keeps.
        for (const name of names) {
          const source = info.exports.get(name);
          if (source === undefined || source.kind === "local") {
            markImports(info, markAll, markNames);
            break;
          }
          markNames(source.target, [source.name]);
        }
      }
      if (names === "all" || !info.barrel) markImports(info, markAll, markNames);
    }

    let grew = false;
    for (const sf of live) {
      const info = infos.get(sf);
      if (info === undefined) continue;
      for (const target of info.targets) {
        if (live.has(target) || used.get(target) === "all") continue;
        const targetInfo = infos.get(target);
        if (targetInfo === undefined || targetInfo.pureTopLevel) continue;
        markAll(target);
        grew = true;
      }
    }
    if (!grew) break;
  }

  const dropped = new Set<ts.SourceFile>();
  for (const sf of order) {
    const info = infos.get(sf);
    if (info === undefined || info.package === null) continue;
    if (live.has(sf)) continue;
    if (!info.pureTopLevel) continue;
    dropped.add(sf);
  }
  // SCRIPTC_TREESHAKE_TRACE=1 prints every package module's verdict and why,
  // in order, the way SCRIPTC_INITIALIZERS_TRACE prints initializer verdicts.
  if (process.env["SCRIPTC_TREESHAKE_TRACE"] === "1") {
    for (const sf of order) {
      const info = infos.get(sf);
      if (info === undefined || info.package === null) continue;
      const state = dropped.has(sf) ? "drop" : "keep";
      const why = live.has(sf) ? "live" : info.pureTopLevel ? "unused" : "impure";
      process.stderr.write(`[tree-shake] ${state} ${why} ${sf.fileName}\n`);
    }
  }
  return dropped;
}

interface ExportSource {
  kind: "local" | "any";
  target: ts.SourceFile;
  name: string;
}

interface ModuleInfo {
  /** The installed package directory this file belongs to, or null for
   * program code. */
  package: string | null;
  /** The module only re-exports other modules' bindings (no code of its
   * own), so liveness may follow a single exported name. */
  barrel: boolean;
  /** Every exported name, and where it comes from. */
  exports: Map<string, ExportSource | { kind: "local" }>;
  /** Named imports, by target module, with the imported name. */
  named: { target: ts.SourceFile; name: string }[];
  /** Imports that read anything the target exports (namespace, default,
   * side-effect, `export *`). */
  all: ts.SourceFile[];
  /** Every statically imported or re-exported module: evaluated whenever
   * this module is. */
  targets: ts.SourceFile[];
  /** The top level has no statement that could be observed. */
  pureTopLevel: boolean;
}

function markImports(
  info: ModuleInfo | undefined,
  markAll: (sf: ts.SourceFile) => void,
  markNames: (sf: ts.SourceFile, names: readonly string[]) => void,
): void {
  if (info === undefined) return;
  for (const target of info.all) markAll(target);
  for (const { target, name } of info.named) markNames(target, [name]);
}

function packageDirOf(file: string): string | null {
  const normalized = file.split("\\").join("/");
  const at = normalized.lastIndexOf("/node_modules/");
  if (at < 0) return null;
  const rest = normalized.slice(at + "/node_modules/".length);
  const parts = rest.split("/");
  const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : (parts[0] ?? "");
  if (name === "") return null;
  return `${normalized.slice(0, at)}/node_modules/${name}`;
}

/** The module's import and export shape. */
function moduleInfo(sf: ts.SourceFile, edges: readonly CycleEdge[]): ModuleInfo {
  const byStmt = new Map<ts.Node, ts.SourceFile>();
  for (const edge of edges) if (edge.stmt !== undefined) byStmt.set(edge.stmt, edge.dep);
  const info: ModuleInfo = {
    package: packageDirOf(sf.fileName),
    barrel: true,
    exports: new Map(),
    named: [],
    all: [],
    targets: [],
    pureTopLevel: true,
  };
  // Local name of every imported binding, so a later `export { name }` (the
  // barrel spelling) follows the binding back to its module.
  const imported = new Map<string, { target: ts.SourceFile; name: string }>();
  // A require() edge names no binding: a live module's call loads the whole
  // target.
  for (const edge of edges) if (edge.stmt === undefined) info.all.push(edge.dep);
  let sawExport = false;
  // Names the module declares itself, for purity of self-mutations
  // (`bind.placeholder = …`) and for telling a builtin call from a shadowed
  // one.
  const localNames = new Set<string>();
  for (const stmt of sf.statements.nodes) {
    if (ts.isImportDeclaration(stmt)) {
      const dep = byStmt.get(stmt);
      if (dep === undefined) {
        info.pureTopLevel = false;
        continue;
      }
      info.targets.push(dep);
      const clause = stmt.importClause;
      if (clause === undefined) {
        // A side-effect import provides no name; the target is evaluated
        // unless it is pure and nothing else reads it.
        continue;
      }
      if (clause.name !== undefined) {
        info.all.push(dep);
        info.barrel = false;
      }
      const bindings = clause.namedBindings;
      if (bindings === undefined) {
        // `import {} from` binds nothing.
      } else if (ts.isNamespaceImport(bindings)) {
        info.all.push(dep);
        info.barrel = false;
      } else {
        for (const element of bindings.elements.nodes) {
          const name = (element.propertyName ?? element.name).text;
          info.named.push({ target: dep, name });
          imported.set(element.name.text, { target: dep, name });
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt)) continue;
    if (ts.isVariableStatement(stmt)) {
      info.barrel = false;
      const exported = hasExport(stmt);
      for (const decl of stmt.declarationList.declarations.nodes) {
        if (decl.name !== undefined)
          for (const name of bindingNames(decl.name)) localNames.add(name);
        if (exported && ts.isIdentifier(decl.name)) {
          info.exports.set(decl.name.text, { kind: "local" });
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      info.barrel = false;
      const name = stmt.name?.text;
      if (name !== undefined) localNames.add(name);
      markDeclarationExports(stmt, info);
      continue;
    }
    info.barrel = false;
  }
  // Purity: the statements whose evaluation a live module could observe.
  for (const stmt of sf.statements.nodes) {
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt)) continue;
    if (ts.isClassDeclaration(stmt)) {
      if (!pureClass(stmt, localNames)) info.pureTopLevel = false;
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations.nodes) {
        if (decl.initializer !== undefined && !isPureExpression(decl.initializer, localNames)) {
          info.pureTopLevel = false;
        }
      }
      continue;
    }
    if (ts.isExpressionStatement(stmt)) {
      if (ts.isStringLiteral(stmt.expression)) continue;
      if (isLocalMutation(stmt.expression, localNames)) continue;
      info.pureTopLevel = false;
      continue;
    }
    info.pureTopLevel = false;
  }
  for (const stmt of sf.statements.nodes) {
    if (!ts.isExportDeclaration(stmt)) continue;
    sawExport = true;
    const dep = stmt.moduleSpecifier === undefined ? undefined : byStmt.get(stmt);
    if (dep !== undefined) info.targets.push(dep);
    if (stmt.exportClause === undefined) {
      // `export * from "./m"`: any name may come from there.
      if (dep !== undefined) info.all.push(dep);
      else info.barrel = false;
      continue;
    }
    if (ts.isNamespaceExport(stmt.exportClause)) {
      if (dep !== undefined) info.all.push(dep);
      else info.barrel = false;
      continue;
    }
    for (const element of stmt.exportClause.elements.nodes) {
      const exportedName = element.name.text;
      if (dep !== undefined) {
        const importedName = element.propertyName?.text ?? exportedName;
        info.exports.set(exportedName, { kind: "any", target: dep, name: importedName });
        continue;
      }
      const localName = (element.propertyName ?? element.name).text;
      const source = imported.get(localName);
      if (source === undefined) info.exports.set(exportedName, { kind: "local" });
      else
        info.exports.set(exportedName, { kind: "any", target: source.target, name: source.name });
    }
  }
  void sawExport;
  return info;
}

function markDeclarationExports(node: ts.Node, info: ModuleInfo): void {
  if (!hasExport(node)) return;
  const name = (node as ts.Node & { name?: ts.Identifier }).name;
  if (name === undefined) return;
  info.exports.set(name.text, { kind: "local" });
}

function hasExport(node: ts.Node): boolean {
  return ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

const EMPTY_LOCALS: ReadonlySet<string> = new Set();
const PURE_CALLEES: ReadonlySet<string> = new Set([
  "RegExp",
  "Symbol",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "BigInt",
]);

function bindingNames(name: ts.Node): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name)) {
    for (const element of name.elements.nodes) {
      if (ts.isOmittedExpression(element)) continue;
      if (element.name !== undefined) out.push(...bindingNames(element.name));
    }
  }
  return out;
}

/** A class statement is pure when its members do no work at definition:
 * only static initializers are evaluated then, so they must be pure, and a
 * static block is never pure. */
function pureClass(decl: ts.ClassDeclaration, locals: ReadonlySet<string>): boolean {
  for (const member of decl.members.nodes) {
    if (member.kind === ts.SyntaxKind.ClassStaticBlockDeclaration) return false;
    const isStatic =
      ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true;
    if (!isStatic) continue;
    if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
      if (!isPureExpression(member.initializer, locals)) return false;
    }
  }
  return true;
}

/** A property path rooted at a binding the module declares itself
 * (`toolkit.partial.placeholder`): writing through it changes only that
 * value. */
function isPathOnLocal(expr: ts.Expression, locals: ReadonlySet<string>): boolean {
  let node = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) {
      node = node.expression;
      continue;
    }
    if (ts.isElementAccessExpression(node)) {
      node = node.expression;
      continue;
    }
    break;
  }
  return ts.isIdentifier(node) && locals.has(node.text);
}

/** `bind.placeholder = …`, `memoize.Cache = Map`: a write to a property of a
 * binding the module declares itself cannot be observed by a module that
 * never reads this one. */
function isLocalMutation(expr: ts.Expression, locals: ReadonlySet<string>): boolean {
  // `Object.assign(local, ...)`: the target is a value only this module
  // holds, so the copy cannot be observed by a module that never reads it.
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Object" &&
    expr.expression.name.text === "assign" &&
    !locals.has("Object")
  ) {
    const args = expr.arguments.nodes;
    const target = args[0];
    if (target === undefined || !ts.isIdentifier(target) || !locals.has(target.text)) return false;
    return args.slice(1).every((argument) => isPureExpression(argument, locals));
  }
  if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
    return false;
  return isPathOnLocal(expr.left, locals) && isPureExpression(expr.right, locals);
}

/** A top-level initializer whose evaluation the program cannot observe when
 * nothing reads the binding: literals and constructors of literals. A call or
 * an assignment may do anything and keeps the module. */
/** The bundler PURE annotation in a call's leading trivia. */
function hasPureAnnotation(node: ts.Node): boolean {
  const sf = ts.getSourceFileOfNode(node);
  const trivia = sf.text.slice(node.pos, ts.tokenStartOfNode(node));
  return trivia.includes("@__PURE__") || trivia.includes("#__PURE__");
}

function isPureExpression(
  node: ts.Expression,
  locals: ReadonlySet<string> = EMPTY_LOCALS,
): boolean {
  if (ts.isCallExpression(node)) {
    const annotated = hasPureAnnotation(node);
    const builtin =
      ts.isIdentifier(node.expression) &&
      PURE_CALLEES.has(node.expression.text) &&
      !locals.has(node.expression.text);
    return (
      (annotated || builtin) &&
      isPureExpression(node.expression, locals) &&
      node.arguments.nodes.every(
        (argument) => !ts.isSpreadElement(argument) && isPureExpression(argument, locals),
      )
    );
  }
  switch (node.kind) {
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.ThisKeyword:
    case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.TypeOfExpression:
    case ts.SyntaxKind.VoidExpression:
    case ts.SyntaxKind.AsExpression:
    case ts.SyntaxKind.SatisfiesExpression:
    case ts.SyntaxKind.NonNullExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ClassExpression:
      return true;
    case ts.SyntaxKind.PropertyAccessExpression: {
      const access = node as ts.PropertyAccessExpression;
      return isPureExpression(access.expression, locals);
    }
    case ts.SyntaxKind.ElementAccessExpression: {
      const access = node as ts.ElementAccessExpression;
      return (
        isPureExpression(access.expression, locals) &&
        isPureExpression(access.argumentExpression, locals)
      );
    }
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const unary = node as ts.PrefixUnaryExpression;
      return isPureExpression(unary.operand, locals);
    }
    case ts.SyntaxKind.PostfixUnaryExpression:
      return false;
    case ts.SyntaxKind.BinaryExpression: {
      const binary = node as ts.BinaryExpression;
      return (
        isPureOperator(binary.operatorToken.kind) &&
        isPureExpression(binary.left, locals) &&
        isPureExpression(binary.right, locals)
      );
    }
    case ts.SyntaxKind.ConditionalExpression: {
      const cond = node as ts.ConditionalExpression;
      return (
        isPureExpression(cond.condition, locals) &&
        isPureExpression(cond.whenTrue, locals) &&
        isPureExpression(cond.whenFalse, locals)
      );
    }
    case ts.SyntaxKind.TemplateExpression: {
      const template = node as ts.TemplateExpression;
      return template.templateSpans.nodes.every((span) => isPureExpression(span.expression));
    }
    case ts.SyntaxKind.ArrayLiteralExpression:
      return (node as ts.ArrayLiteralExpression).elements.nodes.every(
        (element) => !ts.isSpreadElement(element) && isPureExpression(element, locals),
      );
    case ts.SyntaxKind.ObjectLiteralExpression:
      return (node as ts.ObjectLiteralExpression).properties.nodes.every((member) =>
        isPureObjectMember(member, locals),
      );
    case ts.SyntaxKind.NewExpression: {
      const created = node as ts.NewExpression;
      return (
        isPureExpression(created.expression, locals) &&
        (created.arguments?.nodes.every((argument) => isPureExpression(argument, locals)) ?? true)
      );
    }
    default:
      return false;
  }
}

function isPureObjectMember(
  member: ts.ObjectLiteralElementLike,
  locals: ReadonlySet<string>,
): boolean {
  if (ts.isSpreadAssignment(member)) return isPureExpression(member.expression, locals);
  if (ts.isPropertyAssignment(member)) {
    return isPureExpression(member.initializer, locals);
  }
  if (ts.isShorthandPropertyAssignment(member)) return true;
  if (
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  )
    return true;
  return false;
}

function isPureOperator(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.CommaToken:
    case ts.SyntaxKind.EqualsToken:
    case ts.SyntaxKind.PlusEqualsToken:
    case ts.SyntaxKind.MinusEqualsToken:
    case ts.SyntaxKind.AsteriskEqualsToken:
    case ts.SyntaxKind.SlashEqualsToken:
    case ts.SyntaxKind.PercentEqualsToken:
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.BarBarEqualsToken:
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
      return false;
    default:
      return true;
  }
}
