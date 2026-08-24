/* Expando function members (`function foo() {}; foo.bar = 12` — the
 * namespace-object idiom tsc binds as members ON the function's own
 * symbol/type) and property members of module-level CALLABLE consts
 * (`const c: Combo = () => 1; c.p = {}` — an interface member written
 * through the const's name).
 *
 * The lowering: each written member is a MODULE GLOBAL keyed by
 * (function symbol × member key), registered during collection by
 * scanning the file for member-assignment statements whose receiver is a
 * direct reference to a module-level function declaration or a
 * function-valued const. Reads and writes through the function's NAME
 * route to that global — the checker's declared member type is the
 * slot's type, and JS object identity holds because only references that
 * RESOLVE to the declaring symbol route this way (a structurally-typed
 * alias keeps its fences: a different function value could satisfy the
 * same type, so symbol identity, not type identity, is the routing key).
 *
 * Honesty guards, mirroring the namespace-member stance:
 * - reads in INIT-EXECUTING position textually above the member's FIRST
 *   assignment fence (JS would answer undefined; the global would answer
 *   a later write's value);
 * - writes to the READ-ONLY function members (`length`, `name`,
 *   `caller`, `arguments`) fence: strict-mode JS (every module) throws
 *   TypeError there, and a global slot would silently succeed. WRITABLE
 *   Function.prototype members (`apply`, `call`, `bind`, `toString`)
 *   shadow through an own property in JS and lower like any other member
 *   — reads route to the registry, so the shadowed value is what reads
 *   and calls observe;
 * - member keys are spelled names, folded computed keys
 *   (foldedStringKeyOf's contract), or statically-resolvable
 *   unique-symbol consts (uniqueSymbolKeyOf — the class symbol-field
 *   precedent); runtime-valued keys keep their fences. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { IrExpr, IrGlobal, IrStmt, IrType } from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import { isUnitOnlyTsType, unitOnlyUnion } from "../type-mapper.js";

/** The registry entry for one expando member slot. */
export interface ExpandoMember {
  global: IrGlobal;
  /** Source start of the FIRST assignment in the declaring file — the
   * init-position read guard's boundary. */
  firstWriteStart: number;
  /** The declaring file (guards apply to same-file init reads only —
   * importers evaluate after the exporter's init, the module-globals
   * stance). */
  file: ts.SourceFile;
}

/** Function members JS refuses to assign in strict mode (every module is
 * strict): non-writable own properties of functions plus the poisoned
 * caller/arguments pair. A global slot would silently succeed where Node
 * throws TypeError, so writes fence by name. */
const READONLY_FN_MEMBERS = new Set(["length", "name", "caller", "arguments", "prototype"]);

/** The member key of an assignment target / read site: a spelled or
 * folded string name, a unique-symbol const's ts.Symbol, or null (not a
 * routable key). */
function memberKeyOf(lowerer: Lowerer, expr: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | ts.Symbol | null {
  if (ts.isPropertyAccessExpression(expr)) {
    return ts.isIdentifier(expr.name) ? expr.name.text : null;
  }
  const sym = lowerer.uniqueSymbolKeyOf(expr.argumentExpression);
  if (sym) return sym.sym;
  return lowerer.foldedStringKeyOf(expr.argumentExpression);
}

/** The module-level function-ish symbol a receiver expression resolves
 * to, or null: a top-level FunctionDeclaration, or a top-level `const`
 * variable whose checker type is callable (arrow/function-expression
 * consts, interface-typed callable consts). Only direct identifier
 * references qualify — routing is by symbol identity. */
function expandoFnSymbolOf(lowerer: Lowerer, recv: ts.Expression): ts.Symbol | null {
  if (!ts.isIdentifier(recv)) return null;
  // Island and checked-dynamic receivers never qualify by construction:
  // the declaration-shape checks below (a function DECLARATION, or a
  // const whose initializer is a function/arrow LITERAL in a TS file)
  // exclude import bindings, call results, and JS-file values — their
  // member stories (engine property writes, dyn keyed writes) stay put.
  const sym = lowerer.resolveValueSymbol(recv);
  if (!sym) return null;
  const decl = lowerer.checker.valueDeclarationOf(sym);
  if (!decl || decl.getSourceFile().isDeclarationFile) return null;
  if (isJsSourceFile(decl.getSourceFile())) return null;
  if (ts.isFunctionDeclaration(decl)) {
    return ts.isSourceFile(decl.parent) ? sym : null;
  }
  if (ts.isVariableDeclaration(decl)) {
    if (!ts.isVariableStatement(decl.parent.parent) || !ts.isSourceFile(decl.parent.parent.parent)) return null;
    if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) return null;
    // The const's VALUE must be a function created here (arrow/function
    // initializer) — a callable TYPE alone can be satisfied by island
    // handles and other values whose members live elsewhere.
    let init = decl.initializer;
    while (init !== undefined && (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isTypeAssertion(init))) init = init.expression;
    if (init === undefined || (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init))) return null;
    if (lowerer.checker.getCallSignatures(lowerer.checker.getTypeOfSymbol(sym)).length === 0) return null;
    return sym;
  }
  return null;
}

