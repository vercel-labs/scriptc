/* Contract types (@scriptc/types): written annotations scriptc checks as
 * extra contracts. The package is types only (`export type` aliases that
 * TypeScript erases), so Node.js never loads it; scriptc recognizes the
 * aliases by import provenance, like threads-import.ts recognizes the
 * @scriptc/threads exports. TypeScript drops alias identity from inferred
 * types, so only annotations the program WRITES count: parameter, return,
 * variable and class field types, and the class markers (Acyclic,
 * ProgramLifetime) in heritage clauses. The IR-side checks live in
 * contracts/check.ts. */
import { resolve } from "node:path";
import type { DiagnosticCode } from "../diagnostics/codes.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import { locOf } from "./program.js";
import { resolveProjectModule } from "./resolve.js";
import * as ts from "./ts7/adapter.js";
import { type HeritageElement, isHeritageElement } from "./heritage-elements.js";

export const CONTRACT_TYPES_MODULE = "@scriptc/types";

/** The module and name of the inline array field marker, which is
 * experimental: `readonly f: InlineArray<C>` on an instance field of a
 * ProgramLifetime class (ir/inline-arrays.ts). */
export const INLINE_ARRAY_MODULE = "@scriptc/experimental";
export const INLINE_ARRAY_MARKER = "InlineArray";

export type ContractMarker =
  | "Int32"
  | "NoThrow"
  | "Immutable"
  | "Acyclic"
  | "ProgramLifetime"
  | typeof INLINE_ARRAY_MARKER;
const MARKERS: ReadonlySet<string> = new Set([
  "Int32",
  "NoThrow",
  "Immutable",
  "Acyclic",
  "ProgramLifetime",
  INLINE_ARRAY_MARKER,
]);

/** The module a marker is imported from. */
function markerModule(marker: string): string {
  return marker === INLINE_ARRAY_MARKER ? INLINE_ARRAY_MODULE : CONTRACT_TYPES_MODULE;
}

/** One written contract: what it promises and where the annotation is. */
export interface ContractNote {
  marker: ContractMarker;
  /** The annotation (the marker's type reference). */
  loc: SrcLoc;
  /** The annotated declaration's name, for messages. */
  name: string;
  /** `Int32[]` (also `readonly Int32[]`, `Array<Int32>`, `ReadonlyArray<Int32>`):
   * the contract covers the elements of the annotated array. */
  elements?: true;
}

/** An Acyclic type: a class (by its declaration's location key, like
 * `fields`) or an object type written as an interface or type alias (by
 * the IR unit it lowers to: `record:<id>`, `object:<class>` or
 * `union:<id>`; null when the program never uses the type, so no value of
 * it exists). */
export interface AcyclicNote {
  note: ContractNote;
  classKey?: string;
  unit?: string | null;
}

/** Maps a TypeScript type to the IR unit the program lowered it to, or
 * null when the program has no such unit. */
export type ContractUnitResolver = (type: ts.Type) => string | null;

/** Contracts keyed by the declaration they annotate. Keys are SrcLoc keys
 * (contractLocKey) of the nodes the lowering stamps on the IR: function
 * declarations (IrFunction.loc), binding names (IrLocal/IrGlobal
 * source.loc), and classes (IrClassDef.loc) plus the field name. */
export interface ContractAnnotations {
  /** NoThrow and result markers (Int32, Immutable) by function. */
  functions: Map<string, ContractNote[]>;
  /** Parameters and variables by their name's location. */
  bindings: Map<string, ContractNote>;
  /** Instance fields by `${class key}\0${field name}`. */
  fields: Map<string, ContractNote>;
  /** Acyclic classes and object types. */
  acyclic: AcyclicNote[];
  /** ProgramLifetime classes (`implements ProgramLifetime`) by class key. */
  classes: Map<string, ContractNote>;
  /** Inline array fields (`readonly f: InlineArray<C>`) by
   * `${class key}\0${field name}`. */
  inlineArrays: Map<string, ContractNote>;
  diagnostics: ScrDiagnostic[];
  /** Number of annotations found (for timing and tests). */
  count: number;
}

