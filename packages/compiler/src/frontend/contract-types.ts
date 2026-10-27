/* Contract types (@scriptc/types): written annotations scriptc checks as
 * extra contracts. The package is types only (`export type` aliases that
 * TypeScript erases), so Node.js never loads it; scriptc recognizes the
 * aliases by import provenance, like threads-import.ts recognizes the
 * @scriptc/threads exports. TypeScript drops alias identity from inferred
 * types, so only annotations the program WRITES count: parameter, return,
 * variable and class field types, and the class markers (Acyclic,
 * ProgramLifetime) in heritage clauses. The IR-side checks live in
 * ir/contract-check.ts. */
import type { DiagnosticCode } from "../diagnostics/codes.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import { locOf } from "./program.js";
import * as ts from "./ts7/adapter.js";
import { type HeritageElement, isHeritageElement } from "./heritage-elements.js";

export const CONTRACT_TYPES_MODULE = "@scriptc/types";

export type ContractMarker = "Int32" | "NoThrow" | "Immutable" | "Acyclic" | "ProgramLifetime";
const MARKERS: ReadonlySet<string> = new Set([
  "Int32",
  "NoThrow",
  "Immutable",
  "Acyclic",
  "ProgramLifetime",
]);

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
  diagnostics: ScrDiagnostic[];
  /** Number of annotations found (for timing and tests). */
  count: number;
}

export function contractLocKey(loc: SrcLoc): string {
  return `${loc.file}\0${loc.start}\0${loc.end}`;
}

/** The marker a type reference names when its name is a named or namespace
 * import binding of @scriptc/types (`import type { Int32 } from
 * "@scriptc/types"`, `import type * as sc from "@scriptc/types"`). */
function markerOf(checker: ts.TypeChecker, ref: ts.TypeReferenceNode): ContractMarker | null {
  const name = ref.typeName;
  if (ts.isIdentifier(name)) return markerNamed(checker, name, name.text, false);
  if (ts.isQualifiedName(name) && ts.isIdentifier(name.left))
    return markerNamed(checker, name.left, name.right.text, true);
  return null;
}

/** The marker a heritage clause names (`implements Acyclic`,
 * `implements sc.ProgramLifetime`), as an ExpressionWithTypeArguments or,
 * in TypeScript 7.1's interface `extends` and class `implements`, a
 * TypeReference. */
function markerOfHeritage(checker: ts.TypeChecker, node: HeritageElement): ContractMarker | null {
  if (ts.isTypeReferenceNode(node)) return markerOf(checker, node);
  const e = node.expression;
  if (ts.isIdentifier(e)) return markerNamed(checker, e, e.text, false);
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && ts.isIdentifier(e.name))
    return markerNamed(checker, e.expression, e.name.text, true);
  return null;
}

/** Resolve `ident` (the whole name, or the namespace of a qualified one)
 * to an import of @scriptc/types and answer the imported marker. */
function markerNamed(
  checker: ts.TypeChecker,
  ident: ts.Identifier,
  written: string,
  qualified: boolean,
): ContractMarker | null {
  if (!MARKERS.has(written)) return null;
  let member = written;
  const symbol = checker.getSymbolAtLocation(ident);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined) return null;
  let importDecl: ts.Node | undefined;
  if (ts.isImportSpecifier(decl) && !qualified) {
    importDecl = decl.parent?.parent?.parent;
    member = decl.propertyName?.text ?? decl.name.text;
  } else if (ts.isNamespaceImport(decl) && qualified) importDecl = decl.parent?.parent;
  else return null;
  if (
    importDecl === undefined ||
    !ts.isImportDeclaration(importDecl) ||
    !ts.isStringLiteral(importDecl.moduleSpecifier) ||
    importDecl.moduleSpecifier.text !== CONTRACT_TYPES_MODULE
  )
    return null;
  return MARKERS.has(member) ? (member as ContractMarker) : null;
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
 * modules. Files that do not mention the package cannot import a marker
 * (re-exports are not followed), so they are skipped without a walk. */
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
    diagnostics: [],
    count: 0,
  };
  const kinds = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.TypeReference,
    ts.SyntaxKind.ExpressionWithTypeArguments,
  ]);
  for (const sf of files) {
    if (sf.isDeclarationFile || !sf.text.includes(CONTRACT_TYPES_MODULE)) continue;
    ts.walkPreorder(
      sf,
      (node) => {
        if (isHeritageElement(node)) {
          const marker = markerOfHeritage(checker, node);
          if (marker === null) return;
          out.count++;
          placeHeritage(out, checker, node, marker, resolveUnit);
          return;
        }
        if (!ts.isTypeReferenceNode(node)) return;
        const marker = markerOf(checker, node);
        if (marker === null) return;
        out.count++;
        if (marker === "Acyclic") placeAcyclicAlias(out, checker, node, resolveUnit);
        else if (marker === "ProgramLifetime") unsupported(out, node, marker);
        else place(out, checker, node, marker);
      },
      kinds,
    );
  }
  return out;
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
    const wrapper = markerOf(checker, parent);
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