/** A member-assignment statement's pieces (`<fn>.<key> = <value>` /
 * `<fn>[KEY] = <value>` under any assignment operator), or null. */
function expandoWriteOf(
  lowerer: Lowerer,
  node: ts.Node,
): { fnSym: ts.Symbol; key: string | ts.Symbol; access: ts.PropertyAccessExpression | ts.ElementAccessExpression } | null {
  if (!ts.isBinaryExpression(node)) return null;
  const op = node.operatorToken.kind;
  if (op !== ts.SyntaxKind.EqualsToken && (op < ts.SyntaxKind.FirstCompoundAssignment || op > ts.SyntaxKind.LastCompoundAssignment)) {
    return null;
  }
  const left = node.left;
  if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return null;
  if (ts.isPropertyAccessExpression(left) && left.questionDotToken) return null;
  const fnSym = expandoFnSymbolOf(lowerer, left.expression);
  if (!fnSym) return null;
  const key = memberKeyOf(lowerer, left);
  if (key === null) return null;
  return { fnSym, key, access: left };
}

/** Collection: walk one file for expando member assignments and register
 * a module global per (function symbol × member key). Runs with
 * collectGlobals — before any statement lowers — so reads inside earlier
 * function bodies resolve. Registration failures (unmappable member
 * types) register nothing: the write statement's own lowering fences. */
export function collectExpandoMembers(lowerer: Lowerer, sf: ts.SourceFile): void {
  const rawTag = lowerer.fileTag.get(sf) ?? "";
  const tag = rawTag === "" ? "e." : rawTag.replace(/^%/, "");
  // Worklist walk, not recursion: pathologically deep expressions (the
  // 7000-level nesting fixtures) must reach their own named fences, not
  // blow the collection pass's stack.
  const queue: ts.Node[] = [];
  const process = (node: ts.Node): void => {
    const w = expandoWriteOf(lowerer, node);
    if (w) {
      let members = lowerer.expandoMembers.get(w.fnSym);
      if (!members) {
        members = new Map();
        lowerer.expandoMembers.set(w.fnSym, members);
      }
      const existing = members.get(w.key);
      if (existing) {
        existing.firstWriteStart = Math.min(existing.firstWriteStart, node.getStart());
      } else if (!(typeof w.key === "string" && READONLY_FN_MEMBERS.has(w.key)) && !nsOwnedMember(lowerer, w.access)) {
        // The member slot's type is the checker's DECLARED member type at
        // the access (expando members widen across all assignments;
        // interface members carry their declared type). Mapping failures
        // register nothing and drop their collection-time diagnostics —
        // the write statement's own lowering re-diagnoses in context.
        const diagsBefore = lowerer.diags.length;
        const tsType = lowerer.typeOf(w.access);
        let type: IrType | null;
        try {
          type = lowerer.mapTypeOf(tsType);
        } catch {
          lowerer.diags.splice(diagsBefore); // PoisonError — the statement re-diagnoses
          type = null;
        }
        if (type?.kind === "void" && isUnitOnlyTsType(tsType)) type = unitOnlyUnion(lowerer.unions);
        if (type && type.kind !== "void") {
          const fnName = w.fnSym.name;
          const memberName = typeof w.key === "string" ? w.key : `sym%${w.key.name}%${lowerer.checker.declarationsOf(w.key)[0]?.getStart() ?? 0}`;
          const g: IrGlobal = {
            id: `%g.${tag}${fnName}%.${memberName}`,
            name: `${fnName}.${memberName}`,
            type,
            mutable: true,
          };
          members.set(w.key, { global: g, firstWriteStart: node.getStart(), file: sf });
          lowerer.globalsList.push(g);
        }
      }
    }
    ts.forEachChild(node, (c) => {
      queue.push(c);
    });
  };
  ts.forEachChild(sf, (c) => {
    queue.push(c);
  });
  while (queue.length > 0) process(queue.pop()!);
}

