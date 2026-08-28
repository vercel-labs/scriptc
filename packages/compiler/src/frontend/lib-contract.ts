/* Library mode's contract-sidecar input: the entry module's exported
 * function signatures and exported-const contract conventions, plus the
 * exported type declarations of the WHOLE module graph (entry first, the
 * other modules in canonical path order — never import order, so moving
 * an import statement can never perturb a sidecar table) — all read from
 * the SYNTAX TREE in statement order. Declaration order is the ratified
 * contract (the sidecar's field, member, and arm orders are wire
 * semantics), and the checker's property enumeration hands back
 * internal/sorted order, so the AST is the only trustworthy order source;
 * this module never touches the checker.
 *
 * Order must be derivable from ONE declaration site (ask 3's
 * define-or-refuse rule), so this module also records every type name
 * whose members gather from multiple sites — a second same-name interface
 * block (declaration merging), a module augmentation's contribution, or a
 * same-name exported declaration in another module (the type table has
 * one namespace) — for the emitter to refuse when such a name is tabled.
 *
 * The projection into the sidecar schema's closed vocabulary happens in
 * library/sidecar.ts; this module only captures syntactic shapes. The
 * exported-const conventions this module reads (the ratified ask-2
 * drafting item — under an embedder's profile a generated facade declares
 * these; authors declare nothing):
 *
 *   export const modelUnbound  = ["fieldOrHelper", ...] as const;
 *   export const msgUnbound    = ["arm", ...] as const;
 *   export const appearanceMsg = "arm";
 *   export const chromeMsg     = "arm";
 *   export const envMsgs       = [{ env: "NAME", msg: "arm" }, ...] as const;
 */
import * as ts from "./ts7/adapter.js";
import type { SrcLoc } from "../ir/ir.js";

/** A syntactic type shape — exactly what the source spells, no checker. */
export type ContractTypeShape =
  | { k: "bool" }
  | { k: "number" }
  | { k: "text" }
  | { k: "bytes" }
  | { k: "void" }
  | { k: "absent"; unit: "null" | "undefined" }
  | { k: "ref"; name: string }
  | { k: "array"; elem: ContractTypeShape }
  | { k: "tuple"; elems: ContractTypeShape[] }
  | { k: "object"; fields: ContractField[] }
  | { k: "stringLit"; text: string }
  | { k: "union"; parts: ContractTypeShape[] }
  /** `computed` marks type-level computation (conditional/mapped types):
   * the members such a type produces have no author-visible declaration
   * order, so a tabled/designated one refuses with its own teaching. */
  | { k: "unsupported"; text: string; computed?: "conditional" | "mapped" };

export interface ContractField {
  name: string;
  optional: boolean;
  shape: ContractTypeShape;
  loc: SrcLoc;
}

export interface ContractTypeDecl {
  name: string;
  /** `interface` projects to a by-reference record; a type-alias object
   * literal to a by-value record; alias unions classify downstream. */
  form: "interface" | "alias";
  shape: ContractTypeShape;
  loc: SrcLoc;
}

export interface ContractFnDecl {
  name: string;
  params: { name: string; shape: ContractTypeShape | null }[];
  returns: ContractTypeShape | null;
  generic: boolean;
  loc: SrcLoc;
}

/** One recognized exported-const convention value; `malformed` carries the
 * reason when the initializer does not fit the convention's shape. */
export interface ContractConst<T> {
  value: T;
  loc: SrcLoc;
}

export interface ContractFacts {
  /** Exported interface/type-alias declarations: the entry module's in
   * statement order, then the other modules' (canonical path order, each
   * module's in statement order). One entry per name — a later same-name
   * exported declaration lands in `multiSiteTypes` instead. */
  types: ContractTypeDecl[];
  /** Type names whose members gather from more than one declaration site
   * (see the module comment). `sites` are `file:line`, in scan order
   * (entry first, then path-ordered modules) — the emitter's refusal
   * names every site. */
  multiSiteTypes: { name: string; sites: string[] }[];
  /** Exported function declarations, statement order. */
  functions: ContractFnDecl[];
  modelUnbound: ContractConst<string[]> | null;
  msgUnbound: ContractConst<string[]> | null;
  appearanceMsg: ContractConst<string> | null;
  chromeMsg: ContractConst<string> | null;
  envMsgs: ContractConst<{ env: string; msg: string }[]> | null;
  /** Convention-named consts whose initializers do not fit the expected
   * shape — refusals, never guesses. */
  malformedConsts: { name: string; detail: string; loc: SrcLoc }[];
}

const CONVENTION_CONSTS = new Set(["modelUnbound", "msgUnbound", "appearanceMsg", "chromeMsg", "envMsgs"]);
const CONTRACT_GLOBAL_TYPES = new Set(["Array", "ReadonlyArray", "Uint8Array"]);
const moduleTypeBindings = new WeakMap<ts.SourceFile, Set<string>>();