export function contractLocKey(loc: SrcLoc): string {
  return `${loc.file}\0${loc.start}\0${loc.end}`;
}

/** A written name that is a marker, or one that is imported from the
 * contract package but whose alias chain stops before the package's own
 * declaration (reported instead of dropping the contract). */
type MarkerResolution =
  | { kind: "marker"; marker: ContractMarker }
  | {
      kind: "unresolved";
      name: string;
      /** The module the annotation's binding is imported from, when it is
       * known; the contract module otherwise. */
      module?: string;
    };

/** The marker a type reference names when its name is a named or namespace
 * import binding of @scriptc/types (`import type { Int32 } from
 * "@scriptc/types"`, `import type * as sc from "@scriptc/types"`), directly
 * or through an alias or re-export. */
function markerOf(checker: ts.TypeChecker, ref: ts.TypeReferenceNode): MarkerResolution | null {
  const name = ref.typeName;
  if (ts.isIdentifier(name)) return markerNamed(checker, name, false);
  if (ts.isQualifiedName(name) && ts.isIdentifier(name.left))
    return markerNamed(checker, name.left, true, name.right.text);
  return null;
}

/** The marker a heritage clause names (`implements Acyclic`,
 * `implements sc.ProgramLifetime`), as an ExpressionWithTypeArguments or,
 * in TypeScript 7.1's interface `extends` and class `implements`, a
 * TypeReference. */
function markerOfHeritage(checker: ts.TypeChecker, node: HeritageElement): MarkerResolution | null {
  if (ts.isTypeReferenceNode(node)) return markerOf(checker, node);
  const e = node.expression;
  if (ts.isIdentifier(e)) return markerNamed(checker, e, false);
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && ts.isIdentifier(e.name))
    return markerNamed(checker, e.expression, true, e.name.text);
  return null;
}

/** The marker a type reference names, when it names one. */
function markerTypeOf(checker: ts.TypeChecker, ref: ts.TypeReferenceNode): ContractMarker | null {
  const resolution = markerOf(checker, ref);
  return resolution?.kind === "marker" ? resolution.marker : null;
}

/** The module a declaration file is the entry of: the contract packages'
 * `index.d.ts`, in the workspace (`packages/<name>/index.d.ts`) or installed
 * (`node_modules/@scriptc/<name>/index.d.ts`). */
function contractModuleOfFile(fileName: string): string | null {
  if (/(?:^|[\\/])(?:@scriptc[\\/]types|packages[\\/]types)[\\/]index\.d\.ts$/.test(fileName))
    return CONTRACT_TYPES_MODULE;
  if (
    /(?:^|[\\/])(?:@scriptc[\\/]experimental|packages[\\/]experimental)[\\/]index\.d\.ts$/.test(
      fileName,
    )
  )
    return INLINE_ARRAY_MODULE;
  return null;
}

function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  try {
    return checker.getSymbolAtLocation(node);
  } catch {
    return undefined;
  }
}

/** The module an import or re-export binding names, and the member it names
 * there, or null when the declaration is neither. An import specifier sits
 * under a named binding under an import clause; an export specifier sits
 * under a named binding under the export declaration that holds the module
 * specifier. */
function importedFrom(decl: ts.Node): { module: string; member: string } | null {
  if (!ts.isImportSpecifier(decl) && !ts.isExportSpecifier(decl)) return null;
  const statement = importStatementOf(decl);
  if (statement === null) return null;
  const moduleSpecifier = (statement as ts.ImportDeclaration).moduleSpecifier;
  if (moduleSpecifier === undefined || !ts.isStringLiteral(moduleSpecifier)) return null;
  return { module: moduleSpecifier.text, member: decl.propertyName?.text ?? decl.name.text };
}

/** Resolve `ident` (the whole name, or the namespace of a qualified one) to
 * the contract package's declaration of a marker. Aliases, re-exports and
 * namespace imports are followed through the checker's symbol graph:
 * `import type { Immutable as RO } from "@scriptc/types"`,
 * `export type { Immutable } from "@scriptc/types"` in a local module, and
 * `export * from "@scriptc/types"` all reach the same declaration. */
