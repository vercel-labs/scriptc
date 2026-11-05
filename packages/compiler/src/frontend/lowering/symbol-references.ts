/* The identifiers of a program's implementation files that resolve to a
 * symbol, for analyses that must see every use of one declaration (a
 * function whose every reference binds its receiver, a constructor function
 * only ever called with `new`). The index is built once per lowering, on the
 * first query: identifiers by name, then each name's identifiers by the
 * symbol they resolve to. Identifiers inside type nodes are not uses (a
 * heritage clause's `extends F` is). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

export interface ReferenceIndex {
  names: Map<string, ts.Identifier[]>;
  bySymbol: Map<string, Map<ts.Symbol, ts.Identifier[]>>;
  /** Module specifiers that reach a module's exports as a whole: `import *
   * as`, `export *`, `import()` and `require()`. */
  wholeModuleSpecifiers: ts.Expression[];
  /** Their modules, resolved on the first query. */
  wholeModules: Set<ts.SourceFile> | null;
  /** Export names written as strings (`import { "f" as g }`). */
  stringExportNames: Set<string>;
}

function indexOf(lowerer: Lowerer): ReferenceIndex {
  let index = lowerer.referenceIndex;
  if (index !== null) return index;
  const names = new Map<string, ts.Identifier[]>();
  const wholeModuleSpecifiers: ts.Expression[] = [];
  const stringExportNames = new Set<string>();
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    ts.walkPreorder(sf, (node) => {
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return "skip";
      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        for (const n of [node.propertyName, node.name])
          if (n !== undefined && ts.isStringLiteral(n)) stringExportNames.add(n.text);
      } else if (ts.isImportDeclaration(node)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings))
          wholeModuleSpecifiers.push(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node)) {
        const clause = node.exportClause;
        if (node.moduleSpecifier && (clause === undefined || ts.isNamespaceExport(clause)))
          wholeModuleSpecifiers.push(node.moduleSpecifier);
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const first = node.arguments.nodes[0];
        if (
          first !== undefined &&
          (callee.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(callee) && callee.text === "require"))
        )
          wholeModuleSpecifiers.push(first);
      }
      if (!ts.isIdentifier(node)) return undefined;
      const list = names.get(node.text);
      if (list) list.push(node);
      else names.set(node.text, [node]);
      return undefined;
    });
  }
  index = {
    names,
    bySymbol: new Map(),
    wholeModuleSpecifiers,
    wholeModules: null,
    stringExportNames,
  };
  lowerer.referenceIndex = index;
  return index;
}

/** The identifiers named `text` that resolve to `symbol`, its declarations'
 * names included, in source order. */
export function symbolReferences(
  lowerer: Lowerer,
  symbol: ts.Symbol,
  text: string,
): readonly ts.Identifier[] {
  const index = indexOf(lowerer);
  let bySymbol = index.bySymbol.get(text);
  if (bySymbol === undefined) {
    bySymbol = new Map();
    // A lookup, not a use: resolving outside collection reports a symbol's
    // deferred diagnostics and fences cross-block namespace reads.
    const wasCollecting = lowerer.collecting;
    lowerer.collecting = true;
    try {
      for (const id of index.names.get(text) ?? []) {
        const resolved = lowerer.resolveValueSymbol(id);
        if (!resolved) continue;
        const list = bySymbol.get(resolved);
        if (list) list.push(id);
        else bySymbol.set(resolved, [id]);
      }
    } finally {
      lowerer.collecting = wasCollecting;
    }
    index.bySymbol.set(text, bySymbol);
  }
  return bySymbol.get(symbol) ?? [];
}

/** Whether a reference hands the declaration on under another name (`import
 * { F as G }`, `export { F as G }`, a default import or export), whose uses
 * symbolReferences does not list. */
export function escapesUnderAnotherName(n: ts.Identifier, decl: ts.FunctionDeclaration): boolean {
  if (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Default) return true;
  const parent = n.parent;
  if (!parent) return false;
  if (ts.isImportClause(parent)) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))
    return parent.propertyName !== undefined && parent.propertyName.text !== parent.name.text;
  return false;
}

/** Whether an exported declaration is also reachable with no identifier
 * that names it: the exports of its module, or of a module that
 * re-exports it, taken as a whole (`import * as ns`, `export *`,
 * `import()`, `require()`), or an export name written as a string. */
export function reachableWithoutItsName(
  lowerer: Lowerer,
  decl: ts.FunctionDeclaration,
  references: readonly ts.Identifier[],
): boolean {
  const exported =
    (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) !== 0 ||
    references.some((n) => n.parent !== undefined && ts.isExportSpecifier(n.parent));
  if (!exported) return false;
  const index = indexOf(lowerer);
  if (decl.name && index.stringExportNames.has(decl.name.text)) return true;
  if (index.wholeModules === null) {
    index.wholeModules = new Set();
    for (const specifier of index.wholeModuleSpecifiers) {
      const target = lowerer.checker.getSymbolAtLocation(specifier)?.declarations?.[0];
      if (target !== undefined && ts.isSourceFile(target)) index.wholeModules.add(target);
    }
  }
  // Its own module, and every module that re-exports it by name.
  if (index.wholeModules.has(ts.getSourceFileOfNode(decl))) return true;
  return references.some(
    (n) =>
      n.parent !== undefined &&
      ts.isExportSpecifier(n.parent) &&
      index.wholeModules!.has(ts.getSourceFileOfNode(n)),
  );
}

/** The declaration of a function symbol that has a body: the implementation
 * of an overloaded function, not one of its signatures. */
export function functionImplementation(symbol: ts.Symbol): ts.FunctionDeclaration | null {
  for (const decl of symbol.declarations)
    if (ts.isFunctionDeclaration(decl) && decl.body) return decl;
  return null;
}
