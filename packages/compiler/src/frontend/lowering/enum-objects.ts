/* The enum OBJECT (`Object.values(E)`, `take(E)`, `const e = E`).
 *
 * tsc's emit declares `var E` and fills an ordinary object where the
 * declaration stands (enum-object-layout.ts). Member reads never need that
 * object: they fold to constants (lower-enums.ts), which is all most
 * programs do, so the object is built only for an enum some code uses as a
 * value. Such an enum gets two module globals: the object, a record of the
 * closed shape the type mapper gives `typeof E`, built by the statement of
 * the enum's last declaration, and a flag that statement sets. Being a
 * record, the object enumerates, copies, converts to a checked-dynamic
 * value and crosses into a Node island like any object literal's value.
 *
 * `var E` holds undefined until its declaration runs. The record type has
 * no undefined, so a read that can run earlier (inside a function, in
 * another module, between the declarations of a merged enum) tests the
 * flag and throws a named refusal instead of answering an object Node
 * does not have yet.
 *
 * The use analysis runs before the globals are collected. A use is an
 * identifier that resolves to the enum in a value position, other than as
 * the receiver of a member read the access hook folds. It looks where the
 * enum's name is spelled: the declaring file, and for an enum other files
 * can see, every file spelling the name or a name an import or export
 * specifier renames it to. A reference it does not reach (a default import
 * of `export { E as default }` is counted as a use for that reason) keeps
 * the named refusal, as does the object of every enum without a layout. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { FileParts } from "./lower-modules.js";
import { identifiersNamed } from "./identifier-uses.js";
import { nsPathPrefix } from "./lower-namespaces.js";
import { locOf } from "../program.js";
import {
  enumDeclarationsOf,
  enumObjectLayout,
  type EnumObjectEntry,
} from "../enum-object-layout.js";
import { BOOL, F64, STRING, type IrExpr, type IrGlobal, type IrStmt } from "../../ir/ir.js";
import { nodeThrowExpr } from "../../ir/build.js";

/** An enum whose object the program uses. */
export interface EnumObject {
  name: string;
  entries: EnumObjectEntry[];
  /** The declaration that registers the globals, and the one whose
   * statement builds the object: the first and the last. */
  first: ts.EnumDeclaration;
  last: ts.EnumDeclaration;
  /** Set by collectGlobals. */
  object?: IrGlobal;
  ready?: IrGlobal;
}

function memberNamesOf(decls: readonly ts.EnumDeclaration[]): Set<string> {
  const names = new Set<string>();
  for (const decl of decls)
    for (const member of decl.members.nodes) {
      const n = member.name;
      if (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) names.add(n.text);
    }
  return names;
}

/** Finds the enums whose object some code uses and records them for
 * collectGlobals, the declaration statement and the identifier lowering.
 * Enums declared inside a function are not candidates: each call creates
 * its own object, which a module global cannot hold. */
export function collectEnumObjects(lowerer: Lowerer, parts: readonly FileParts[]): void {
  const checker = lowerer.checker;
  const declared = new Map<ts.Symbol, ts.EnumDeclaration[]>();
  for (const fp of parts) {
    for (const stmt of fp.topStmts) {
      if (!ts.isEnumDeclaration(stmt)) continue;
      // A const or ambient enum never has an object.
      if (
        stmt.modifiers?.nodes.some(
          (m) => m.kind === ts.SyntaxKind.ConstKeyword || m.kind === ts.SyntaxKind.DeclareKeyword,
        )
      )
        continue;
      const symbol = checker.getSymbolAtLocation(stmt.name);
      if (!symbol) continue;
      const list = declared.get(symbol);
      if (list) list.push(stmt);
      else declared.set(symbol, [stmt]);
    }
  }
  if (declared.size === 0) return;
  const files = parts.map((fp) => fp.sf);
  for (const [symbol, decls] of declared) {
    if (lowerer.enumObjects.has(symbol)) continue;
    const layout = enumObjectLayout(checker, symbol);
    if (layout.entries === undefined) continue;
    // Every declaration merges into the one object: all of them must be
    // statements of one file's init body.
    const all = enumDeclarationsOf(symbol);
    const home = ts.getSourceFileOfNode(decls[0]!);
    if (all.length !== decls.length || all.some((d) => ts.getSourceFileOfNode(d) !== home))
      continue;
    if (!enumObjectUsed(lowerer, symbol, decls, home, files)) continue;
    const info: EnumObject = {
      name: ts.symbolName(symbol),
      entries: layout.entries,
      first: decls[0]!,
      last: decls[decls.length - 1]!,
    };
    lowerer.enumObjects.set(symbol, info);
    lowerer.enumObjectDecls.set(info.first, info);
    lowerer.enumObjectDecls.set(info.last, info);
  }
}

/** Whether a file other than the declaring one can name the enum: it is
 * exported, a member of a namespace, or a global of a script file. An
 * export specifier found by the scan turns this on as well. */