function markerNamed(
  checker: ts.TypeChecker,
  ident: ts.Identifier,
  qualified: boolean,
  member?: string,
): MarkerResolution | null {
  const symbol = symbolAt(checker, ident);
  if (symbol === undefined) return null;
  const seen = new Set<ts.Symbol>();
  let current: ts.Symbol | undefined = symbol;
  for (let step = 0; current !== undefined && step < 8; step++) {
    if (seen.has(current)) break;
    seen.add(current);
    const decl = current.declarations?.[0];
    if (decl === undefined) break;
    if (ts.isSourceFile(decl) || ts.isModuleDeclaration(decl)) {
      // A module (or a namespace import of one): the marker is the export
      // `member` names, whether the module is the package or re-exports it.
      const name = qualified ? member : undefined;
      if (name === undefined) return null;
      const exported: ts.Symbol | undefined = checker
        .getExportsOfModule(current)
        .find((s) => ts.symbolName(s) === name);
      if (exported === undefined) return null;
      current = exported;
      continue;
    }
    const module = contractModuleOfFile(decl.getSourceFile().fileName);
    if (module !== null) {
      // An export alias (`export type { Immutable as Frozen }`) names the
      // declaration it aliases; follow it so the marker is read from the
      // declaration, not from the spelling the annotation used.
      if (current.flags & ts.SymbolFlags.Alias) {
        current = aliasOf(checker, current);
        continue;
      }
      const name = ts.symbolName(current);
      if (!MARKERS.has(name) || markerModule(name) !== module) return null;
      return { kind: "marker", marker: name as ContractMarker };
    }
    // A local or library declaration: only another alias keeps the chain
    // going, and only the package's declaration ends it.
    current = current.flags & ts.SymbolFlags.Alias ? aliasOf(checker, current) : undefined;
  }
  // The name is imported from the contract module — or from a module that
  // does not resolve at all, so the chain cannot reach the package — but
  // following the alias stopped short: report it rather than treating the
  // annotation as ordinary.
  const decl = symbol.declarations?.[0] ?? ident;
  const imported = importedFrom(decl);
  const resolves = importResolves(checker, decl);
  if (
    imported !== null &&
    MARKERS.has(imported.member) &&
    (imported.module === markerModule(imported.member) || !resolves)
  )
    return { kind: "unresolved", name: imported.member, module: imported.module };
  // A namespace import names its member where the annotation is written
  // (`S.Immutable<T>`), not at an import specifier.
  if (qualified && member !== undefined && MARKERS.has(member)) {
    const module = namespaceImportModule(decl);
    if (module === markerModule(member) || !resolves)
      return { kind: "unresolved", name: member, ...(module === null ? {} : { module }) };
  }
  return null;
}

/** The module a namespace import binding names (`import type * as S from
 * "..."`), or null when the declaration is not one. */
function namespaceImportModule(decl: ts.Node): string | null {
  if (!ts.isNamespaceImport(decl)) return null;
  const clause = decl.parent;
  if (clause === undefined || !ts.isImportClause(clause)) return null;
  const statement = clause.parent;
  if (statement === undefined || !ts.isImportDeclaration(statement)) return null;
  const moduleSpecifier = statement.moduleSpecifier;
  if (moduleSpecifier === undefined || !ts.isStringLiteral(moduleSpecifier)) return null;
  return moduleSpecifier.text;
}

function aliasOf(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | undefined {
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return undefined;
  }
}

/** Files whose written annotations can name a contract marker: those that
 * import the contract modules, and those that import or re-export from a
 * module that does. Every specifier the program resolved is followed —
 * relative paths, tsconfig `paths` and `baseUrl` aliases, package imports
 * and package exports — not only relative ones, because an alias carries the
 * marker just as a relative path does. A specifier that does not resolve to
 * a program module is walked too: the module may re-export the markers from
 * a declaration file, and a marker whose import cannot be followed is
 * reported rather than skipped. */