function locOf(file: ts.SourceFile, node: ts.Node): SrcLoc {
  return { file: file.fileName, start: node.getStart(), end: node.end };
}

function isExported(stmt: ts.Node): boolean {
  const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function propName(name: ts.Node): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

/** Module-local type bindings which hide same-spelled globals. The contract
 * reader deliberately has no checker, but blindly recognizing `Array`,
 * `ReadonlyArray`, or `Uint8Array` by text can publish a slice/bytes contract
 * for a user-declared record. Imports and declarations are module-scoped
 * regardless of statement order, so one syntax-tree pass is sufficient. */
function localTypeBindings(file: ts.SourceFile): Set<string> {
  const cached = moduleTypeBindings.get(file);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  const add = (name: ts.Identifier | undefined): void => {
    if (name !== undefined && CONTRACT_GLOBAL_TYPES.has(name.text)) names.add(name.text);
  };
  for (const stmt of file.statements) {
    if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      add(stmt.name);
      continue;
    }
    if (ts.isImportEqualsDeclaration(stmt)) {
      add(stmt.name);
      continue;
    }
    if (!ts.isImportDeclaration(stmt) || stmt.importClause === undefined) continue;
    const clause = stmt.importClause;
    add(clause.name);
    if (clause.namedBindings === undefined) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) add(clause.namedBindings.name);
    else for (const el of clause.namedBindings.elements) add(el.name);
  }
  moduleTypeBindings.set(file, names);
  return names;
}

/** Whether a bare type name reaches the ambient global rather than a local
 * declaration/import or a type parameter in an enclosing declaration. */
function isUnshadowedGlobalType(file: ts.SourceFile, node: ts.TypeNode, name: string): boolean {
  if (localTypeBindings(file).has(name)) return false;
  for (let scope = node.parent; scope !== undefined && scope !== file; scope = scope.parent) {
    const params = (scope as ts.Node & { typeParameters?: readonly ts.TypeParameterDeclaration[] }).typeParameters;
    if (params?.some((p) => p.name.text === name) === true) return false;
  }
  return true;
}

function shapeOfMembers(file: ts.SourceFile, members: readonly ts.Node[], onBad: (text: string) => void): ContractField[] {
  const fields: ContractField[] = [];
  for (const m of members) {
    if (!ts.isPropertySignature(m)) {
      onBad("a non-property member (methods/index signatures have no contract projection)");
      continue;
    }
    const name = propName(m.name);
    if (name === null) {
      onBad("a computed property name");
      continue;
    }
    const shape = m.type !== undefined ? typeShape(file, m.type) : ({ k: "unsupported", text: "missing type annotation" } as const);
    fields.push({ name, optional: m.postfixToken?.kind === ts.SyntaxKind.QuestionToken, shape, loc: locOf(file, m) });
  }
  return fields;
}

/** The syntactic shape of a type node, over the closed vocabulary the
 * sidecar schema can express. Anything else lands as `unsupported` with
 * the source text preserved for the refusal message. */
