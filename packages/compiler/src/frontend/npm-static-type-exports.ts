/* The type-only exports of an opted-in package's declaration files.
 *
 * An opted-in package compiles from its JavaScript, and the checker types
 * the package from it: the package's shipped .d.ts is hidden from
 * resolution (npmStaticFsShadow). Values keep their JavaScript types, but a
 * type that exists only in the .d.ts (an interface, a type alias, an enum
 * used as a type) has no declaration in the JavaScript, so a program's
 * `import type { Options } from "pkg"` resolved to `any`. TypeScript and
 * Node see the .d.ts types.
 *
 * The package's declaration files stay available as copies under another
 * name (`<file>.scriptc-types.d.ts`, relative specifiers respelled to the
 * copies), and the runtime entry gains a JSDoc typedef per type-only export
 * that names the declaration in the copy:
 *
 *   / ** @template T @typedef {import("./main.scriptc-types").Box<T>} Box * /
 *
 * Classes and values keep the JavaScript's own declarations. */
import * as ts from "./ts7/syntax.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";

/** A type-only declaration: its exported name, its name where it is
 * declared, its type parameters' names and their JSDoc @template tag
 * bodies, and what npmStaticDataShape needs to know. */
export interface NpmStaticTypeDeclaration {
  name: string;
  declared: string;
  params: readonly string[];
  templates: readonly string[];
  /** The declaration's own syntax describes behavior or a computed type:
   * a method, call or construct signature, a function or constructor
   * type, an accessor, `typeof`, `import("...")`, a conditional, mapped,
   * indexed-access or `keyof` type, or a qualified type name. */
  behavior: boolean;
  /** The type names it refers to, its own type parameters excepted. */
  references: readonly string[];
}

/** What a declaration file declares and re-exports, by exported name. */
export interface NpmStaticDeclarationExports {
  /** Exported interfaces, type aliases and enums, with their parameters. */
  types: readonly NpmStaticTypeDeclaration[];
  /** Exported classes, functions, variables and namespaces: names the
   * JavaScript declares itself, or that are not type-only. */
  values: readonly string[];
  /** `export { local as exported } from "specifier"`, including a local
   * `export { a }` of an imported name. */
  named: readonly { exported: string; local: string; specifier: string | null }[];
  /** `export * from "specifier"`. */
  stars: readonly string[];
  /** Every interface, type alias and enum the file declares, by name. */
  locals: ReadonlyMap<string, NpmStaticTypeDeclaration>;
  /** The file's named imports: local name to imported name and specifier. */
  imports: ReadonlyMap<string, { local: string; specifier: string }>;
  /** Every class, function, namespace and variable the file declares. */
  valueNames: ReadonlySet<string>;
}

function isExported(node: ts.Node): boolean {
  const modifiers = (node as { modifiers?: { nodes: readonly ts.Node[] } }).modifiers?.nodes ?? [];
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function templatesOf(sf: ts.SourceFile, params: readonly ts.TypeParameterDeclaration[]): string[] {
  const text = (n: ts.Node): string => sf.text.slice(tokenStartOfNode(n), n.end);
  return params.map((p) => {
    const name = p.name.text;
    const constraint = p.constraint === undefined ? "" : `{${text(p.constraint)}} `;
    return p.defaultType === undefined
      ? `${constraint}${name}`
      : `${constraint}[${name}=${text(p.defaultType)}]`;
  });
}

/** Syntax kinds of a type that describes behavior or is computed. */
const BEHAVIOR_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.CallSignature,
  ts.SyntaxKind.ConstructSignature,
  ts.SyntaxKind.FunctionType,
  ts.SyntaxKind.ConstructorType,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.TypeQuery,
  ts.SyntaxKind.ImportType,
  ts.SyntaxKind.ConditionalType,
  ts.SyntaxKind.MappedType,
  ts.SyntaxKind.InferType,
  ts.SyntaxKind.IndexedAccessType,
  ts.SyntaxKind.ThisType,
  ts.SyntaxKind.TypePredicate,
  ts.SyntaxKind.TemplateLiteralType,
]);

/** The behavior flag and type references of an interface or type alias. */
function shapeOf(
  decl: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  params: readonly string[],
): { behavior: boolean; references: string[] } {
  let behavior = false;
  const references = new Set<string>();
  const refer = (name: ts.Node): void => {
    if (ts.isIdentifier(name)) {
      if (!params.includes(name.text)) references.add(name.text);
    } else behavior = true; // a qualified name: a namespace member
  };
  ts.walkPreorder(decl, (n) => {
    if (behavior) return "stop";
    if (BEHAVIOR_KINDS.has(n.kind)) behavior = true;
    else if (ts.isTypeOperatorNode(n) && n.operator === ts.SyntaxKind.KeyOfKeyword) behavior = true;
    else if (ts.isTypeReferenceNode(n)) refer(n.typeName);
    else if (ts.isExpressionWithTypeArguments(n)) refer(n.expression);
    return undefined;
  });
  return { behavior, references: [...references] };
}

