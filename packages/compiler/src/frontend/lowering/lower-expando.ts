/* Expando function members (`function foo() {}; foo.bar = 12` — the
 * namespace-object idiom tsc binds as members ON the function's own
 * symbol/type) and property members of module-level CALLABLE consts
 * (`const c: Combo = () => 1; c.p = {}` — an interface member written
 * through the const's name).
 *
 * The members ARE own properties of the function object, so they lower
 * through the closure's own-property table like every other callable
 * member (lowering/callable-properties.ts): a write is the keyed table
 * store the `any` view of the same function emits, a read the same keyed
 * get checked back into the declared member type. Nothing here stores a
 * value. This module contributes only the source-order fence that the
 * table cannot express, plus the read-only function members JS refuses to
 * assign.
 *
 * Why a fence exists at all: Node evaluates a module top to bottom, so a
 * read textually above the member's first assignment observes `undefined`
 * (the property does not exist yet), which the member's declared type
 * cannot hold — while the table answers a later write's value. An
 * INIT-EXECUTING read above the first write fences by name instead. Reads
 * inside function bodies take the module-globals stance the rest of the
 * compiler already takes (a body that runs before the assignment is not
 * modeled — same as a top-level const read through an early call).
 *
 * Strict-mode JS (every module) throws TypeError on writes to the
 * non-writable function members `length`, `name`, `prototype` and the
 * poisoned `caller`/`arguments` pair; a table store would succeed, so
 * those writes fence by name too.
 *
 * Keys are spelled names, folded computed keys (foldedStringKeyOf's
 * contract), or statically-resolvable unique-symbol consts
 * (uniqueSymbolKeyOf — the class symbol-field precedent). Members the
 * NAMESPACE machinery owns (a real function+namespace merge) have their
 * own storage and their own fences and take no part here. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isJsSourceFile } from "../program.js";

/** The registry entry for one expando member slot. */
export interface ExpandoMember {
  /** Source start of the FIRST assignment in the declaring file — the
   * init-position read guard's boundary. */
  firstWriteStart: number;
  /** The declaring file (guards apply to same-file init reads only —
   * importers evaluate after the exporter's init, the module-globals
   * stance). */
  file: ts.SourceFile;
}

/** String property names and checker-symbol identities are disjoint key
 * domains. Keep both explicit; a symbol's display name is never its key. */
export interface ExpandoMembers {
  names: Map<string, ExpandoMember>;
  symbols: Map<ts.Symbol, ExpandoMember>;
}

function memberOf(
  members: ExpandoMembers | undefined,
  key: string | ts.Symbol,
): ExpandoMember | undefined {
  return typeof key === "string" ? members?.names.get(key) : members?.symbols.get(key);
}

/** Function members JS refuses to assign in strict mode (every module is
 * strict): non-writable own properties of functions plus the poisoned
 * caller/arguments pair. They are not table data; their writes keep their
 * own refusal. */
const READONLY_FN_MEMBERS = new Set(["length", "name", "caller", "arguments", "prototype"]);

/** The member key of an assignment target / read site: a spelled or
 * folded string name, a unique-symbol const's ts.Symbol, or null (not a
 * routable key). */
function memberKeyOf(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | ts.Symbol | null {
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

  // the declaration-shape checks below (a function DECLARATION, or a
  // const whose initializer is a function/arrow LITERAL in a TS file)
  // exclude import bindings, call results, and JS-file values — their
  // existing member paths stay put.
  const sym = lowerer.resolveValueSymbol(recv);
  if (!sym) return null;
  const decl = sym.valueDeclaration;
  if (!decl || ts.getSourceFileOfNode(decl).isDeclarationFile) return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(decl))) return null;
  if (ts.isFunctionDeclaration(decl)) {
    return ts.isSourceFile(decl.parent) ? sym : null;
  }
  if (ts.isVariableDeclaration(decl)) {
    if (
      !ts.isVariableStatement(decl.parent?.parent) ||
      !ts.isSourceFile(decl.parent?.parent?.parent)
    )
      return null;
    if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) return null;
    // The const's value must be a function created here, not an imported
    // value whose properties belong to another lowering path.
    let init = decl.initializer;
    while (
      init !== undefined &&
      (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isTypeAssertion(init))
    )
      init = init.expression;
    if (init === undefined || (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)))
      return null;
    if (lowerer.checker.getCallSignatures(lowerer.checker.getTypeOfSymbol(sym)).length === 0)
      return null;
    return sym;
  }
  return null;
}

/** A member-assignment statement's pieces (`<fn>.<key> = <value>` /
 * `<fn>[KEY] = <value>` under any assignment operator), or null. */