function visibleOutside(decls: readonly ts.EnumDeclaration[], home: ts.SourceFile): boolean {
  if (!ts.isExternalModule(home)) return true;
  return decls.some(
    (d) =>
      !ts.isSourceFile(d.parent) ||
      (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Export) !== 0,
  );
}

function enumObjectUsed(
  lowerer: Lowerer,
  symbol: ts.Symbol,
  decls: readonly ts.EnumDeclaration[],
  home: ts.SourceFile,
  files: readonly ts.SourceFile[],
): boolean {
  const checker = lowerer.checker;
  const members = memberNamesOf(decls);
  const names = [ts.symbolName(symbol)];
  let everywhere = visibleOutside(decls, home);
  const scanned = new Set<string>();
  const resolves = (id: ts.Identifier): boolean => {
    let s = checker.getSymbolAtLocation(id);
    const parent = id.parent;
    if (parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === id)
      s = checker.getShorthandAssignmentValueSymbol(parent) ?? s;
    if (s !== undefined && (s.flags & ts.SymbolFlags.Alias) !== 0) s = checker.getAliasedSymbol(s);
    return s === symbol;
  };
  for (;;) {
    let progressed = false;
    const where = everywhere ? files : [home];
    for (let n = 0; n < names.length; n++) {
      const name = names[n]!;
      for (let f = 0; f < where.length; f++) {
        const sf = where[f]!;
        const key = `${n}:${sf.fileName}`;
        if (scanned.has(key)) continue;
        scanned.add(key);
        if (sf !== home && !ts.sourceTextIncludes(sf, name)) continue;
        const candidates = identifiersNamed(lowerer, sf, name).filter(
          (id) =>
            !inTypePosition(id) &&
            !(id.parent !== undefined && decls.includes(id.parent as ts.EnumDeclaration)),
        );
        if (candidates.length === 0) continue;
        checker.prefetchSymbolNodesExact(candidates);
        for (const id of candidates) {
          const parent = id.parent;
          if (parent === undefined) continue;
          if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
            const alias = parent.name;
            // A string-named export (`export { E as "e-1" }`) can be
            // imported under any local name, like a default.
            if (!ts.isIdentifier(alias)) return true;
            if (!resolves(alias)) continue;
            if (ts.isExportSpecifier(parent) && !everywhere) {
              everywhere = true;
              progressed = true;
            }
            if (parent.propertyName === undefined) continue;
            // A default import can take any local name.
            if (alias.text === "default") return true;
            if (!names.includes(alias.text)) {
              names.push(alias.text);
              progressed = true;
            }
            continue;
          }
          if (!resolves(id)) continue;
          // `import D = N.E`: uses spell the alias.
          const aliasDecl = importEqualsOf(id);
          if (aliasDecl !== null) {
            if (!names.includes(aliasDecl.name.text)) {
              names.push(aliasDecl.name.text);
              progressed = true;
            }
            continue;
          }
          if (!isFoldedMemberRead(id, members)) return true;
        }
      }
    }
    if (!progressed) return false;
  }
}