function typeShape(file: ts.SourceFile, node: ts.TypeNode): ContractTypeShape {
  switch (node.kind) {
    case ts.SyntaxKind.BooleanKeyword:
      return { k: "bool" };
    case ts.SyntaxKind.NumberKeyword:
      return { k: "number" };
    case ts.SyntaxKind.StringKeyword:
      return { k: "text" };
    case ts.SyntaxKind.VoidKeyword:
      return { k: "void" };
    case ts.SyntaxKind.UndefinedKeyword:
      return { k: "absent", unit: "undefined" };
    default:
      break;
  }
  if (ts.isParenthesizedTypeNode(node)) return typeShape(file, node.type);
  // `readonly T[]` is the same contract shape as `T[]`: readonly is a
  // checker-only view, and format 1 has one mutability-neutral slice
  // spelling. Preserve the wrapped shape so readonly tuples still reach
  // the projector's explicit tuple refusal.
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return typeShape(file, node.type);
  }
  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal;
    if (ts.isStringLiteral(lit)) return { k: "stringLit", text: lit.text };
    if (lit.kind === ts.SyntaxKind.NullKeyword) return { k: "absent", unit: "null" };
    return { k: "unsupported", text: node.getText(file) };
  }
  if (ts.isArrayTypeNode(node)) return { k: "array", elem: typeShape(file, node.elementType) };
  if (ts.isTupleTypeNode(node)) {
    const elems: ContractTypeShape[] = [];
    for (const e of node.elements) {
      // Named tuple members carry the type under `.type`.
      const t = ts.isNamedTupleMember(e) ? e.type : (e as ts.TypeNode);
      elems.push(typeShape(file, t));
    }
    return { k: "tuple", elems };
  }
  if (ts.isUnionTypeNode(node)) {
    return { k: "union", parts: node.types.map((t) => typeShape(file, t)) };
  }
  if (ts.isTypeLiteralNode(node)) {
    let bad: string | null = null;
    const fields = shapeOfMembers(file, node.members, (text) => {
      bad = text;
    });
    if (bad !== null) return { k: "unsupported", text: bad };
    return { k: "object", fields };
  }
  if (ts.isConditionalTypeNode(node)) {
    return { k: "unsupported", text: `a conditional type (${node.getText(file)})`, computed: "conditional" };
  }
  if (ts.isMappedTypeNode(node)) {
    return { k: "unsupported", text: `a mapped type (${node.getText(file)})`, computed: "mapped" };
  }
  if (ts.isTypeReferenceNode(node)) {
    if (!ts.isIdentifier(node.typeName)) return { k: "unsupported", text: node.getText(file) };
    const name = node.typeName.text;
    const global = CONTRACT_GLOBAL_TYPES.has(name) && isUnshadowedGlobalType(file, node, name);
    if (global && name === "Uint8Array" && (node.typeArguments?.length ?? 0) === 0) return { k: "bytes" };
    if (global && (name === "Array" || name === "ReadonlyArray") && node.typeArguments?.length === 1) {
      return { k: "array", elem: typeShape(file, node.typeArguments[0]!) };
    }
    if ((node.typeArguments?.length ?? 0) > 0) return { k: "unsupported", text: node.getText(file) };
    return { k: "ref", name };
  }
  return { k: "unsupported", text: node.getText(file) };
}

/** Unwrap `expr as const` / parenthesized initializers. */
function unwrapConst(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
      e = e.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(e)) {
      e = e.expression;
      continue;
    }
    return e;
  }
}

function stringArray(expr: ts.Expression): string[] | null {
  const e = unwrapConst(expr);
  if (!ts.isArrayLiteralExpression(e)) return null;
  const out: string[] = [];
  for (const el of e.elements) {
    const v = unwrapConst(el as ts.Expression);
    if (!ts.isStringLiteral(v)) return null;
    out.push(v.text);
  }
  return out;
}

function envMsgArray(expr: ts.Expression): { env: string; msg: string }[] | null {
  const e = unwrapConst(expr);
  if (!ts.isArrayLiteralExpression(e)) return null;
  const out: { env: string; msg: string }[] = [];
  for (const el of e.elements) {
    const v = unwrapConst(el as ts.Expression);
    if (!ts.isObjectLiteralExpression(v)) return null;
    let env: string | null = null;
    let msg: string | null = null;
    for (const prop of v.properties) {
      if (!ts.isPropertyAssignment(prop)) return null;
      const name = propName(prop.name);
      const val = unwrapConst(prop.initializer);
      if (!ts.isStringLiteral(val)) return null;
      if (name === "env") env = val.text;
      else if (name === "msg") msg = val.text;
      else return null;
    }
    if (env === null || msg === null) return null;
    out.push({ env, msg });
  }
  return out;
}

/** One mergeable declaration site, `file:line` (1-based line). */
function siteOf(file: ts.SourceFile, node: ts.Node): string {
  return `${file.fileName}:${ts.getLineAndCharacterOfPosition(file, node.getStart()).line + 1}`;
}

/** Everything the sidecar projection needs from the program's syntax
 * trees: functions and convention consts from the entry module, type
 * declarations from the whole graph (entry first, other modules in
 * canonical path order), each in statement (declaration) order. Call
 * before the frontend is disposed. */
