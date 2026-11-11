/* TypeScript's import elision, as a source rewrite before lowering.
 *
 * Node runs TypeScript by erasing types in place: `import { A } from "./m"`
 * stays an import of `A` whatever `A` is (type-only-imports.ts). tsc, for a
 * project that does not set `verbatimModuleSyntax`, instead drops every import
 * binding the file never uses as a value, drops the whole declaration when no
 * binding is left, and drops export specifiers that name no value. A module
 * imported only for its types is then never loaded.
 *
 * A file written for that dialect is rewritten here into the dialect the rest
 * of the frontend already implements: each binding tsc would drop is blanked
 * where it stands, and the same binding is declared again, type-only, after
 * the last line of the file (`import type …`, `export type …`). Module order,
 * cycle detection, the link check, island selection and the lowering then
 * see one rule.
 *
 * The rewrite keeps every offset of the file as written: blanking replaces
 * characters with spaces (line breaks stay) and the added declarations follow
 * the original text. A diagnostic's position in the rewritten file is its
 * position in the file on disk.
 *
 * What is dropped is decided from the syntax tree and the checker alone,
 * never from the file's text: the spans to blank are spans between tokens,
 * and the added declarations are spelled from the names and module
 * specifiers of the tree. The text is made by sourceTextRewritten, which
 * reports the rewrite itself (SourceTextRewrite), so the frontend cache
 * knows the form the file is compiled in, makes it again for an edited
 * version, and still answers an edit of comments or whitespace. A file that
 * loses nothing has no read of its text here.
 *
 * The rules are tsc's own (checker.ts: markAliasReferenced,
 * markPropertyAliasReferenced, isValueAliasDeclaration; transformers/ts.ts:
 * visitImportDeclaration, visitExportDeclaration):
 *
 *   - an import binding is kept when an identifier in an expression position
 *     resolves to it and what it names has a value meaning; a use in a type,
 *     a `typeof` type query, an `implements` clause, an interface or an
 *     ambient declaration does not count;
 *   - `export { x }` and `export default x` keep `x` when it names a value;
 *   - a const enum is inlined, so its uses keep nothing, unless
 *     `isolatedModules` is set (or `preserveConstEnums`, for an export). The
 *     use itself stays in the source, so such a binding cannot be spelled
 *     type-only: it is kept, and a declaration that tsc drops for this
 *     reason alone is reported (`inlinedOnly`) so the build can say that it
 *     loads a module tsc's output does not;
 *   - for the same reason an export of a const enum stays a value export
 *     (`inlinedExports`): tsc's output has no value for the name, but a file
 *     that imports the export and uses the name as a value keeps that use,
 *     so spelling the export `export type` would leave the use without a
 *     value;
 *   - a name that does not resolve counts as a value;
 *   - `export { T } from "./m"` loses the specifiers that name no value, and
 *     the declaration with its last specifier; `export * from` always stays;
 *   - JavaScript files are never elided. */

import * as ts from "./ts7/adapter.js";

/** The project settings that change what tsc elides. */
export interface ImportElisionOptions {
  /** `isolatedModules`: a const enum is not inlined across files, so a use
   * of one keeps its import. */
  isolatedModules: boolean;
  /** `preserveConstEnums` (implied by `isolatedModules`): an exported const
   * enum stays a value. */
  preserveConstEnums: boolean;
  /** `importsNotUsedAsValues` "preserve" or "error" (removed in TypeScript
   * 5.5): a declaration that loses every binding stays as a side-effect
   * import. */
  preserveImportEdges: boolean;
  /** `preserveValueImports` (removed in TypeScript 5.5): a binding that names
   * a value stays whether or not the file uses it. */
  preserveValueImports: boolean;
}

export interface ImportElision {
  /** The rewritten text, or null when nothing is dropped. */
  text: string | null;
  /** Import and export declarations dropped as a whole. */
  declarations: number;
  /** Bindings dropped from declarations that stay. */
  bindings: number;
  /** Local names of bindings kept only for uses tsc does not count: a const
   * enum member it inlines, an import alias used only in types. */
  inlined: string[];
  /** Exported names tsc's output has no value for and this dialect keeps as a
   * value export: a const enum, or a namespace of const enums. */
  inlinedExports: string[];
  /** Import declarations kept although tsc drops them: every use of their
   * bindings is one tsc does not count, and the use needs the binding as a
   * value here. Spans in the file as written. */
  inlinedOnly: { start: number; end: number; specifier: string }[];
}

type AliasNode =
  | ts.ImportClause
  | ts.NamespaceImport
  | ts.ImportSpecifier
  | ts.ImportEqualsDeclaration;

interface Alias {
  node: AliasNode;
  name: ts.Identifier;
  symbol: ts.Symbol | undefined;
  referenced: boolean;
  /** A use that needs the binding as a value here and that tsc does not
   * count: a const enum member it inlines, or an import alias of the
   * binding that the file uses only in types. */
  inlined: boolean;
}