/** Inside a type: an annotation, `typeof E` in a type, a type argument. */
function inTypePosition(id: ts.Identifier): boolean {
  for (let p: ts.Node | undefined = id.parent; p !== undefined; p = p.parent) {
    if (ts.isTypeNode(p)) return true;
    if (ts.isStatement(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

/** The `import D = A.B.E` declaration whose entity name ends at `id`. */
function importEqualsOf(id: ts.Identifier): ts.ImportEqualsDeclaration | null {
  let node: ts.Node = id;
  while (node.parent !== undefined && ts.isQualifiedName(node.parent)) {
    if (node.parent.right !== node) return null;
    node = node.parent;
  }
  const parent = node.parent;
  return parent !== undefined &&
    ts.isImportEqualsDeclaration(parent) &&
    parent.moduleReference === node
    ? parent
    : null;
}

/** Whether the reference is the receiver of an access lowerEnumAccess
 * claims: `E.Member`, `E["Member"]`, or `E[key]` with any key that is not a
 * string literal (a reverse or runtime-key read, which never reads the
 * object). `id` may be the name of a qualified reference (`ns.E`). */
function isFoldedMemberRead(id: ts.Identifier, members: ReadonlySet<string>): boolean {
  let ref: ts.Node = id;
  const qualifier = id.parent;
  if (qualifier !== undefined && ts.isPropertyAccessExpression(qualifier) && qualifier.name === id)
    ref = qualifier;
  let inner = ref;
  let up = ref.parent;
  if (up !== undefined && ts.isElementAccessExpression(up) && up.expression === ref) {
    let key = up.argumentExpression;
    while (ts.isParenthesizedExpression(key)) key = key.expression;
    return !ts.isStringLiteralLike(key) || members.has(key.text);
  }
  while (up !== undefined && ts.isParenthesizedExpression(up)) {
    inner = up;
    up = up.parent;
  }
  return (
    up !== undefined &&
    ts.isPropertyAccessExpression(up) &&
    up.expression === inner &&
    ts.isIdentifier(up.name) &&
    members.has(up.name.text)
  );
}

/** collectGlobals' enum arm: the object and its flag, registered where the
 * enum's first declaration stands. */
export function registerEnumObjectGlobals(
  lowerer: Lowerer,
  stmt: ts.EnumDeclaration,
  tag: string,
): void {
  const info = lowerer.enumObjectDecls.get(stmt);
  if (!info || info.first !== stmt || info.object !== undefined) return;
  const symbol = lowerer.checker.getSymbolAtLocation(stmt.name);
  const type = symbol ? lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(symbol)) : null;
  if (type === null || type.kind !== "record") return;
  const id = `%g.${tag}${nsPathPrefix(lowerer, stmt)}%enum.${info.name}`;
  info.object = { id, name: info.name, type, mutable: false };
  info.ready = { id: `${id}%ready`, name: `${info.name}.ready`, type: BOOL, mutable: true };
  lowerer.globalsList.push(info.object, info.ready);
}

/** The statements of the enum's last declaration: build the object, then
 * mark it built. Null for every other declaration. */
export function lowerEnumObjectInit(lowerer: Lowerer, stmt: ts.EnumDeclaration): IrStmt[] | null {
  const info = lowerer.enumObjectDecls.get(stmt);
  if (!info || info.last !== stmt || !info.object || !info.ready) return null;
  const loc = locOf(stmt);
  const type = info.object.type;
  const fields: { name: string; value: IrExpr }[] = info.entries.map((entry) => ({
    name: entry.key,
    value:
      typeof entry.value === "number"
        ? { kind: "numLit", value: entry.value, type: F64, loc }
        : { kind: "strLit", value: entry.value, type: STRING, loc },
  }));
  // Members a type assertion attached to the shape start absent.
  if (type.kind === "record") {
    const provided = new Set(fields.map((f) => f.name));
    for (const field of lowerer.shapes.get(type.shapeId)?.fields ?? []) {
      if (provided.has(field.name)) continue;
      const absent = lowerer.absentFieldValue(field, loc);
      if (absent) fields.push({ name: field.name, value: absent });
    }
  }
  const object = lowerer.keyOrder.literal(
    { kind: "recordLit", fields, type, loc },
    info.entries.map((entry) => ({ kind: "key" as const, name: entry.key, definite: true })),
  );
  return [
    { kind: "assign", localId: info.object.id, value: object, loc },
    {
      kind: "assign",
      localId: info.ready.id,
      value: { kind: "boolLit", value: true, type: BOOL, loc },
      loc,
    },
  ];
}

/** Whether `node` runs as part of its file's init body rather than inside
 * a function or class member that can run at another time. */
function runsWithInit(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if (ts.isSourceFile(p)) return true;
    if (ts.isFunctionLike(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) return false;
  }
  return true;
}

/** Why an enum has no object here, as a clause: its layout's reason, or
 * that a function declares it, or that the use analysis found no use. */
export function enumObjectRefusal(lowerer: Lowerer, sym: ts.Symbol): string {
  const decl = enumDeclarationsOf(sym)[0];
  return (
    enumObjectLayout(lowerer.checker, sym).refusal ??
    (decl !== undefined && !runsWithInit(decl)
      ? "an enum declared inside a function creates its object on each call"
      : "no reference the use analysis reaches takes the object; import the enum by name")
  );
}

/** The identifier chokepoint's enum arm: the enum object as a value.
 * Returns null when the symbol is not an enum; refuses by name an enum
 * that has no object here. */
export function lowerEnumObjectValue(
  lowerer: Lowerer,
  expr: ts.Identifier,
  sym: ts.Symbol,
): IrExpr | null {
  if (!(sym.flags & ts.SymbolFlags.Enum)) return null;
  const info = lowerer.enumObjects.get(sym);
  if (!info || !info.object || !info.ready) {
    const why = enumObjectRefusal(lowerer, sym);
    lowerer.unsupported(
      "SC1090",
      expr,
      `enum objects as values ('${expr.text}': ${why}; member reads like '${expr.text}.A' compile to constants)`,
    );
  }
  const loc = locOf(expr);
  const object: IrExpr = { kind: "varRef", localId: info.object.id, type: info.object.type, loc };
  // Init-body code of the declaring file runs in source order: after the
  // last declaration the object exists, and between the declarations of a
  // merged enum it does not hold every member yet.
  if (ts.getSourceFileOfNode(expr) === ts.getSourceFileOfNode(info.last) && runsWithInit(expr)) {
    if (expr.pos >= info.last.end) return object;
    if (info.first !== info.last && expr.pos >= info.first.end) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `enum objects as values ('${info.name}': between the declarations of a merged enum the object holds only the members declared so far)`,
      );
    }
  }
  return {
    kind: "ternary",
    cond: { kind: "varRef", localId: info.ready.id, type: BOOL, loc },
    then: object,
    else_: nodeThrowExpr(
      0,
      "SC1090",
      `reading the object of the enum '${info.name}' before its declaration has run is not supported yet`,
      info.object.type,
      loc,
    ),
    type: info.object.type,
    loc,
  };
}
