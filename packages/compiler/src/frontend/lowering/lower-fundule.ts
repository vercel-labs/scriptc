/* Function+namespace merges ("fundules"). `function fmt(n: number) { … }`
 * merged with `namespace fmt { export const digits = 2 }` is ONE value in
 * Node: the transform emits an IIFE that assigns each exported member onto
 * the existing function object, so the function IS the namespace object.
 * `Object.keys(fmt)` lists the members, `"digits" in fmt` answers true,
 * inspect prints `[Function: fmt] { digits: 2 }`, `typeof` stays
 * "function", and a read through any alias observes a later write.
 *
 * One representation: the closure's own-property table (callable-
 * properties.ts, the same table expando member writes and
 * `Object.assign(fn, …)` use). Every exported member of a merged block is
 * a table entry written at the member's source position; reads and writes
 * lower through the same keyed operations the `any` view of the function
 * emits, and no module global exists for the member. Namespaces that do
 * NOT merge with a function keep their flattened module globals byte for
 * byte (lower-namespaces.ts).
 *
 * Scope: exported `const`/`let`/`var` members with an initializer, and
 * exported functions with one signature and no type parameters (a function
 * with a value form). Everything else a merged block can export — a class,
 * an enum, a nested namespace, an `export import` alias, a destructuring
 * pattern, a generic or overloaded function, or a member without an
 * initializer (Node emits no property for `export let x;`) — is refused by
 * name at collection rather than silently diverging.
 *
 * An `import x = fmt.member` alias is Node's `const x = fmt.member`: a copy
 * of the property taken where the alias stands. A property of the function
 * object can be replaced whatever its declaration says (`Object.assign(fmt,
 * { digits: 4 })` replaces a `const` member, and a function member), so
 * the alias of every member owns storage and the alias statement fills it
 * from the table (collectGlobals, lowerImportEquals). */

import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { callableBox } from "./callable-properties.js";
import { fieldGetExpr, type FieldTarget } from "./lower-exprs.js";
import type { IrExpr, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { locOf } from "../program.js";

/** A member a merged namespace block exports onto its function. */
export interface FunduleMember {
  /** The merged function's name: the receiver of every table operation. */
  fn: ts.Identifier;
  /** The member's own-property key (its name in the block). */
  key: string;
}

/** The TOP-LEVEL function a namespace declaration merges into, or null when
 * `decl` is an ordinary namespace (or a class/function merge this file does
 * not own: non-top-level, other-file, or non-function partner). */
export function funduleFunctionOf(
  lowerer: Lowerer,
  decl: ts.ModuleDeclaration,
): ts.Identifier | null {
  if (!ts.isIdentifier(decl.name)) return null;
  // Only a module-scope merge is lowered: a nested one would need a
  // receiver expression from the enclosing block.
  if (!ts.isSourceFile(decl.parent)) return null;
  const sym = lowerer.checker.getSymbolAtLocation(decl.name);
  if (sym === undefined || (sym.flags & ts.SymbolFlags.Function) === 0) return null;
  const fn = sym.declarations.find(
    (d): d is ts.FunctionDeclaration => ts.isFunctionDeclaration(d) && d.name !== undefined,
  );
  // The merge partner must be this module's own function declaration.
  if (fn === undefined || fn.parent !== decl.parent) return null;
  // A name merged with a class or an enum too is their business, not a
  // plain function object's.
  if (sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.RegularEnum | ts.SymbolFlags.ConstEnum))
    return null;
  return fn.name ?? null;
}

/** The function+namespace merge `sym` is an exported member of, or null. */
export function funduleMemberOf(
  lowerer: Lowerer,
  sym: ts.Symbol | null | undefined,
): FunduleMember | null {
  if (sym === undefined || sym === null) return null;
  return lowerer.funduleMembers.get(sym) ?? null;
}

/** Whether `stmt` declares only exported members of a merged namespace. */
export function isFunduleMemberStatement(lowerer: Lowerer, stmt: ts.VariableStatement): boolean {
  const first = stmt.declarationList.declarations.nodes[0];
  if (first === undefined || !ts.isIdentifier(first.name)) return false;
  const sym = lowerer.checker.getSymbolAtLocation(first.name);
  return funduleMemberOf(lowerer, sym) !== null;
}

/** `receiver.key = value` on the merged function object. */
function tableStore(
  lowerer: Lowerer,
  member: FunduleMember,
  value: IrExpr,
  fieldType: IrType,
  loc: SrcLoc,
  blame: ts.Node,
): IrStmt {
  const boxed = callableBox(lowerer, lowerer.lowerExpr(member.fn));
  if (boxed === null) {
    lowerer.unsupported(
      "SC1090",
      blame,
      `the merged namespace member '${member.key}'`,
      "the function object must be representable as a dynamic value to carry its namespace members",
    );
  }
  const target: FieldTarget = {
    container: "dynamic",
    obj: boxed,
    field: member.key,
    fieldType,
  };
  return lowerer.fieldSetStmt(target, value, loc, blame);
}

