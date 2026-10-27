/* CommonJS require bindings read before their require ran. A top-level
 * `const x = require("./dep")` binds x AT the require: Node throws "Cannot
 * access 'x' before initialization" when code that runs earlier (a hoisted
 * function called above the require, say) reads it. The lowering keeps
 * require bindings as module aliases, so the reads themselves cannot
 * observe the order. When preflight finds code that can reach a binding
 * before its require (requireEarlyReference), the declaration gets a BOOL
 * initialization flag, set right after the require evaluated the module,
 * and every reference that can run earlier checks it first — the same
 * module.tdzCheck the import-cycle bindings use. A reference whose lowering
 * leaves no expression to check keeps the SC1013 fence. */
import { positionTag } from "./structural-positions.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import {
  inDeferredPosition,
  isCjsJsFile,
  locOf,
  requireEarlyReference,
  requireSpecOf,
} from "../program.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import {
  BOOL,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import { mapExprChildren, mapStmtChildren } from "../../ir/traverse.js";

/** One flagged require declaration. */
export interface RequireInitFlag {
  flagId: string;
  /** The binding names, by symbol. */
  names: Map<ts.Symbol, string>;
}

/** A reference that can run before its require: the identifier, the
 * outermost expression whose evaluation starts with reading it, and the
 * body of the innermost function holding it (null at the top level). */
export interface EarlyReference {
  flag: RequireInitFlag;
  name: string;
  ref: SrcLoc;
  chain: SrcLoc;
  body: SrcLoc | null;
  node: ts.Identifier;
}

function boundNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const out: ts.Identifier[] = [];
  for (const el of name.elements.nodes) {
    if (ts.isOmittedExpression(el) || el.name === undefined) continue;
    out.push(...boundNames(el.name));
  }
  return out;
}

/** The outermost node whose evaluation begins by evaluating `ref`: member
 * reads, calls and constructions through it, and the transparent wrappers
 * around them. */
function chainOf(ref: ts.Identifier): ts.Node {
  let node: ts.Node = ref;
  for (;;) {
    const parent = node.parent;
    if (parent === undefined) return node;
    if (
      ((ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent) ||
        ts.isCallExpression(parent) ||
        ts.isNewExpression(parent)) &&
        parent.expression === node) ||
      (ts.isTaggedTemplateExpression(parent) && parent.tag === node) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      (ts.isAsExpression(parent) && parent.expression === node) ||
      (ts.isSatisfiesExpression(parent) && parent.expression === node)
    ) {
      node = parent;
      continue;
    }
    return node;
  }
}

function enclosingBody(node: ts.Node): ts.Node | null {
  for (let p = node.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isFunctionLike(p)) {
      const body = (p as { body?: ts.Node }).body;
      if (body !== undefined) return body;
    }
    if (ts.isPropertyDeclaration(p) && p.initializer !== undefined) return p.initializer;
  }
  return null;
}

/** Registers a flag for every top-level const/let require declaration of a
 * CommonJS module whose bindings earlier code can reach, and collects the
 * references that can run before the require. Runs once per lowering pass,
 * after global collection. */