/** A member the NAMESPACE machinery owns storage for: the member symbol
 * declares as a variable inside a NON-AMBIENT namespace block (a real
 * function+namespace merge — those members have namespace globals and
 * nsWritableTarget routes them). Ambient (`declare namespace`) members
 * have no storage anywhere and are exactly the declared-expando idiom
 * this module lowers. */
function nsOwnedMember(lowerer: Lowerer, access: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const nameNode = ts.isPropertyAccessExpression(access) ? access.name : access.argumentExpression;
  const sym = lowerer.checker.getSymbolAtLocation(nameNode);
  if (!sym) return false;
  for (const d of lowerer.checker.declarationsOf(sym)) {
    for (let p: ts.Node | undefined = d.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
      if (ts.isModuleDeclaration(p)) {
        return !(p.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) || p.getSourceFile().isDeclarationFile);
      }
    }
  }
  return false;
}

/** True when `node` executes during module INIT (top-level statement
 * position, not inside any function-like body) — the read-guard test,
 * mirroring the namespace stance. */
function initExecutingPosition(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if (ts.isFunctionLike(p)) return false;
    if (ts.isSourceFile(p)) break;
  }
  return true;
}

/** Assignment-target resolution for expando member writes: the member's
 * module global. Fences read-only function members by name. Null when
 * the access is not an expando member at all. */
export function expandoWritableTarget(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): { id: string; type: IrType } | null {
  if (ts.isPropertyAccessExpression(access) && access.questionDotToken) return null;
  const fnSym = expandoFnSymbolOf(lowerer, access.expression);
  if (!fnSym) return null;
  const key = memberKeyOf(lowerer, access);
  if (key === null) return null;
  if (typeof key === "string" && READONLY_FN_MEMBERS.has(key)) {
    lowerer.unsupported(
      "SC1090",
      access,
      `assigning the read-only function member '${key}' (strict-mode JS — every module — throws TypeError here)`,
    );
  }
  const member = lowerer.expandoMembers.get(fnSym)?.get(key);
  if (!member) return null;
  return { id: member.global.id, type: member.global.type };
}

/** Read resolution for expando member accesses: a varRef of the member's
 * global, guarded against init-position reads above the first write
 * (Node answers undefined there — the global would answer a later
 * write's value). Null when not an expando member read. */
export function expandoMemberRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): IrExpr | null {
  if (ts.isPropertyAccessExpression(access) && access.questionDotToken) return null;
  if (ts.isElementAccessExpression(access) && access.questionDotToken) return null;
  const fnSym = expandoFnSymbolOf(lowerer, access.expression);
  if (!fnSym) return null;
  const key = memberKeyOf(lowerer, access);
  if (key === null) return null;
  const member = lowerer.expandoMembers.get(fnSym)?.get(key);
  if (!member) return null;
  if (
    access.getSourceFile() === member.file &&
    initExecutingPosition(access) &&
    access.getStart() < member.firstWriteStart
  ) {
    const name = typeof key === "string" ? key : key.name;
    lowerer.unsupported(
      "SC1090",
      access,
      `reading the function member '${name}' above its first assignment (JS answers undefined there, which the member's type cannot hold — move the read below the assignment)`,
    );
  }
  return { kind: "varRef", localId: member.global.id, type: member.global.type, loc: locOf(access) };
}

/** The statement lowering for `<fn>.<key> = <value>`: an ordinary global
 * assign with the usual RHS coercion. Null when not an expando write. */
export function lowerExpandoAssignStmt(lowerer: Lowerer, expr: ts.BinaryExpression): IrStmt | null {
  if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const left = expr.left;
  if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return null;
  const target = expandoWritableTarget(lowerer, left);
  if (!target) return null;
  const value = lowerer.lowerExprExpecting(expr.right, target.type);
  return { kind: "assign", localId: target.id, value, loc: locOf(expr) };
}