/** A use of a candidate name that may keep its import. */
interface Use {
  id: ts.Identifier;
  kind: "plain" | "property" | "shorthand" | "exported";
}

const ALL_MEANINGS =
  ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias;

function hasDeclareModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) === true;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

/** The `extends` operand of a class: the one heritage position that is
 * evaluated. */
function isClassExtendsOperand(node: ts.Node): boolean {
  if (node.kind !== ts.SyntaxKind.ExpressionWithTypeArguments) return false;
  const heritage = node.parent;
  return (
    heritage !== undefined &&
    ts.isHeritageClause(heritage) &&
    heritage.token === ts.SyntaxKind.ExtendsKeyword &&
    (ts.isClassDeclaration(heritage.parent) || ts.isClassExpression(heritage.parent))
  );
}

/** Whether `id` reads a binding where it stands, and how. Null for a name
 * that declares something or spells a property. */
function useKindOf(id: ts.Identifier): Use["kind"] | null {
  const parent = id.parent;
  if (parent === undefined) return null;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === id ? "property" : null;
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name === id ? "shorthand" : "plain";
  if (ts.isQualifiedName(parent)) return null;
  if (ts.isExportAssignment(parent)) return parent.expression === id ? "exported" : null;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return null;
  if (ts.isLabeledStatement(parent) && parent.label === id) return null;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === id)
    return null;
  if (ts.isJsxAttribute(parent) && parent.name === id) return null;
  if (ts.isMetaProperty(parent)) return null;
  if ((parent as ts.Node & { name?: ts.Node }).name === id) return null;
  return "plain";
}

const IDENTIFIERS: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.Identifier]);

/** Whether the expression `id` belongs to is evaluated. Nothing inside a
 * type, an interface, a type alias or an ambient declaration is, with tsc's
 * one exception: the expression of a computed member name counts as a use
 * wherever the member is declared. Imports and export lists are read
 * separately. */
function emitsWhereItStands(id: ts.Identifier): boolean {
  let computedName = false;
  for (let p: ts.Node | undefined = id.parent; p !== undefined; p = p.parent) {
    switch (p.kind) {
      case ts.SyntaxKind.SourceFile:
        return true;
      case ts.SyntaxKind.ImportDeclaration:
      case ts.SyntaxKind.ImportEqualsDeclaration:
      case ts.SyntaxKind.ExportDeclaration:
        return false;
      case ts.SyntaxKind.ComputedPropertyName:
        computedName = true;
        continue;
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.TypeAliasDeclaration:
        if (!computedName) return false;
        continue;
      default:
        if (ts.isTypeNode(p)) {
          if (!computedName && !isClassExtendsOperand(p)) return false;
          continue;
        }
        if (hasDeclareModifier(p)) return false;
    }
  }
  return true;
}

/** `export = a.b.c` and `export default a.b`: the access chain a property use
 * heads is itself an export. */
function headsExportedExpression(id: ts.Identifier): boolean {
  let node: ts.Node = id;
  while (
    node.parent !== undefined &&
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node
  )
    node = node.parent;
  return (
    node.parent !== undefined &&
    ts.isExportAssignment(node.parent) &&
    node.parent.expression === node
  );
}

/** tsc's module instance state, for the one question asked of it: does a
 * namespace hold nothing but const enums (2), nothing at run time (0), or
 * something else (1)? */
function namespaceInstanceState(decl: ts.ModuleDeclaration): 0 | 1 | 2 {
  const body = decl.body;
  if (body === undefined) return 1;
  if (ts.isModuleDeclaration(body)) return namespaceInstanceState(body);
  if (!ts.isModuleBlock(body)) return 1;
  let state: 0 | 1 | 2 = 0;
  for (const stmt of body.statements.nodes) {
    let own: 0 | 1 | 2;
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) own = 0;
    else if (ts.isEnumDeclaration(stmt))
      own =
        ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ConstKeyword) === true ? 2 : 1;
    else if (ts.isModuleDeclaration(stmt)) own = namespaceInstanceState(stmt);
    else if (ts.isImportEqualsDeclaration(stmt) && !hasExportModifier(stmt)) own = 0;
    else own = 1;
    if (own === 1) return 1;
    if (own === 2) state = 2;
  }
  return state;
}

/** A name of an import or export specifier as source: an identifier, or
 * the string literal of an arbitrary module export name. */
function nameSource(name: ts.Node): string {
  const text = (name as ts.Identifier).text;
  return ts.isStringLiteral(name) ? JSON.stringify(text) : text;
}

/** A module specifier as source, or null when it is not a string literal
 * (a file that does not parse). */
function specifierSource(specifier: ts.Node): string | null {
  return ts.isStringLiteral(specifier) ? JSON.stringify(specifier.text) : null;
}

/** What tsc may drop from one file, and what the decision reads, from the
 * file's syntax alone. */