export function markRequireEarlyBindings(lowerer: Lowerer): void {
  for (const sf of lowerer.moduleOrder) {
    if (sf.isDeclarationFile || !isCjsJsFile(sf, lowerer.program)) continue;
    const declared: { decl: ts.VariableDeclaration; stmt: ts.VariableStatement }[] = [];
    for (const stmt of sf.statements.nodes) {
      if (!ts.isVariableStatement(stmt)) continue;
      if ((stmt.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) continue;
      for (const decl of stmt.declarationList.declarations.nodes) {
        if (decl.initializer === undefined || requireSpecOf(decl.initializer) === null) continue;
        if (requireEarlyReference(lowerer.program, decl) === null) continue;
        declared.push({ decl, stmt });
      }
    }
    if (declared.length === 0) continue;
    const rawTag = lowerer.fileTag.get(sf) ?? "";
    const tag = rawTag === "" ? "e." : rawTag.replace(/^%/, "");
    const bySymbol = new Map<ts.Symbol, { flag: RequireInitFlag; decl: ts.VariableDeclaration }>();
    for (const { decl } of declared) {
      const flagId = `%g.${tag}%required.${positionTag(lowerer, decl)}`;
      lowerer.globalsList.push({ id: flagId, name: "%initialized", type: BOOL, mutable: true });
      const flag: RequireInitFlag = { flagId, names: new Map() };
      for (const id of boundNames(decl.name)) {
        const symbol = lowerer.checker.getSymbolAtLocation(id);
        if (symbol === undefined) continue;
        flag.names.set(symbol, id.text);
        bySymbol.set(symbol, { flag, decl });
      }
      lowerer.requireInitFlags.set(decl, flag);
    }
    const names = new Set<string>();
    for (const { flag } of bySymbol.values()) for (const n of flag.names.values()) names.add(n);
    const idents: ts.Identifier[] = [];
    ts.walkPreorder(sf, (node) => {
      if (ts.isIdentifier(node) && names.has(node.text)) idents.push(node);
      return undefined;
    });
    lowerer.checker.prefetchSymbolNodesExact(idents);
    for (const id of idents) {
      const parent = id.parent;
      const symbol =
        parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === id
          ? lowerer.checker.getShorthandAssignmentValueSymbol(parent)
          : lowerer.checker.getSymbolAtLocation(id);
      const owner = symbol === undefined ? undefined : bySymbol.get(symbol);
      if (owner === undefined) continue;
      if (boundNames(owner.decl.name).includes(id)) continue;
      // Code after the require runs after it, except inside functions.
      if (ts.tokenStartOfNode(id) >= owner.decl.end && !inDeferredPosition(id)) continue;
      const body = enclosingBody(id);
      lowerer.requireEarlyReferences.push({
        flag: owner.flag,
        name: owner.flag.names.get(symbol!)!,
        ref: locOf(id),
        chain: locOf(chainOf(id)),
        body: body === null ? null : locOf(body),
        node: id,
      });
    }
  }
}

/** The statement marking a flagged require declaration initialized, placed
 * right after its require evaluated the module. */
export function requireInitFlagStmt(lowerer: Lowerer, decl: ts.VariableDeclaration): IrStmt | null {
  const flag = lowerer.requireInitFlags.get(decl);
  if (flag === undefined) return null;
  const loc = locOf(decl);
  return {
    kind: "assign",
    localId: flag.flagId,
    value: { kind: "boolLit", value: true, type: BOOL, loc },
    loc,
  };
}

const within = (inner: SrcLoc, outer: SrcLoc): boolean =>
  inner.file === outer.file && outer.start <= inner.start && inner.end <= outer.end;

/** Inserts the initialization check before the outermost expression built
 * for each early reference, and refuses a reference whose lowered code
 * holds no expression for it. */
export function checkRequireBindingAccesses(lowerer: Lowerer, functions: IrFunction[]): void {
  const refs = lowerer.requireEarlyReferences;
  if (refs.length === 0) return;
  const byFile = new Map<string, EarlyReference[]>();
  for (const r of refs) {
    const list = byFile.get(r.ref.file);
    if (list) list.push(r);
    else byFile.set(r.ref.file, [r]);
  }
  const covered = new Set<EarlyReference>();
  const loweredBodies = new Set<EarlyReference>();
  const claimed = new Set<EarlyReference>();
  const check = (r: EarlyReference, loc: SrcLoc): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "intrinsic",
      name: "module.tdzCheck",
      args: [
        { kind: "varRef", localId: r.flag.flagId, type: BOOL, loc },
        { kind: "strLit", value: r.name, type: STRING, loc },
      ],
      type: VOID,
      loc,
    },
    loc,
  });
  const note = (loc: SrcLoc | undefined): EarlyReference[] => {
    if (loc === undefined) return [];
    const list = byFile.get(loc.file);
    if (list === undefined) return [];
    const mine: EarlyReference[] = [];
    for (const r of list) {
      if (r.body !== null && !loweredBodies.has(r) && within(loc, r.body)) loweredBodies.add(r);
      if (!claimed.has(r) && within(r.ref, loc) && within(loc, r.chain)) mine.push(r);
    }
    return mine;
  };
  const rewriteExpr = (e: IrExpr): IrExpr => {
    const mine = note(e.loc);
    for (const r of mine) claimed.add(r);
    const out = mapExprChildren(e, rewriteExpr, rewriteStmt);
    for (const r of mine) {
      claimed.delete(r);
      covered.add(r);
    }
    if (mine.length === 0) return out;
    const flags = new Set<string>();
    const stmts: IrStmt[] = [];
    for (const r of mine) {
      if (flags.has(r.flag.flagId)) continue;
      flags.add(r.flag.flagId);
      stmts.push(check(r, e.loc));
    }
    return { kind: "seqExpr", stmts, result: out, type: out.type, loc: out.loc };
  };
  const rewriteStmt = (s: IrStmt): IrStmt => {
    note(s.loc);
    return mapStmtChildren(s, rewriteExpr, rewriteStmt);
  };
  for (const fn of functions) fn.body = fn.body.map(rewriteStmt);
  if (lowerer.remainder) return;
  const reported = new Set<string>();
  for (const r of refs) {
    if (covered.has(r)) continue;
    // A function body that never lowered never runs.
    if (r.body !== null && !loweredBodies.has(r)) continue;
    const key = `${r.ref.file}:${r.ref.start}`;
    if (reported.has(key)) continue;
    reported.add(key);
    lowerer.pushDiag(
      unsupportedDiag(
        "SC1013",
        r.ref,
        `reading require() binding '${r.name}' where it can run before the require (this use has no checked form for Node's ReferenceError — move the require above the code that can run first)`,
      ),
    );
  }
}
