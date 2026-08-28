/* Enum lowering: TypeScript enums fold to their COMPILE-TIME CONSTANT
 * member values — exactly the numbers/strings tsc's own emit stores on the
 * enum object (and inlines for const enums), so every member read is a
 * literal and no runtime object ever materializes. What lowers:
 *   - `E.A` / `E["A"]` member reads (auto-incremented, explicit, and
 *     const-foldable initializers per tsc's own constant computation —
 *     the checker's getConstantValue is the single source of truth);
 *   - `E[0]` REVERSE-mapping reads with a compile-time-constant index:
 *     numeric enums get reverse entries member-by-member in declaration
 *     order (later duplicates overwrite — JS assignment order), string
 *     members never do, and tsc types the read `string` — an index no
 *     member carries is Node's `undefined`, which that type cannot carry,
 *     so it fences instead of lying;
 *   - the DECLARATION itself, to nothing — constant initializers have no
 *     observable evaluation, and the object's creation is unobservable
 *     unless the object is USED as a value, which fences per use site
 *     (lower-exprs' identifier chokepoint);
 *   - ambient (`declare`) enums, const included: Node's transform emits
 *     nothing for the declaration (and does NOT inline ambient const
 *     members the way tsc's emit would — Node is the oracle, measured),
 *     so nothing defines the OBJECT — member reads compile to the
 *     catchable ReferenceError "<E> is not defined" at the access, the
 *     `declare const __VERSION__` stance exactly.
 * What fences: computed members (their initializers are runtime
 * expressions Node evaluates when the declaration executes), reverse
 * lookups through runtime indices, and the enum object as a value.
 * The TYPE side lives in type-mapper.ts (enum types map to their underlying
 * primitives) — see mapType's EnumLike branch. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { locOf } from "../program.js";
import { F64, IrExpr, STRING } from "../../ir/ir.js";

/** The member's source-name text (identifiers and string-literal names —
 * the only name forms tsc allows on enum members). */
function memberNameText(member: ts.EnumMember): string {
  const n = member.name;
  return ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : n.getText();
}

/** Ambient: a `declare`d declaration, or one living in a .d.ts. */
function isAmbientEnumDecl(decl: ts.EnumDeclaration): boolean {
  return (
    (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Ambient) !== 0 ||
    decl.getSourceFile().isDeclarationFile
  );
}

/** True for receivers whose evaluation is effect-free — a bare identifier
 * or a dotted identifier chain. Folding a member read DROPS the receiver
 * expression, which is only sound when evaluating it could not have been
 * observed. (Any other receiver shape falls through to the ordinary
 * property paths and their fences.) */
function effectFreeReceiver(e: ts.Expression): boolean {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    (ts.isPropertyAccessExpression(cur) && !cur.questionDotToken)
  ) {
    cur = cur.expression;
  }
  return ts.isIdentifier(cur);
}

/** The access-site chokepoint, tried FIRST by both the property- and
 * element-access lowerings: claims enum member reads (fold to the constant)
 * and enum reverse-mapping reads. Null when the access is not enum-shaped
 * at all — the caller's ordinary paths apply. */
export function lowerEnumAccess(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): IrExpr | null {
  if (ts.isPropertyAccessExpression(expr)) {
    const sym = lowerer.checker.getSymbolAtLocation(expr.name);
    if (sym && sym.flags & ts.SymbolFlags.EnumMember) {
      const decl = lowerer.checker.valueDeclarationOf(sym);
      if (decl && ts.isEnumMember(decl) && effectFreeReceiver(expr.expression)) {
        return lowerEnumMemberRead(lowerer, expr, decl);
      }
    }
    return null;
  }
  // Element access: tsgo answers no symbol at the access node itself, so
  // both key forms resolve through the RECEIVER's enum symbol.
  const recv = expr.expression;
  if (!ts.isIdentifier(recv)) return null;
  const recvSym = lowerer.resolveValueSymbol(recv);
  if (!recvSym || !(recvSym.flags & ts.SymbolFlags.Enum)) return null;
  const decls = lowerer.checker.declarationsOf(recvSym).filter((d): d is ts.EnumDeclaration => ts.isEnumDeclaration(d));
  if (decls.length === 0) return null;
  let key = expr.argumentExpression;
  while (ts.isParenthesizedExpression(key)) key = key.expression;
  // `E["A"]` — the FORWARD member read in element clothing: find the named
  // member (merged declarations scan in declaration order).
  if (ts.isStringLiteralLike(key)) {
    for (const d of decls) {
      for (const member of d.members) {
        if (memberNameText(member) === key.text) return lowerEnumMemberRead(lowerer, expr, member);
      }
    }
    // tsc resolved the name (or rejected the program); nothing to claim.
    return null;
  }
  return lowerEnumReverseRead(lowerer, expr, recvSym, decls, key);
}

/** One member read, folded to its constant — or the ambient/computed
 * stories (see the module comment). `expr` is the access carrying the
 * source span; `member` the resolved member declaration. */
function lowerEnumMemberRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  member: ts.EnumMember,
): IrExpr | null {
  const enumDecl = member.parent;
  if (!ts.isEnumDeclaration(enumDecl)) return null;
  const loc = locOf(expr);
  if (isAmbientEnumDecl(enumDecl)) {
    // An ambient enum's OBJECT is never defined — Node's transform emits
    // nothing for `declare enum` AND `declare const enum` alike (it does
    // NOT inline ambient const members the way tsc's emit would; Node is
    // the oracle, measured). Two worlds where the object IS defined stand
    // aside: stdlib/@types/node declarations describe real runtime values
    // (the SC2020-family member fences own those), and npm-declared enums
    // under --dynamic live in the embedded engine (the island paths own
    // them). What remains is the user's own `declare enum` — the
    // `declare const __VERSION__` stance: ReferenceError at the access.
    const sf = enumDecl.getSourceFile();
    if (lowerer.isStdlibFile(sf) || (lowerer.dynamic && lowerer.isNpmFile(sf))) return null;
    const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (!declared || declared.kind === "void") return null;
    return {
      kind: "libCall",
      fn: "global.undefRead",
      args: [{ kind: "strLit", value: enumDecl.name.text, type: STRING, loc }],
      type: declared,
      loc,
    };
  }
  const value = lowerer.checker.getConstantValue(member);
  if (value === undefined || (typeof value === "number" && Number.isNaN(value))) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `the enum member '${enumDecl.name.text}.${memberNameText(member)}' (its value is not a compile-time constant — the initializer runs when the declaration executes)`,
    );
  }
  return typeof value === "string"
    ? { kind: "strLit", value, type: STRING, loc }
    : { kind: "numLit", value, type: F64, loc };
}

/** `E[<number>]` — the reverse mapping. Numeric members write reverse
 * entries in declaration order (merged declarations included), so the LAST
 * member carrying the index's value answers, exactly the object JS builds.
 * Only compile-time-constant indices lower; a matchless constant index is
 * Node's undefined, which the read's `string` type cannot carry — both
 * fence by name. */
function lowerEnumReverseRead(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
  recvSym: ts.Symbol,
  decls: readonly ts.EnumDeclaration[],
  key: ts.Expression,
): IrExpr | null {
  const loc = locOf(expr);
  const enumName = recvSym.name;
  // Ambient: no object exists — the member-read stance.
  if (decls.every((d) => isAmbientEnumDecl(d))) {
    if (decls.some((d) => lowerer.isStdlibFile(d.getSourceFile()) || (lowerer.dynamic && lowerer.isNpmFile(d.getSourceFile())))) {
      return null;
    }
    return {
      kind: "libCall",
      fn: "global.undefRead",
      args: [{ kind: "strLit", value: enumName, type: STRING, loc }],
      type: STRING,
      loc,
    };
  }
  // A mix of ambient and runtime declarations would need per-member
  // existence tracking; nothing needs it — fence through the generic path.
  if (decls.some((d) => isAmbientEnumDecl(d))) return null;
  const idx = foldConstIndex(lowerer, key);
  if (idx === null) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `enum reverse lookups ('${enumName}[i]' where the index is a runtime value — only compile-time-constant indices lower)`,
    );
  }
  let name: string | null = null;
  for (const d of decls) {
    for (const member of d.members) {
      const v = lowerer.checker.getConstantValue(member);
      if (typeof v === "number" && v === idx) name = memberNameText(member);
    }
  }
  if (name === null) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'${enumName}[${idx}]' (no member of '${enumName}' has this value — Node answers undefined, which the reverse mapping's 'string' type cannot carry)`,
    );
  }
  return { kind: "strLit", value: name, type: STRING, loc };
}

/** A compile-time-constant NUMERIC index: a numeric literal, its negation,
 * or an enum member read whose constant is a number. */
function foldConstIndex(lowerer: Lowerer, e: ts.Expression): number | null {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  if (ts.isNumericLiteral(x)) return Number(x.text);
  if (
    ts.isPrefixUnaryExpression(x) &&
    x.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(x.operand)
  ) {
    return -Number(x.operand.text);
  }
  if (ts.isPropertyAccessExpression(x)) {
    const sym = lowerer.checker.getSymbolAtLocation(x.name);
    if (sym && sym.flags & ts.SymbolFlags.EnumMember) {
      const decl = lowerer.checker.valueDeclarationOf(sym);
      if (decl && ts.isEnumMember(decl)) {
        const v = lowerer.checker.getConstantValue(decl);
        if (typeof v === "number") return v;
      }
    }
  }
  return null;
}

/** The declaration statement. Ambient declarations emit nothing (Node's
 * type stripping drops them too). Runtime declarations whose members are
 * ALL compile-time constants also emit nothing: constant initializers have
 * no observable evaluation, member reads fold at their sites, and the
 * object's creation is only observable through object-valued uses — which
 * fence per site. A computed member's initializer is a runtime expression
 * Node evaluates at the declaration — dropping it would be observable, so
 * the declaration fences on that member. */
export function lowerEnumDeclaration(lowerer: Lowerer, stmt: ts.EnumDeclaration): null {
  if (isAmbientEnumDecl(stmt)) return null;
  for (const member of stmt.members) {
    if (lowerer.checker.getConstantValue(member) === undefined) {
      lowerer.unsupported(
        "SC1090",
        member,
        `enums with computed members ('${memberNameText(member)}' — the initializer is a runtime expression evaluated when the declaration executes; only compile-time-constant enum members lower)`,
      );
    }
  }
  return null;
}

/** The identifier chokepoint's enum arm: the enum OBJECT used as a VALUE
 * (passed around, iterated, stored). Member reads never reach here (the
 * access hook claims them); everything else is the object itself, which
 * has no lowering. Returns false when the symbol is not an enum. */
export function fenceEnumObjectValue(lowerer: Lowerer, expr: ts.Identifier, sym: ts.Symbol): void {
  if (!(sym.flags & ts.SymbolFlags.Enum)) return;
  lowerer.unsupported(
    "SC1090",
    expr,
    `enum objects as values ('${expr.text}' — member reads like '${expr.text}.A' compile to constants; the object itself has no runtime representation)`,
  );
}