function expandoWriteOf(
  lowerer: Lowerer,
  node: ts.Node,
): {
  fnSym: ts.Symbol;
  key: string | ts.Symbol;
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression;
} | null {
  if (!ts.isBinaryExpression(node)) return null;
  const op = node.operatorToken.kind;
  if (
    op !== ts.SyntaxKind.EqualsToken &&
    (op < ts.SyntaxKind.FirstCompoundAssignment || op > ts.SyntaxKind.LastCompoundAssignment)
  ) {
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
 * the first write of each (function symbol × member key). Runs with
 * collectGlobals — before any statement lowers — so the read fence is
 * known for reads inside earlier function bodies. */
export function collectExpandoMembers(lowerer: Lowerer, sf: ts.SourceFile): void {
  // Worklist walk, not recursion: pathologically deep expressions (the
  // 7000-level nesting fixtures) must reach their own named fences, not
  // blow the collection pass's stack.
  const queue: ts.Node[] = [];
  const process = (node: ts.Node): void => {
    const w = expandoWriteOf(lowerer, node);
    if (w) {
      let members = lowerer.expandoMembers.get(w.fnSym);
      if (!members) {
        members = { names: new Map(), symbols: new Map() };
        lowerer.expandoMembers.set(w.fnSym, members);
      }
      const existing = memberOf(members, w.key);
      if (existing) {
        existing.firstWriteStart = Math.min(existing.firstWriteStart, ts.tokenStartOfNode(node));
      } else if (
        !(typeof w.key === "string" && READONLY_FN_MEMBERS.has(w.key)) &&
        !nsOwnedMember(lowerer, w.access)
      ) {
        const entry: ExpandoMember = {
          firstWriteStart: ts.tokenStartOfNode(node),
          file: sf,
        };
        if (typeof w.key === "string") members.names.set(w.key, entry);
        else members.symbols.set(w.key, entry);
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
 * this module serves. */
function nsOwnedMember(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  const nameNode = ts.isPropertyAccessExpression(access) ? access.name : access.argumentExpression;
  const sym = lowerer.checker.getSymbolAtLocation(nameNode);
  if (!sym) return false;
  for (const d of sym.declarations) {
    for (
      let p: ts.Node | undefined = d.parent;
      p !== undefined && !ts.isSourceFile(p);
      p = p.parent
    ) {
      if (ts.isModuleDeclaration(p)) {
        return !(
          p.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ||
          ts.getSourceFileOfNode(p).isDeclarationFile
        );
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

/** The source-order fence on a member READ: a same-file init-position read
 * above the member's first assignment observes `undefined` in Node, which
 * the declared member type cannot hold, while the table would answer a
 * later write's value. Refuses by name; every other read proceeds to the
 * ordinary callable-member lowering (lowering/callable-properties.ts). */
export function fenceExpandoRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): void {
  if (ts.isPropertyAccessExpression(access) && access.questionDotToken) return;
  if (ts.isElementAccessExpression(access) && access.questionDotToken) return;
  const fnSym = expandoFnSymbolOf(lowerer, access.expression);
  if (!fnSym) return;
  const key = memberKeyOf(lowerer, access);
  if (key === null) return;
  const member = memberOf(lowerer.expandoMembers.get(fnSym), key);
  if (!member) return;
  if (
    ts.getSourceFileOfNode(access) === member.file &&
    initExecutingPosition(access) &&
    ts.tokenStartOfNode(access) < member.firstWriteStart
  ) {
    const name = typeof key === "string" ? key : ts.symbolName(key);
    lowerer.unsupported(
      "SC1090",
      access,
      `reading the function member '${name}' above its first assignment (JS answers undefined there, which the member's type cannot hold — move the read below the assignment)`,
    );
  }
}

/** The read-only function members' write fence (see READONLY_FN_MEMBERS).
 * Applies to the same receiver shape: strict-mode JS throws TypeError
 * where a table store would succeed. */
export function fenceReadonlyExpandoWrite(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): void {
  if (ts.isPropertyAccessExpression(access) && access.questionDotToken) return;
  if (ts.isElementAccessExpression(access) && access.questionDotToken) return;
  const fnSym = expandoFnSymbolOf(lowerer, access.expression);
  if (!fnSym) return;
  const key = memberKeyOf(lowerer, access);
  if (typeof key === "string" && READONLY_FN_MEMBERS.has(key)) {
    lowerer.unsupported(
      "SC1090",
      access,
      `assigning the read-only function member '${key}' (strict-mode JS — every module — throws TypeError here)`,
    );
  }
}
