import type { IrExpr, IrFunction, IrModule, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";

/** Statements a callee may have, counting nested ones. */
const MAX_STATEMENTS = 12;
/** Direct call sites a callee may have. */
const MAX_CALL_SITES = 2;

/** Expressions that run other code: a callee that has none calls nothing,
 * so inlining it never inlines a call chain or a recursion. */
const CALLS = new Set<string>([
  "call",
  "callValue",
  "virtualCall",
  "dynCall",
  "dynInvoke",
  "new",
  "newValue",
  "newPromise",
  "ffiCall",
  "awaitExpr",
  "awaitUnionExpr",
]);

function isLoop(s: IrStmt): boolean {
  return s.kind === "for" || s.kind === "while" || s.kind === "doWhile" || s.kind === "forOf";
}

/** Small functions that are called only from inside loops: a per-element
 * helper such as
 *
 *     function pick(list: Gene[], rand: number): number {
 *       for (const gene of list) if (rand < gene.c) return gene.sc;
 *       return list[list.length - 1]!.sc;
 *     }
 *
 * called from a loop over the elements. After its loop versions and
 * checks, such a function is often past LLVM's inline cost threshold, so
 * every element pays a call, the spills around it, and checks that the
 * caller's loop could hoist once inlined.
 *
 * A function qualifies when it is a synchronous, non-generator function
 * with no captures and no own call (CALLS), has at most MAX_STATEMENTS
 * statements and one loop, and has one to MAX_CALL_SITES direct call sites
 * in the module, each inside a loop body of its caller. The emitter marks
 * those calls `alwaysinline`. Functions the module exports as a library
 * keep the cost model's decision. */
export function findLoopCallees(mod: IrModule): Set<string> {
  const result = new Set<string>();
  if (mod.lib !== undefined) return result;
  const candidates = new Map<string, IrFunction>();
  for (const fn of mod.functions) {
    if (fn.async || fn.generator || fn.captures !== undefined || fn.classCaptures !== undefined)
      continue;
    let statements = 0;
    let loops = 0;
    let calls = false;
    const expr = (e: IrExpr): boolean => {
      if (CALLS.has(e.kind)) calls = true;
      return !calls && everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      statements++;
      if (isLoop(s)) loops++;
      return statements <= MAX_STATEMENTS && loops <= 1 && everyStmtChild(s, expr, stmt);
    };
    if (!fn.body.every(stmt) || calls) continue;
    candidates.set(fn.name, fn);
  }
  if (candidates.size === 0) return result;
  // Call sites of each candidate, and whether every one is inside a loop.
  const sites = new Map<string, { count: number; inLoops: boolean }>();
  for (const fn of mod.functions) {
    let depth = 0;
    const expr = (e: IrExpr): boolean => {
      if (e.kind === "call" && candidates.has(e.callee)) {
        const site = sites.get(e.callee) ?? { count: 0, inLoops: true };
        site.count++;
        if (depth === 0 || e.callee === fn.name) site.inLoops = false;
        sites.set(e.callee, site);
      }
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      if (!isLoop(s)) return everyStmtChild(s, expr, stmt);
      // A loop's header runs per iteration too, except a for's init.
      if (s.kind === "for" && s.init) stmt(s.init);
      depth++;
      if (s.kind === "for") {
        if (s.cond) expr(s.cond);
        if (s.update) stmt(s.update);
        s.body.every(stmt);
      } else if (s.kind === "forOf") {
        depth--;
        expr(s.iterable);
        depth++;
        s.body.every(stmt);
      } else if (s.kind === "while" || s.kind === "doWhile") {
        expr(s.cond);
        s.body.every(stmt);
      }
      depth--;
      return true;
    };
    fn.body.every(stmt);
  }
  for (const [name, site] of sites)
    if (site.inLoops && site.count >= 1 && site.count <= MAX_CALL_SITES) result.add(name);
  return result;
}