export function entryContractFacts(entry: ts.SourceFile, modules: readonly ts.SourceFile[] = []): ContractFacts {
  const facts: ContractFacts = {
    types: [],
    multiSiteTypes: [],
    functions: [],
    modelUnbound: null,
    msgUnbound: null,
    appearanceMsg: null,
    chromeMsg: null,
    envMsgs: null,
    malformedConsts: [],
  };

  // name → every mergeable declaration site, in scan order.
  const sites = new Map<string, string[]>();
  const addSite = (name: string, site: string): void => {
    const list = sites.get(name);
    if (list === undefined) sites.set(name, [site]);
    else list.push(site);
  };
  const declared = new Set<string>();

  /** One module's exported type declarations (statement order) plus every
   * extra declaration site the merge refusal needs: a non-exported
   * declaration merging with an exported same-name one in the SAME module,
   * a repeated exported declaration (in this module or a later-scanned
   * one — the type table has one namespace), and the type declarations
   * inside `declare module "…"` augmentation blocks. Augmentations are
   * read syntactically — the specifier is not resolved, so a same-name
   * augmentation of ANY module counts as an extra site; that over-refuses
   * only programs already trafficking in colliding contract type names,
   * and the refusal names every site. */
  const collectTypes = (file: ts.SourceFile): void => {
    const exportedHere = new Set<string>();
    for (const stmt of file.statements) {
      if ((ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) && isExported(stmt)) {
        exportedHere.add(stmt.name.text);
      }
    }
    for (const stmt of file.statements) {
      if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
        const name = stmt.name.text;
        const exported = isExported(stmt);
        // A non-exported declaration matters only when it merges with an
        // exported same-name declaration of its own module; other modules'
        // private types never touch the contract namespace.
        if (!exported && !exportedHere.has(name)) continue;
        addSite(name, siteOf(file, stmt));
        if (!exported || declared.has(name)) continue;
        declared.add(name);
        if (ts.isInterfaceDeclaration(stmt)) {
          let bad: string | null = null;
          const fields = shapeOfMembers(file, stmt.members, (text) => {
            bad = text;
          });
          const generic = (stmt.typeParameters?.length ?? 0) > 0;
          const heritage = (stmt.heritageClauses?.length ?? 0) > 0;
          facts.types.push({
            name,
            form: "interface",
            shape:
              bad !== null
                ? { k: "unsupported", text: bad }
                : generic
                  ? { k: "unsupported", text: "a generic interface" }
                  : heritage
                    ? { k: "unsupported", text: "an interface with heritage clauses" }
                    : { k: "object", fields },
            loc: locOf(file, stmt),
          });
        } else {
          const generic = (stmt.typeParameters?.length ?? 0) > 0;
          facts.types.push({
            name,
            form: "alias",
            shape: generic ? { k: "unsupported", text: "a generic type alias" } : typeShape(file, stmt.type),
            loc: locOf(file, stmt),
          });
        }
        continue;
      }
      if (ts.isModuleDeclaration(stmt) && ts.isStringLiteral(stmt.name) && stmt.body !== undefined && ts.isModuleBlock(stmt.body)) {
        for (const inner of stmt.body.statements) {
          if (ts.isInterfaceDeclaration(inner) || ts.isTypeAliasDeclaration(inner)) {
            addSite(inner.name.text, siteOf(file, inner));
          }
        }
      }
    }
  };

  // The entry's declarations anchor first; the rest of the graph follows
  // in bytewise path order — a DECLARATION-SITE order, so reordering
  // import statements or import bindings can never perturb the table.
  collectTypes(entry);
  const others = modules
    .filter((m) => m.fileName !== entry.fileName)
    .sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  for (const m of others) collectTypes(m);
  for (const [name, list] of sites) {
    if (list.length > 1) facts.multiSiteTypes.push({ name, sites: list });
  }

  for (const stmt of entry.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) {
      if (!isExported(stmt)) continue;
      if (stmt.body === undefined && facts.functions.some((f) => f.name === stmt.name!.text)) continue; // overload signature
      facts.functions.push({
        name: stmt.name.text,
        params: stmt.parameters.map((p) => ({
          name: ts.isIdentifier(p.name) ? p.name.text : "<pattern>",
          shape: p.type !== undefined ? typeShape(entry, p.type) : null,
        })),
        returns: stmt.type !== undefined ? typeShape(entry, stmt.type) : null,
        generic: (stmt.typeParameters?.length ?? 0) > 0,
        loc: locOf(entry, stmt),
      });
      continue;
    }
    if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        if (!CONVENTION_CONSTS.has(name)) continue;
        const loc = locOf(entry, decl);
        if (decl.initializer === undefined) {
          facts.malformedConsts.push({ name, detail: "has no initializer", loc });
          continue;
        }
        if (name === "appearanceMsg" || name === "chromeMsg") {
          const v = unwrapConst(decl.initializer);
          if (!ts.isStringLiteral(v)) {
            facts.malformedConsts.push({ name, detail: "must be a string literal naming a msg arm", loc });
            continue;
          }
          facts[name] = { value: v.text, loc };
          continue;
        }
        if (name === "envMsgs") {
          const v = envMsgArray(decl.initializer);
          if (v === null) {
            facts.malformedConsts.push({
              name,
              detail: 'must be an array of { env: "NAME", msg: "arm" } object literals with string-literal values',
              loc,
            });
            continue;
          }
          facts.envMsgs = { value: v, loc };
          continue;
        }
        const v = stringArray(decl.initializer);
        if (v === null) {
          facts.malformedConsts.push({ name, detail: "must be an array of string literals", loc });
          continue;
        }
        facts[name === "modelUnbound" ? "modelUnbound" : "msgUnbound"] = { value: v, loc };
      }
    }
  }
  return facts;
}