function contractFiles(
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
): Set<ts.SourceFile> {
  const byPath = new Map<string, ts.SourceFile>();
  for (const sf of files) byPath.set(resolve(sf.fileName), sf);
  const importers = new Map<ts.SourceFile, ts.SourceFile[]>();
  const found = new Set<ts.SourceFile>();
  const queue: ts.SourceFile[] = [];
  const add = (sf: ts.SourceFile): void => {
    if (found.has(sf)) return;
    found.add(sf);
    queue.push(sf);
  };
  for (const sf of files) {
    if (sf.isDeclarationFile) continue;
    for (const statement of sf.statements.nodes) {
      const specifier = moduleSpecifierOf(statement);
      if (specifier === null) continue;
      if (specifier === CONTRACT_TYPES_MODULE || specifier === INLINE_ARRAY_MODULE) {
        add(sf);
        continue;
      }
      const target = resolvedModuleFile(checker, sf, statement, specifier, byPath);
      if (target === undefined) add(sf);
      else importers.set(target, [...(importers.get(target) ?? []), sf]);
    }
  }
  while (queue.length > 0) {
    const target = queue.pop()!;
    for (const importer of importers.get(target) ?? []) add(importer);
  }
  return found;
}

/** The program file a module specifier names. The checker's module symbol is
 * the program's own answer, so it covers tsconfig `paths` and `baseUrl`,
 * package imports, package self-references and package exports alike; the
 * shared resolver answers a specifier the checker has no module symbol for.
 * Undefined when the specifier names no file among `files`: a declaration
 * module the program never lowers, or a specifier that does not resolve. */
function resolvedModuleFile(
  checker: ts.TypeChecker,
  from: ts.SourceFile,
  statement: ts.Node,
  specifier: string,
  byPath: ReadonlyMap<string, ts.SourceFile>,
): ts.SourceFile | undefined {
  const moduleSpecifier =
    ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
      ? statement.moduleSpecifier
      : undefined;
  const symbol = moduleSpecifier !== undefined ? symbolAt(checker, moduleSpecifier) : undefined;
  for (const decl of symbol?.declarations ?? []) {
    if (!ts.isSourceFile(decl)) continue;
    const target = byPath.get(resolve(decl.fileName));
    if (target !== undefined) return target;
  }
  const answer = resolveProjectModule(from.fileName, specifier);
  return answer === null ? undefined : byPath.get(resolve(answer));
}

/** The import or export declaration a named binding belongs to, or null when
 * the declaration is neither. */
function importStatementOf(decl: ts.Node): ts.Node | null {
  if (!ts.isImportSpecifier(decl) && !ts.isExportSpecifier(decl)) return null;
  const holder = decl.parent?.parent;
  const statement = holder !== undefined && ts.isImportClause(holder) ? holder.parent : holder;
  return statement !== undefined &&
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
    ? statement
    : null;
}

/** The declaration a namespace import binds (`import type * as S from "..."`),
 * or null when the declaration is not one. */
function namespaceImportStatement(decl: ts.Node): ts.Node | null {
  const clause = decl.parent;
  if (clause === undefined || !ts.isImportClause(clause)) return null;
  const statement = clause.parent;
  return statement !== undefined && ts.isImportDeclaration(statement) ? statement : null;
}

/** Whether the module a binding is imported from resolves: the checker knows
 * its module symbol, or the shared resolver names a file for it. */
function importResolves(checker: ts.TypeChecker, decl: ts.Node): boolean {
  const statement =
    importStatementOf(decl) ?? (ts.isNamespaceImport(decl) ? namespaceImportStatement(decl) : null);
  if (statement === null) return true;
  const moduleSpecifier = (statement as ts.ImportDeclaration).moduleSpecifier;
  if (moduleSpecifier === undefined || !ts.isStringLiteral(moduleSpecifier)) return true;
  if (symbolAt(checker, moduleSpecifier) !== undefined) return true;
  const from = decl.getSourceFile().fileName;
  return resolveProjectModule(from, moduleSpecifier.text) !== null;
}