interface Candidates {
  /** Every import binding that exists at run time. */
  aliases: Alias[];
  byName: Map<string, Alias[]>;
  imports: ts.ImportDeclaration[];
  exportLists: ts.ExportDeclaration[];
  defaultExports: ts.ExportAssignment[];
  /** The uses of a candidate's name that may keep its import. */
  uses: Use[];
  /** The names that occur anywhere beyond the aliases' own declarations. */
  mentioned: Set<string>;
  /** The nodes the decision asks the checker for the symbol at before it
   * starts: the candidates' names, the first use of each, and the module
   * specifiers and re-exported names behind which it looks for a type-only
   * declaration. One request answers them for a file, or for a whole
   * program (elideProgramImports). */
  questions: ts.Node[];
}

/** The candidates of `sf`, or null when it has no import, export list or
 * `export default name` to decide. */
function candidatesOf(sf: ts.SourceFile): Candidates | null {
  // ---- the candidates: every import binding that exists at run time ----
  const aliases: Alias[] = [];
  const byName = new Map<string, Alias[]>();
  const addAlias = (node: AliasNode, name: ts.Identifier): void => {
    const alias: Alias = { node, name, symbol: undefined, referenced: false, inlined: false };
    aliases.push(alias);
    const list = byName.get(name.text);
    if (list === undefined) byName.set(name.text, [alias]);
    else list.push(alias);
  };
  const addNamespaceAliases = (declaration: ts.ModuleDeclaration): void => {
    const body = declaration.body;
    if (body === undefined) return;
    if (ts.isModuleDeclaration(body)) return addNamespaceAliases(body);
    if (!ts.isModuleBlock(body)) return;
    for (const stmt of body.statements.nodes) {
      if (ts.isImportEqualsDeclaration(stmt)) {
        if (!stmt.isTypeOnly && !ts.isExternalModuleReference(stmt.moduleReference))
          addAlias(stmt, stmt.name);
      } else if (ts.isModuleDeclaration(stmt)) {
        addNamespaceAliases(stmt);
      }
    }
  };
  const imports: ts.ImportDeclaration[] = [];
  const exportLists: ts.ExportDeclaration[] = [];
  const defaultExports: ts.ExportAssignment[] = [];
  for (const stmt of sf.statements.nodes) {
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      // A side-effect import and `import type` are already what they will
      // be; `import defer` is left as written.
      if (clause === undefined || clause.phaseModifier !== undefined) continue;
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      imports.push(stmt);
      if (clause.name !== undefined) addAlias(clause, clause.name);
      const bindings = clause.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements.nodes)
          if (!element.isTypeOnly) addAlias(element, element.name);
      } else {
        addAlias(bindings, bindings.name);
      }
    } else if (ts.isImportEqualsDeclaration(stmt)) {
      if (!stmt.isTypeOnly) addAlias(stmt, stmt.name);
    } else if (ts.isModuleDeclaration(stmt)) {
      // `import x = ns.member` inside a namespace is an alias too: a use of
      // `x` is a use of `ns`.
      if (!hasDeclareModifier(stmt)) addNamespaceAliases(stmt);
    } else if (ts.isExportDeclaration(stmt)) {
      if (
        !stmt.isTypeOnly &&
        stmt.exportClause !== undefined &&
        ts.isNamedExports(stmt.exportClause) &&
        (stmt.moduleSpecifier === undefined || ts.isStringLiteral(stmt.moduleSpecifier))
      )
        exportLists.push(stmt);
    } else if (ts.isExportAssignment(stmt)) {
      if (!stmt.isExportEquals && ts.isIdentifier(stmt.expression)) defaultExports.push(stmt);
    }
  }
  // An import with no binding to keep (`import {} from`, a clause of `type`
  // specifiers only) is still a declaration tsc drops.
  if (
    aliases.length === 0 &&
    imports.length === 0 &&
    exportLists.length === 0 &&
    defaultExports.length === 0
  )
    return null;

  // ---- the uses ----
  const uses: Use[] = [];
  const mentioned = new Set<string>();
  const aliasNames = new Set<ts.Node>(aliases.map((alias) => alias.name));
  if (byName.size > 0) {
    ts.walkPreorder(
      sf,
      (node) => {
        const id = node as ts.Identifier;
        if (!byName.has(id.text)) return;
        if (!aliasNames.has(id)) mentioned.add(id.text);
        const kind = useKindOf(id);
        if (kind !== null && emitsWhereItStands(id)) uses.push({ id, kind });
      },
      IDENTIFIERS,
    );
  }

  // ---- the questions ----
  const questions: ts.Node[] = aliases.map((alias) => alias.name);
  // The first use of a name settles it almost always (it resolves to the
  // import, which names a value), and the decision skips every later use of
  // a settled name. A later use of a name its first use left open (a local
  // that shadows the import, a const enum member tsc inlines) is asked when
  // the decision reaches it.
  const asked = new Set<string>();
  for (const use of uses) {
    if (use.kind === "shorthand" || use.kind === "exported" || asked.has(use.id.text)) continue;
    asked.add(use.id.text);
    questions.push(use.id);
  }
  // Whether a type-only import or export stands between a binding and what
  // it names is read through the module each declaration names
  // (reachedThroughTypeOnly). The module specifiers are not identifiers, so
  // no sweep of a file's identifiers answers them.
  for (const stmt of imports) questions.push(stmt.moduleSpecifier);
  for (const declaration of exportLists) {
    if (declaration.moduleSpecifier === undefined) continue;
    questions.push(declaration.moduleSpecifier);
    for (const element of (declaration.exportClause as ts.NamedExports).elements.nodes)
      if (!element.isTypeOnly) questions.push(element.name);
  }
  return { aliases, byName, imports, exportLists, defaultExports, uses, mentioned, questions };
}