/** The table store for one EXPORTED member of a merged namespace block
 * (Node's `fmt.digits = 2` at the declaration's position), or null when
 * `decl` is not such a member. */
export function lowerFunduleMemberDecl(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): IrStmt[] | null {
  if (!ts.isIdentifier(decl.name)) return null;
  const sym = lowerer.checker.getSymbolAtLocation(decl.name);
  const member = funduleMemberOf(lowerer, sym);
  if (member === null) return null;
  // `export let x;` emits no property in Node's transform: the member
  // exists only once something writes it, and this lowering has no
  // uninitialized table entry to model that with. Collection refused it.
  if (decl.initializer === undefined) return [];
  const fieldType = lowerer.mapTypeOf(lowerer.typeOf(decl.name));
  if (fieldType === null || fieldType.kind === "void") {
    lowerer.badType(decl.name, lowerer.typeOf(decl.name));
  }
  const value = lowerer.lowerExprExpecting(decl.initializer, fieldType);
  return [tableStore(lowerer, member, value, fieldType, locOf(decl), decl)];
}

/** The store that puts a merged block's exported FUNCTION on the function
 * object at its source position (`fmt.helper = helper` in Node's emit).
 * The declaration itself is hoisted and lowered as an ordinary function;
 * only the property assignment is positional, which is what fixes the
 * `Object.keys` order among a block's members. */
export function lowerFunduleFnStore(lowerer: Lowerer, decl: ts.FunctionDeclaration): IrStmt[] {
  const name = decl.name;
  if (name === undefined) return [];
  const sym = lowerer.checker.getSymbolAtLocation(name);
  const member = funduleMemberOf(lowerer, sym);
  if (member === null) return [];
  const fieldType = lowerer.mapTypeOf(lowerer.typeOf(name));
  if (fieldType === null || fieldType.kind === "void") {
    lowerer.badType(name, lowerer.typeOf(name));
  }
  const value = lowerer.lowerExprExpecting(name, fieldType);
  return [tableStore(lowerer, member, value, fieldType, locOf(decl), name)];
}

/** Whether `id` names a declaration rather than referring to its value. A
 * declaration's own name is never a table read: the store that publishes
 * `fmt.helper = helper` needs the function, not the property it defines. */
function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (p === undefined) return false;
  return (
    (ts.isVariableDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isBindingElement(p) ||
      ts.isParameter(p)) &&
    p.name === id
  );
}

/** Whether `ident` names an exported FUNCTION of the block by its bare
 * name. Node's transform keeps the declaration as the block's own hoisted
 * binding beside the property (`function helper() {}  fmt.helper = helper`)
 * and does not qualify a bare reference to it, so the reference is the
 * declared function: before the store has run, and after the property was
 * replaced. Only the qualified spelling `fmt.helper` reads the property. */
function isBareFunctionReference(ident: ts.Identifier, sym: ts.Symbol | null | undefined): boolean {
  if (sym === undefined || sym === null) return false;
  if (!sym.declarations.some((d) => ts.isFunctionDeclaration(d))) return false;
  const p = ident.parent;
  return !(p !== undefined && ts.isPropertyAccessExpression(p) && p.name === ident);
}

/** The member's value as the function object holds it now, checked into
 * `type`: the right-hand side of Node's `const x = fmt.member` for an
 * `import x = fmt.member` alias (lower-namespaces.ts). */
export function lowerFunduleMemberValue(
  lowerer: Lowerer,
  member: FunduleMember,
  type: IrType,
  loc: SrcLoc,
  blame: ts.Node,
): IrExpr {
  const boxed = callableBox(lowerer, lowerer.lowerExpr(member.fn));
  if (boxed === null) {
    lowerer.unsupported(
      "SC1090",
      blame,
      `the merged namespace member '${member.key}'`,
      "the function object must be representable as a dynamic value to carry its namespace members",
    );
  }
  return fieldGetExpr(
    lowerer,
    { container: "dynamic", obj: boxed, field: member.key, fieldType: type },
    loc,
    blame,
  );
}

/** A read of a merged block's member by the member's name: BARE inside the
 * block (`digits`, which Node's transform qualifies to `fmt.digits`) or
 * the name of the qualified spelling; null when the identifier is not a
 * member of a merge, or is a bare reference to an exported function. The
 * read walks the function's table and checks the value back into the
 * member's declared type. */
export function lowerFunduleMemberRead(
  lowerer: Lowerer,
  ident: ts.Identifier,
  loc: SrcLoc,
): IrExpr | null {
  if (isDeclarationName(ident)) return null;
  const sym = lowerer.resolveValueSymbol(ident);
  const member = funduleMemberOf(lowerer, sym);
  if (member === null) return null;
  if (isBareFunctionReference(ident, sym)) return null;
  const boxed = callableBox(lowerer, lowerer.lowerExpr(member.fn));
  if (boxed === null) return null;
  const fieldType = lowerer.mapTypeOf(lowerer.typeOf(ident));
  if (fieldType === null || fieldType.kind === "void") return null;
  return fieldGetExpr(
    lowerer,
    { container: "dynamic", obj: boxed, field: member.key, fieldType },
    loc,
    ident,
  );
}