function moduleSpecifierOf(statement: ts.Node): string | null {
  if (
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
  )
    return statement.moduleSpecifier.text;
  return null;
}

function nameText(node: ts.Node | undefined): string {
  if (node === undefined) return "<anonymous>";
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  return ts.getTextOfNode(node);
}

function contractDiag(
  code: DiagnosticCode,
  loc: SrcLoc,
  message: string,
  hint: string,
): ScrDiagnostic {
  return { code, loc, message, hint };
}

/** Collect every contract annotation in the program's own TypeScript
 * modules. A file is walked when it can name a marker, directly or through
 * a re-export. */
export function collectContractAnnotations(
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  resolveUnit: ContractUnitResolver = () => null,
): ContractAnnotations {
  const out: ContractAnnotations = {
    functions: new Map(),
    bindings: new Map(),
    fields: new Map(),
    acyclic: [],
    classes: new Map(),
    inlineArrays: new Map(),
    diagnostics: [],
    count: 0,
  };
  const kinds = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.TypeReference,
    ts.SyntaxKind.ExpressionWithTypeArguments,
  ]);
  const interesting = contractFiles(checker, files);
  for (const sf of files) {
    if (!interesting.has(sf)) continue;
    ts.walkPreorder(
      sf,
      (node) => {
        const heritage = isHeritageElement(node);
        const resolution = heritage
          ? markerOfHeritage(checker, node)
          : ts.isTypeReferenceNode(node)
            ? markerOf(checker, node)
            : null;
        if (resolution === null) return;
        if (resolution.kind === "unresolved") {
          out.diagnostics.push(unresolvedMarker(node, resolution.name, resolution.module));
          return;
        }
        const marker = resolution.marker;
        out.count++;
        if (heritage) {
          placeHeritage(out, checker, node as HeritageElement, marker, resolveUnit);
          return;
        }
        if (!ts.isTypeReferenceNode(node)) return;
        if (marker === "Acyclic") placeAcyclicAlias(out, checker, node, resolveUnit);
        else if (marker === "ProgramLifetime") unsupported(out, node, marker);
        else if (marker === INLINE_ARRAY_MARKER) placeInlineArray(out, node);
        else place(out, checker, node, marker);
      },
      kinds,
    );
  }
  return out;
}

/** A marker the compiler could not trace back to the package: the contract
 * cannot be checked, so say so instead of compiling as if it were never
 * written. */
function unresolvedMarker(node: ts.Node, name: string, module?: string): ScrDiagnostic {
  return contractDiag(
    "SC7006",
    locOf(node),
    `the ${name} contract here cannot be checked: '${name}' is imported from ${module ?? markerModule(name)} but the import does not resolve to the package's declaration`,
    "import the marker directly from @scriptc/types, or through a module that re-exports it and resolves",
  );
}

function unsupported(out: ContractAnnotations, node: ts.Node, marker: ContractMarker): void {
  if (marker === "Acyclic") {
    out.diagnostics.push(
      contractDiag(
        "SC7006",
        locOf(node),
        "the Acyclic contract is not checked in this position (Acyclic is checked on classes, interfaces and object type aliases)",
        "write `class C implements Acyclic` or `interface I extends Acyclic` (without a type argument), or `type T = Acyclic<{ ... }>`",
      ),
    );
    return;
  }
  if (marker === INLINE_ARRAY_MARKER) {
    out.diagnostics.push(
      contractDiag(
        "SC7006",
        locOf(node),
        "the InlineArray contract is not checked in this position (InlineArray is checked on instance fields of ProgramLifetime classes)",
        "write it directly as the type of an instance field: readonly f: InlineArray<C>",
      ),
    );
    return;
  }
  const where =
    marker === "NoThrow"
      ? "NoThrow wraps a function's written return type"
      : marker === "Int32"
        ? "Int32 and Int32[] are checked on parameters, variables, class instance fields and function results"
        : marker === "ProgramLifetime"
          ? "ProgramLifetime is checked in the implements clause of a class declaration"
          : "Immutable is checked on parameters, variables, class instance fields and function results";
  out.diagnostics.push(
    contractDiag(
      "SC7006",
      locOf(node),
      `the ${marker} contract is not checked in this position (${where})`,
      marker === "NoThrow"
        ? "write it as the function's return type annotation: function f(): NoThrow<T>"
        : marker === "ProgramLifetime"
          ? "declare it on the class itself: class Node implements ProgramLifetime { ... }"
          : marker === "Int32"
            ? "write Int32 or Int32[] directly as the annotation of the declaration; type aliases, interface members and types nested in other types (unions, nested arrays, other type arguments) are not followed"
            : `write ${marker} directly as the annotation of the declaration; type aliases, interface members and types nested in other types (arrays, unions, type arguments) are not followed`,
    ),
  );
}