/** The rewritten text of one TypeScript source file, or null when tsc keeps
 * every import and export of it. */
export function elideImports(
  program: ts.Program,
  sf: ts.SourceFile,
  options: ImportElisionOptions,
): ImportElision | null {
  const candidates = candidatesOf(sf);
  if (candidates === null) return null;
  program.getTypeChecker().prefetchSymbolsAtExact(candidates.questions);
  return elideCandidates(program, sf, options, candidates);
}

/** tsc's decision for the candidates of one file. The checker has been
 * asked the candidates' questions. */
function elideCandidates(
  program: ts.Program,
  sf: ts.SourceFile,
  options: ImportElisionOptions,
  candidates: Candidates,
): ImportElision | null {
  const checker = program.getTypeChecker();
  const startOf = (node: ts.Node): number => ts.tokenStartOfNode(node);
  const { aliases, byName, imports, exportLists, defaultExports, uses, mentioned } = candidates;

  // ---- what a symbol names ----
  /** The symbol an alias resolves to, or null when it resolves to nothing
   * (an unresolved module, an untyped one). */
  const targetOf = (symbol: ts.Symbol): ts.Symbol | null => {
    let current = symbol;
    const seen = new Set<ts.Symbol>();
    while ((current.flags & ts.SymbolFlags.Alias) !== 0) {
      if (seen.has(current)) return null;
      seen.add(current);
      let next: ts.Symbol | undefined;
      try {
        next = checker.getAliasedSymbol(current);
      } catch {
        return null;
      }
      if (next === undefined || next === current) return null;
      current = next;
    }
    // The checker's "unknown" symbol: no declaration stands behind it.
    return current.declarations.length === 0 ? null : current;
  };
  const moduleExport = (specifier: ts.Node, name: string): ts.Symbol | undefined =>
    checker.getSymbolAtLocation(specifier)?.getExports().get(ts.escapedSymbolName(name));
  /** Whether a type-only import or export stands between an alias and what
   * it names (`export type { C }` of a class): such a name has no value. */
  const reachedThroughTypeOnly = (symbol: ts.Symbol): boolean => {
    let current: ts.Symbol | undefined = symbol;
    for (let hop = 0; hop < 32 && current !== undefined; hop++) {
      if ((current.flags & ts.SymbolFlags.Alias) === 0) return false;
      const decl: ts.Node | undefined = current.declarations[0];
      if (decl === undefined) return false;
      if (ts.isImportSpecifier(decl)) {
        const clause = decl.parent!.parent as ts.ImportClause;
        if (decl.isTypeOnly || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
        current = moduleExport(
          (clause.parent as ts.ImportDeclaration).moduleSpecifier,
          (decl.propertyName ?? decl.name).text,
        );
      } else if (ts.isImportClause(decl)) {
        if (decl.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
        current = moduleExport((decl.parent as ts.ImportDeclaration).moduleSpecifier, "default");
      } else if (ts.isNamespaceImport(decl)) {
        return (decl.parent as ts.ImportClause).phaseModifier === ts.SyntaxKind.TypeKeyword;
      } else if (ts.isImportEqualsDeclaration(decl)) {
        return decl.isTypeOnly;
      } else if (ts.isExportSpecifier(decl)) {
        const declaration = decl.parent!.parent as ts.ExportDeclaration;
        if (decl.isTypeOnly || declaration.isTypeOnly) return true;
        const name = (decl.propertyName ?? decl.name).text;
        current =
          declaration.moduleSpecifier !== undefined
            ? moduleExport(declaration.moduleSpecifier, name)
            : checker.resolveName(name, ALL_MEANINGS, decl, false);
      } else if (ts.isNamespaceExport(decl)) {
        return (decl.parent as ts.ExportDeclaration).isTypeOnly;
      } else {
        return false;
      }
    }
    return false;
  };
  const constEnumOnly = (target: ts.Symbol): boolean => {
    if ((target.flags & ts.SymbolFlags.ConstEnum) !== 0) return true;
    if ((target.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) === 0)
      return false;
    let state: 0 | 1 | 2 = 0;
    for (const decl of target.declarations) {
      if (!ts.isModuleDeclaration(decl)) return false;
      const own = namespaceInstanceState(decl);
      if (own === 1) return false;
      if (own === 2) state = 2;
    }
    return state === 2;
  };
  /** tsc's getSymbolFlags(symbol, excludeTypeOnlyMeanings) & Value. */
  const namesValue = (symbol: ts.Symbol): boolean => {
    const target = targetOf(symbol);
    if (target === null) return true;
    return (target.flags & ts.SymbolFlags.Value) !== 0 && !reachedThroughTypeOnly(symbol);
  };
  /** tsc's isAliasResolvedToValue: a value the emit keeps. */
  const emitsValue = (symbol: ts.Symbol): boolean => {
    const target = targetOf(symbol);
    if (target === null) return true;
    if ((target.flags & ts.SymbolFlags.Value) === 0 || reachedThroughTypeOnly(symbol)) return false;
    return options.preserveConstEnums || !constEnumOnly(target);
  };

  // ---- marking ----
  const aliasOf = (symbol: ts.Symbol | undefined, name: string): Alias | undefined => {
    if (symbol === undefined) return undefined;
    return byName.get(name)?.find((alias) => alias.symbol === symbol);
  };
  /** tsc's markAliasReferenced. */
  const mark = (alias: Alias, inExport: boolean): void => {
    if (alias.referenced || alias.symbol === undefined) return;
    if (!namesValue(alias.symbol)) return;
    const target = targetOf(alias.symbol);
    if (
      !options.isolatedModules &&
      !(options.preserveConstEnums && inExport) &&
      target !== null &&
      constEnumOnly(target)
    ) {
      alias.inlined = true;
      return;
    }
    alias.referenced = true;
    // `import a = b.c`: using `a` uses `b`.
    const node = alias.node;
    if (ts.isImportEqualsDeclaration(node) && !ts.isExternalModuleReference(node.moduleReference))
      markEntityHead(node.moduleReference, false);
  };
  const markEntityHead = (entity: ts.Node, inExport: boolean): void => {
    let head = entity;
    while (ts.isQualifiedName(head)) head = head.left;
    if (!ts.isIdentifier(head)) return;
    const alias = aliasOf(checker.resolveName(head.text, ALL_MEANINGS, head, false), head.text);
    if (alias !== undefined) mark(alias, inExport);
  };

  for (const alias of aliases) alias.symbol = checker.getSymbolAtLocation(alias.name);
  for (const alias of aliases) {
    const node = alias.node;
    if (!ts.isImportEqualsDeclaration(node)) continue;
    // A name the checker cannot place is left as written.
    if (alias.symbol === undefined) alias.referenced = true;
    // `export import x = …` of a value is always kept. Any other alias,
    // `import x = require("m")` and `import x = ns.member` alike, is emitted
    // only when the file uses it as a value.
    else if (hasExportModifier(node)) mark(alias, true);
  }

  for (const use of uses) {
    const name = use.id.text;
    if (byName.get(name)!.every((alias) => alias.referenced)) continue;
    let symbol: ts.Symbol | undefined;
    if (use.kind === "shorthand")
      symbol = checker.getShorthandAssignmentValueSymbol(use.id.parent!);
    else if (use.kind === "exported")
      // The checker answers an exported name with what it resolves to; the
      // binding itself is the question here.
      symbol = checker.resolveName(name, ALL_MEANINGS, use.id, false);
    else symbol = checker.getSymbolAtLocation(use.id);
    const alias = aliasOf(symbol, name);
    if (alias === undefined) continue;
    if (use.kind !== "property") {
      // `export default name` of a name with no value is dropped below, and
      // the use with it. A const enum name stays a value export, so the
      // binding behind it is kept for the export.
      const parent = use.id.parent!;
      if (
        use.kind === "exported" &&
        ts.isExportAssignment(parent) &&
        !parent.isExportEquals &&
        alias.symbol !== undefined &&
        !emitsValue(alias.symbol) &&
        !namesValue(alias.symbol)
      )
        continue;
      mark(alias, use.kind === "exported");
      continue;
    }
    // tsc's markPropertyAliasReferenced: `ns.E.A` keeps `ns` unless `E` is a
    // const enum, and an enum member initializer that is another enum's
    // member is inlined.
    const access = use.id.parent as ts.PropertyAccessExpression;
    const inExport = headsExportedExpression(use.id);
    if (!options.isolatedModules && !(options.preserveConstEnums && inExport)) {
      const member = checker.getSymbolAtLocation(access.name);
      const resolved = member === undefined ? null : (targetOf(member) ?? member);
      if (
        resolved !== null &&
        (constEnumOnly(resolved) ||
          ((resolved.flags & ts.SymbolFlags.EnumMember) !== 0 &&
            access.parent !== undefined &&
            ts.isEnumMember(access.parent)))
      ) {
        if (alias.symbol !== undefined && namesValue(alias.symbol)) alias.inlined = true;
        continue;
      }
    }
    mark(alias, inExport);
  }

  // ---- export lists and `export default name` ----
  const droppedExports = new Set<ts.ExportSpecifier>();
  const inlinedExports: string[] = [];
  /** A specifier stays a value export when its name means a value here, even
   * if tsc's output has no value for it: a const enum (or a namespace of
   * const enums) is a name a value use keeps, so a file that imports this
   * export and uses it as a value has to find a value meaning on it. Such a
   * name is recorded in `inlinedExports`. */
  const keepsValueExport = (
    element: ts.ExportSpecifier,
    symbol: ts.Symbol | undefined,
  ): boolean => {
    if (symbol === undefined || emitsValue(symbol)) return true;
    if (!namesValue(symbol)) return false;
    inlinedExports.push(element.name.text);
    return true;
  };
  for (const declaration of exportLists) {
    const elements = (declaration.exportClause as ts.NamedExports).elements.nodes;
    for (const element of elements) {
      if (element.isTypeOnly) continue;
      let value: boolean;
      if (declaration.moduleSpecifier !== undefined) {
        value = keepsValueExport(element, checker.getSymbolAtLocation(element.name));
      } else {
        const local = element.propertyName ?? element.name;
        const symbol = checker.resolveName(local.text, ALL_MEANINGS, element, false);
        value = keepsValueExport(element, symbol);
        if (value) {
          const alias = aliasOf(symbol, local.text);
          if (alias !== undefined) mark(alias, true);
        }
      }
      if (!value) droppedExports.add(element);
    }
  }
  const droppedDefaults: ts.ExportAssignment[] = [];
  for (const assignment of defaultExports) {
    const id = assignment.expression as ts.Identifier;
    const symbol = checker.resolveName(id.text, ALL_MEANINGS, id, false);
    // The same rule as an export list: the name of a const enum stays a
    // value, so `export default E` stays as written.
    if (symbol !== undefined && !emitsValue(symbol) && !namesValue(symbol))
      droppedDefaults.push(assignment);
  }

  // `import x = ns.member` that no value use reached: tsc emits nothing for
  // it. One that is never mentioned again goes; one that still names a type
  // (`let v: x.T`) has to stay as written, and the `ns` it reads with it.
  const droppedEntityAliases: ts.ImportEqualsDeclaration[] = [];
  for (const alias of aliases) {
    const node = alias.node;
    if (!ts.isImportEqualsDeclaration(node) || alias.referenced) continue;
    if (ts.isExternalModuleReference(node.moduleReference)) continue;
    if (!mentioned.has(alias.name.text)) {
      droppedEntityAliases.push(node);
      continue;
    }
    alias.inlined = true;
    let head: ts.Node = node.moduleReference;
    while (ts.isQualifiedName(head)) head = head.left;
    if (!ts.isIdentifier(head)) continue;
    const target = aliasOf(checker.resolveName(head.text, ALL_MEANINGS, head, false), head.text);
    if (target !== undefined && !target.referenced) target.inlined = true;
  }

  const kept = (alias: Alias): boolean => {
    if (alias.referenced || alias.inlined) return true;
    if (!options.preserveValueImports) return false;
    return alias.symbol === undefined || emitsValue(alias.symbol);
  };
  const tscKeeps = (alias: Alias): boolean => kept(alias) && !(alias.inlined && !alias.referenced);
  const keptNode = new Map<ts.Node, boolean>();
  for (const alias of aliases) keptNode.set(alias.node, kept(alias));

  // ---- the rewrite ----
  const blanks: ts.SourceTextBlank[] = [];
  /** Blanks from the first token of `from` to the last token of `to`. */
  const blankNodes = (from: ts.Node, to: ts.Node = from): void => {
    blanks.push({ start: startOf(from), end: to.end, span: ts.TOKEN_SPAN });
  };
  /** Blanks from the first token of `from` up to the first token of `next`. */
  const blankUpTo = (from: ts.Node, next: ts.Node): void => {
    blanks.push({ start: startOf(from), end: startOf(next), span: ts.UP_TO_TOKEN_SPAN });
  };
  /** Blanks what follows the last token of `after` through the last token
   * of `to`. */
  const blankAfter = (after: ts.Node, to: ts.Node): void => {
    blanks.push({ start: after.end, end: to.end, span: ts.FULL_SPAN });
  };
  const added: string[] = [];
  const inlinedOnly: ImportElision["inlinedOnly"] = [];
  const inlined = aliases
    .filter((alias) => alias.inlined && !alias.referenced)
    .map((alias) => alias.name.text);
  let declarations = 0;
  let bindings = 0;
  let lostModuleSyntax = false;
  const specifierText = (element: ts.ImportSpecifier | ts.ExportSpecifier): string =>
    element.propertyName === undefined
      ? nameSource(element.name)
      : `${nameSource(element.propertyName)} as ${nameSource(element.name)}`;
  /** Blanks the dropped elements of a brace list, each with the separator
   * that follows it. */
  const blankElements = (
    elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[],
    dropped: (element: ts.ImportSpecifier | ts.ExportSpecifier) => boolean,
  ): void => {
    elements.forEach((element, index) => {
      if (!dropped(element)) return;
      const next = elements[index + 1];
      if (next === undefined) blankNodes(element);
      else blankUpTo(element, next);
    });
  };

  for (const stmt of imports) {
    const clause = stmt.importClause!;
    const from = specifierSource(stmt.moduleSpecifier)!;
    const named =
      clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings
        : undefined;
    const namespace =
      clause.namedBindings !== undefined && !ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings
        : undefined;
    const keepsDefault = clause.name !== undefined && keptNode.get(clause) === true;
    const keepsNamespace = namespace !== undefined && keptNode.get(namespace) === true;
    const elements = named?.elements.nodes ?? [];
    const droppedElement = (element: ts.ImportSpecifier | ts.ExportSpecifier): boolean =>
      !element.isTypeOnly && keptNode.get(element) !== true;
    const keepsNamed = elements.some((element) => !element.isTypeOnly && !droppedElement(element));
    const own = aliases.filter(
      (alias) =>
        alias.node === clause ||
        alias.node === namespace ||
        elements.includes(alias.node as ts.ImportSpecifier),
    );
    if (own.some(kept) && !own.some(tscKeeps) && !options.preserveImportEdges)
      inlinedOnly.push({ start: startOf(stmt), end: stmt.end, specifier: from });
    const typeNames: string[] = [];
    if (!keepsDefault && !keepsNamespace && !keepsNamed) {
      // The declaration goes. Its names stay declared for the types that use
      // them.
      if (clause.name !== undefined) added.push(`import type ${clause.name.text} from ${from};`);
      if (namespace !== undefined)
        added.push(`import type * as ${namespace.name.text} from ${from};`);
      for (const element of elements) typeNames.push(specifierText(element));
      if (options.preserveImportEdges) {
        // The module is still loaded, where the declaration stands.
        blankUpTo(clause, stmt.moduleSpecifier);
        bindings += aliases.filter(
          (alias) => alias.node === clause || alias.node === namespace,
        ).length;
        bindings += elements.filter(droppedElement).length;
      } else {
        blankNodes(stmt);
        declarations++;
        lostModuleSyntax = true;
      }
    } else {
      if (clause.name !== undefined && !keepsDefault) {
        added.push(`import type ${clause.name.text} from ${from};`);
        blankUpTo(clause.name, clause.namedBindings!);
        bindings++;
      }
      if (namespace !== undefined && !keepsNamespace) {
        added.push(`import type * as ${namespace.name.text} from ${from};`);
        blankAfter(clause.name!, namespace);
        bindings++;
      }
      if (named !== undefined && !keepsNamed) {
        // Only the default binding stays: `import d, { A } from` becomes
        // `import d from`.
        if (elements.some(droppedElement)) {
          for (const element of elements) typeNames.push(specifierText(element));
          blankAfter(clause.name!, named);
          bindings += elements.filter(droppedElement).length;
        }
      } else if (named !== undefined) {
        for (const element of elements)
          if (droppedElement(element)) {
            typeNames.push(specifierText(element));
            bindings++;
          }
        blankElements(elements, droppedElement);
      }
    }
    if (typeNames.length > 0) added.push(`import type { ${typeNames.join(", ")} } from ${from};`);
  }

  for (const node of droppedEntityAliases) {
    blankNodes(node);
    declarations++;
  }
  for (const alias of aliases) {
    const node = alias.node;
    if (!ts.isImportEqualsDeclaration(node) || keptNode.get(node) === true) continue;
    if (!ts.isExternalModuleReference(node.moduleReference)) continue;
    // `import x = require(…)` of anything but a string literal does not
    // parse; it is left as written.
    const required = specifierSource(node.moduleReference.expression);
    if (required === null) continue;
    blankNodes(node);
    added.push(`import type ${node.name.text} = require(${required});`);
    declarations++;
  }

  for (const declaration of exportLists) {
    const elements = (declaration.exportClause as ts.NamedExports).elements.nodes;
    const dropped = (element: ts.ImportSpecifier | ts.ExportSpecifier): boolean =>
      droppedExports.has(element as ts.ExportSpecifier);
    const keepsAny = elements.some((element) => !element.isTypeOnly && !dropped(element));
    // A local list that names no value (`export {}`, `export { type T }`)
    // is the same module with or without it.
    if (declaration.moduleSpecifier === undefined && !elements.some(dropped)) continue;
    const from =
      declaration.moduleSpecifier === undefined
        ? ""
        : ` from ${specifierSource(declaration.moduleSpecifier)!}`;
    const typeNames: string[] = [];
    if (keepsAny) {
      for (const element of elements)
        if (dropped(element)) {
          typeNames.push(specifierText(element));
          bindings++;
        }
      blankElements(elements, dropped);
    } else if (options.preserveImportEdges && declaration.moduleSpecifier !== undefined) {
      // `export {} from "./m"` still loads the module.
      for (const element of elements) typeNames.push(specifierText(element));
      if (elements.length > 0) blankNodes(elements[0]!, elements[elements.length - 1]!);
      bindings += elements.filter(dropped).length;
    } else {
      for (const element of elements) typeNames.push(specifierText(element));
      blankNodes(declaration);
      declarations++;
      lostModuleSyntax = true;
    }
    if (typeNames.length > 0) added.push(`export type { ${typeNames.join(", ")} }${from};`);
  }

  for (const assignment of droppedDefaults) {
    blankNodes(assignment);
    added.push(`export type { ${(assignment.expression as ts.Identifier).text} as default };`);
    declarations++;
    lostModuleSyntax = true;
  }

  if (blanks.length === 0)
    return inlined.length === 0 && inlinedExports.length === 0
      ? null
      : { text: null, declarations, bindings, inlined, inlinedExports, inlinedOnly };
  // tsc emits `export {}` for a module that loses its last import or export,
  // so the file keeps its format. CommonJS TypeScript (.cts, `export =`) has
  // no such marker to keep.
  const exportEquals = sf.statements.nodes.some(
    (stmt) => ts.isExportAssignment(stmt) && stmt.isExportEquals,
  );
  if (lostModuleSyntax && !exportEquals && !sf.fileName.endsWith(".cts")) added.push("export {};");
  const tail = added.length > 0 ? `${added.join("\n")}\n` : "";
  return {
    text: ts.sourceTextRewritten(sf, blanks, tail),
    declarations,
    bindings,
    inlined,
    inlinedExports,
    inlinedOnly,
  };
}

/** What a parsed tsconfig's compiler options say about elision, or null when
 * they select Node's rule (`verbatimModuleSyntax`), under which every import
 * is kept as written. */
export function importElisionOptions(
  options: Readonly<Record<string, unknown>>,
): ImportElisionOptions | null {
  if (options["verbatimModuleSyntax"] === true) return null;
  const isolatedModules = options["isolatedModules"] === true;
  const unused = options["importsNotUsedAsValues"];
  return {
    isolatedModules,
    preserveConstEnums: isolatedModules || options["preserveConstEnums"] === true,
    // The parser answers the option's name or its enum value (remove = 0).
    preserveImportEdges:
      unused === 1 ||
      unused === 2 ||
      (typeof unused === "string" && /^(?:preserve|error)$/i.test(unused)),
    preserveValueImports: options["preserveValueImports"] === true,
  };
}

const TYPESCRIPT_SOURCE = /\.(?:[mc]?ts|tsx)$/;

export interface ProgramImportElision {
  /** The rewritten text of each file tsc would drop imports or exports of. */
  texts: Map<string, string>;
  /** The import declarations kept although tsc drops them
   * (ImportElision.inlinedOnly), by file. */
  inlinedOnly: { file: string; start: number; end: number; specifier: string }[];
}

/** tsc's elision for every TypeScript source of `program`. `optionsOf`
 * answers the settings of the tsconfig that governs a file, or null for a
 * file under Node's rule. */
export function elideProgramImports(
  program: ts.Program,
  optionsOf: (fileName: string) => ImportElisionOptions | null,
): ProgramImportElision {
  const out: ProgramImportElision = { texts: new Map(), inlinedOnly: [] };
  // Every file's candidates first, from its syntax, so that the checker is
  // asked about all of them at once: a request per file and one more per
  // import declaration is most of what the decision costs on a program of
  // many files.
  const files: {
    sf: ts.SourceFile;
    options: ImportElisionOptions;
    candidates: Candidates;
  }[] = [];
  const questions: ts.Node[] = [];
  for (const sf of program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile || !TYPESCRIPT_SOURCE.test(sf.fileName)) continue;
    const options = optionsOf(sf.fileName);
    if (options === null) continue;
    const candidates = candidatesOf(sf);
    if (candidates === null) continue;
    files.push({ sf, options, candidates });
    for (const node of candidates.questions) questions.push(node);
  }
  if (files.length === 0) return out;
  program.getTypeChecker().prefetchSymbolsAtExact(questions);
  for (const { sf, options, candidates } of files) {
    const elision = elideCandidates(program, sf, options, candidates);
    if (elision === null) continue;
    if (elision.text !== null) out.texts.set(sf.fileName, elision.text);
    for (const kept of elision.inlinedOnly) out.inlinedOnly.push({ file: sf.fileName, ...kept });
  }
  return out;
}