/** The exports of one declaration file. */
export function npmStaticDeclarationExports(sf: ts.SourceFile): NpmStaticDeclarationExports {
  const types: NpmStaticTypeDeclaration[] = [];
  const values: string[] = [];
  const named: { exported: string; local: string; specifier: string | null }[] = [];
  const stars: string[] = [];
  const localTypes = new Map<string, NpmStaticTypeDeclaration>();
  const localValues = new Set<string>();
  // `import { A as B } from "./x"`: local name B is A of "./x".
  const imported = new Map<string, { local: string; specifier: string }>();
  for (const stmt of sf.statements.nodes) {
    const exported = isExported(stmt);
    if (ts.isImportDeclaration(stmt)) {
      const bindings = stmt.importClause?.namedBindings;
      if (ts.isStringLiteral(stmt.moduleSpecifier) && bindings && ts.isNamedImports(bindings)) {
        for (const e of bindings.elements.nodes) {
          imported.set(e.name.text, {
            local: (e.propertyName ?? e.name).text,
            specifier: stmt.moduleSpecifier.text,
          });
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
      const params = stmt.typeParameters?.nodes ?? [];
      const paramNames = params.map((p) => p.name.text);
      const shape = shapeOf(stmt, paramNames);
      const merged = localTypes.get(stmt.name.text); // interface merging
      const decl: NpmStaticTypeDeclaration = {
        name: stmt.name.text,
        declared: stmt.name.text,
        params: paramNames,
        templates: templatesOf(sf, params),
        behavior: shape.behavior || merged?.behavior === true,
        references: [...shape.references, ...(merged?.references ?? [])],
      };
      localTypes.set(decl.name, decl);
      if (exported && merged === undefined) types.push(decl);
    } else if (ts.isEnumDeclaration(stmt)) {
      const decl: NpmStaticTypeDeclaration = {
        name: stmt.name.text,
        declared: stmt.name.text,
        params: [],
        templates: [],
        behavior: false,
        references: [],
      };
      localTypes.set(decl.name, decl);
      if (exported) types.push(decl);
    } else if (
      ts.isClassDeclaration(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)
    ) {
      const name = stmt.name !== undefined && ts.isIdentifier(stmt.name) ? stmt.name.text : null;
      if (name !== null) {
        localValues.add(name);
        if (exported) values.push(name);
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations.nodes) {
        if (!ts.isIdentifier(d.name)) continue;
        localValues.add(d.name.text);
        if (exported) values.push(d.name.text);
      }
    } else if (ts.isExportDeclaration(stmt)) {
      const specifier =
        stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : null;
      const clause = stmt.exportClause;
      if (clause === undefined) {
        if (specifier !== null) stars.push(specifier);
      } else if (ts.isNamedExports(clause)) {
        for (const e of clause.elements.nodes) {
          const exportedName = e.name.text;
          const local = (e.propertyName ?? e.name).text;
          named.push({ exported: exportedName, local, specifier });
        }
      }
    }
  }
  // Local `export { a as b }`: of the file's own declarations, or of a
  // name it imports (`import type { A } from "./a"; export { A }`), which
  // resolves like `export { A } from "./a"`.
  const resolvedNamed: typeof named = [];
  for (const n of named) {
    if (n.specifier !== null) {
      resolvedNamed.push(n);
      continue;
    }
    const local = localTypes.get(n.local);
    const from = imported.get(n.local);
    if (local !== undefined) types.push({ ...local, name: n.exported });
    else if (localValues.has(n.local)) values.push(n.exported);
    else if (from !== undefined) resolvedNamed.push({ exported: n.exported, ...from });
  }
  // A merged interface's exported entry takes the merged flags.
  const exportedTypes: NpmStaticTypeDeclaration[] = [];
  for (const t of types) {
    const local = localTypes.get(t.declared);
    if (local === undefined) exportedTypes.push(t);
    else exportedTypes.push({ ...local, name: t.name });
  }
  return {
    types: exportedTypes,
    values,
    named: resolvedNamed,
    stars,
    locals: localTypes,
    imports: imported,
    valueNames: localValues,
  };
}

/** The relative module specifiers of a declaration file's imports, exports
 * and `import("...")` types, with their spans. */
function relativeSpecifiers(sf: ts.SourceFile): { start: number; end: number; text: string }[] {
  const found: { start: number; end: number; text: string }[] = [];
  const add = (literal: ts.Node | undefined): void => {
    if (literal === undefined || !ts.isStringLiteral(literal)) return;
    if (!literal.text.startsWith("./") && !literal.text.startsWith("../")) return;
    found.push({ start: tokenStartOfNode(literal), end: literal.end, text: literal.text });
  };
  ts.walkPreorder(sf, (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) add(n.moduleSpecifier);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) add(n.argument.literal);
    return undefined;
  });
  return found;
}

/** The relative specifiers a declaration file names. */
export function npmStaticDeclarationSpecifiers(sf: ts.SourceFile): string[] {
  return relativeSpecifiers(sf).map((s) => s.text);
}

/** The declaration file's text with each relative specifier `rename`
 * answers respelled (quoted with the original's quote). */
export function npmStaticDeclarationCopy(
  sf: ts.SourceFile,
  rename: (specifier: string) => string | null,
): string {
  const spans = relativeSpecifiers(sf).sort((a, b) => a.start - b.start);
  let text = "";
  let at = 0;
  for (const span of spans) {
    const renamed = rename(span.text);
    if (renamed === null) continue;
    const quote = sf.text[span.start] ?? '"';
    text += sf.text.slice(at, span.start) + quote + renamed + quote;
    at = span.end;
  }
  return text + sf.text.slice(at);
}

/** The JSDoc typedefs that re-export `types` from the copy at `specifier`. */
export function npmStaticTypedefBlock(
  types: readonly NpmStaticTypeDeclaration[],
  specifier: string,
): string {
  const lines: string[] = [];
  for (const t of types) {
    const args = t.params.length === 0 ? "" : `<${t.params.join(", ")}>`;
    lines.push("/**");
    for (const tag of t.templates) lines.push(` * @template ${tag}`);
    lines.push(` * @typedef {import(${JSON.stringify(specifier)}).${t.name}${args}} ${t.name}`);
    lines.push(" */");
  }
  return lines.join("\n");
}