/** The heritage positions of the class markers: `class C implements
 * Acyclic`, `interface I extends Acyclic` and `class C implements
 * ProgramLifetime` (a class declaration only). */
function placeHeritage(
  out: ContractAnnotations,
  checker: ts.TypeChecker,
  node: HeritageElement,
  marker: ContractMarker,
  resolveUnit: ContractUnitResolver,
): void {
  const clause = node.parent;
  const owner = clause?.parent;
  if (marker === "ProgramLifetime") {
    if (
      clause === undefined ||
      !ts.isHeritageClause(clause) ||
      clause.token !== ts.SyntaxKind.ImplementsKeyword ||
      owner === undefined ||
      !ts.isClassDeclaration(owner)
    )
      return unsupported(out, node, marker);
    out.classes.set(contractLocKey(locOf(owner)), {
      marker,
      loc: locOf(node),
      name: nameText(owner.name),
    });
    return;
  }
  if (
    marker !== "Acyclic" ||
    clause === undefined ||
    !ts.isHeritageClause(clause) ||
    owner === undefined
  )
    return unsupported(out, node, marker);
  // `implements Acyclic<C>` would make the class implement C's own type,
  // which the lowering treats as a protocol of C.
  if ((node.typeArguments?.nodes.length ?? 0) > 0) return unsupported(out, node, marker);
  const note = (name: string): ContractNote => ({ marker, loc: locOf(node), name });
  if (
    (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) &&
    clause.token === ts.SyntaxKind.ImplementsKeyword
  ) {
    out.acyclic.push({ note: note(nameText(owner.name)), classKey: contractLocKey(locOf(owner)) });
    return;
  }
  if (ts.isInterfaceDeclaration(owner) && clause.token === ts.SyntaxKind.ExtendsKeyword) {
    const symbol = checker.getSymbolAtLocation(owner.name);
    const unit = symbol ? resolveUnit(checker.getDeclaredTypeOfSymbol(symbol)) : null;
    out.acyclic.push({ note: note(owner.name.text), unit });
    return;
  }
  unsupported(out, node, marker);
}

/** `readonly f: InlineArray<C>`: an instance field of a class. */
function placeInlineArray(out: ContractAnnotations, ref: ts.TypeReferenceNode): void {
  const parent = ref.parent;
  if (
    parent === undefined ||
    !ts.isPropertyDeclaration(parent) ||
    parent.type !== ref ||
    ref.typeArguments?.nodes.length !== 1 ||
    ts.getModifiers(parent)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true ||
    !(ts.isIdentifier(parent.name) || ts.isPrivateIdentifier(parent.name))
  )
    return unsupported(out, ref, INLINE_ARRAY_MARKER);
  const cls = parent.parent;
  if (cls === undefined || !(ts.isClassDeclaration(cls) || ts.isClassExpression(cls)))
    return unsupported(out, ref, INLINE_ARRAY_MARKER);
  out.inlineArrays.set(`${contractLocKey(locOf(cls))}\0${parent.name.text}`, {
    marker: INLINE_ARRAY_MARKER,
    loc: locOf(ref),
    name: `${nameText(cls.name)}.${parent.name.text}`,
  });
}

/** `type T = Acyclic<{ ... }>`: the aliased object type. */
function placeAcyclicAlias(
  out: ContractAnnotations,
  checker: ts.TypeChecker,
  ref: ts.TypeReferenceNode,
  resolveUnit: ContractUnitResolver,
): void {
  const alias = ref.parent;
  if (alias === undefined || !ts.isTypeAliasDeclaration(alias) || alias.type !== ref)
    return unsupported(out, ref, "Acyclic");
  out.acyclic.push({
    note: { marker: "Acyclic", loc: locOf(ref), name: alias.name.text },
    unit: resolveUnit(checker.getTypeFromTypeNode(ref)),
  });
}

function place(
  out: ContractAnnotations,
  checker: ts.TypeChecker,
  ref: ts.TypeReferenceNode,
  marker: ContractMarker,
): void {
  let node: ts.Node = ref;
  let parent = ref.parent;
  // Int32[] (readonly Int32[], Array<Int32>, ReadonlyArray<Int32>): the
  // contract covers the elements of the annotated array.
  let elements = false;
  if (marker === "Int32" && parent !== undefined) {
    if (ts.isArrayTypeNode(parent) && parent.elementType === ref) {
      node = parent;
      parent = parent.parent;
      elements = true;
      if (
        parent !== undefined &&
        ts.isTypeOperatorNode(parent) &&
        parent.operator === ts.SyntaxKind.ReadonlyKeyword
      ) {
        node = parent;
        parent = parent.parent;
      }
    } else if (
      ts.isTypeReferenceNode(parent) &&
      ts.isIdentifier(parent.typeName) &&
      (parent.typeName.text === "Array" || parent.typeName.text === "ReadonlyArray") &&
      parent.typeArguments?.nodes.length === 1 &&
      parent.typeArguments.nodes[0] === ref
    ) {
      node = parent;
      parent = parent.parent;
      elements = true;
    }
  }
  // NoThrow<Int32> / NoThrow<Immutable<T>>: the inner marker is the result
  // contract of the function the NoThrow annotates.
  if (marker !== "NoThrow" && parent !== undefined && ts.isTypeReferenceNode(parent)) {
    const wrapper = markerTypeOf(checker, parent);
    if (wrapper === "NoThrow" && parent.typeArguments?.nodes[0] === node) {
      node = parent;
      parent = parent.parent;
    }
  }
  const note = (name: string): ContractNote =>
    elements
      ? { marker, loc: locOf(ref), name, elements: true }
      : { marker, loc: locOf(ref), name };
  if (parent === undefined) return unsupported(out, ref, marker);
  if (ts.isFunctionLike(parent) && parent.type === node) {
    if (!ts.isFunctionLikeDeclaration(parent)) return unsupported(out, ref, marker);
    const key = contractLocKey(locOf(parent));
    const list = out.functions.get(key) ?? [];
    list.push(note(ts.isConstructorDeclaration(parent) ? "constructor" : nameText(parent.name)));
    out.functions.set(key, list);
    return;
  }
  if (marker === "NoThrow") return unsupported(out, ref, marker);
  if (
    (ts.isParameter(parent) || ts.isVariableDeclaration(parent)) &&
    parent.type === node &&
    ts.isIdentifier(parent.name)
  ) {
    out.bindings.set(contractLocKey(locOf(parent.name)), note(parent.name.text));
    return;
  }
  if (ts.isPropertyDeclaration(parent) && parent.type === node) {
    const cls = parent.parent;
    const isStatic =
      ts.getModifiers(parent)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true;
    if (
      !isStatic &&
      cls !== undefined &&
      (ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) &&
      (ts.isIdentifier(parent.name) || ts.isPrivateIdentifier(parent.name))
    ) {
      out.fields.set(
        `${contractLocKey(locOf(cls))}\0${parent.name.text}`,
        note(`${nameText(cls.name)}.${parent.name.text}`),
      );
      return;
    }
  }
  unsupported(out, ref, marker);
}
