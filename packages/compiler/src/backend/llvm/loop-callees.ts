import type { IrExpr, IrModule, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";

/** Statements a callee may have, counting nested ones. */
const MAX_STATEMENTS = 12;
/** Direct call sites a callee may have. */
const MAX_CALL_SITES = 2;
/** The longest run of bodies a loop may pull in, the leaf included, so that
 * a copied chain stays small. */
const MAX_INLINE_DEPTH = 4;

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

/** The calls a module's loops inline, for emitDirectCall. */
export interface LoopInlining {
  /** Callees whose every direct call is marked `alwaysinline`. */
  readonly callees: ReadonlySet<string>;
  /** Callee name → the bodies it calls. Inlining the callee at its loop
   * sites moves those calls into the loop, so they are marked inside the
   * callee's body as well. */
  readonly bodyCalls: ReadonlyMap<string, ReadonlySet<string>>;
}

const NOTHING_INLINED: LoopInlining = { callees: new Set(), bodyCalls: new Map() };

/** What a call graph pass needs to know about one function. */
interface Shape {
  /** Synchronous, not a generator, and owns no closure environment: its
   * body can be copied into a caller. */
  inlinable: boolean;
  /** At most MAX_STATEMENTS statements and one loop. */
  bounded: boolean;
  /** Makes no call at all. */
  leaf: boolean;
  /** Every call is a direct `call` naming its callee. */
  directCalls: boolean;
  /** The functions the direct calls name. */
  calls: Set<string>;
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
 * A callee qualifies when it is a synchronous, non-generator function with
 * no captures, has at most MAX_STATEMENTS statements and one loop, and has
 * one to MAX_CALL_SITES direct call sites in the module, each inside a loop
 * body of its caller. The emitter marks those calls `alwaysinline`.
 * Functions the module exports as a library keep the cost model's decision.
 *
 * A callee need not be a leaf: a small wrapper whose every call is a direct
 * call of another such body qualifies too — a writer whose `base` appends a
 * byte through `put` — as long as the chain bottoms out in leaves and runs
 * no deeper than MAX_INLINE_DEPTH. The calls inside an inlined callee's body
 * ride along with it, and so does every call of a body those calls reach, so
 * each is marked where its own body is emitted: the loop then holds the whole
 * chain and keeps no per-element call. A function joins only once everything
 * it calls has, so a recursive one never does. */
export function findLoopCallees(mod: IrModule): LoopInlining {
  if (mod.lib !== undefined) return NOTHING_INLINED;
  const shapes = new Map<string, Shape>();
  for (const fn of mod.functions) {
    let statements = 0;
    let loops = 0;
    let leaf = true;
    let directCalls = true;
    const calls = new Set<string>();
    const expr = (e: IrExpr): boolean => {
      if (CALLS.has(e.kind)) {
        leaf = false;
        if (e.kind === "call") calls.add(e.callee);
        else directCalls = false;
      }
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      statements++;
      if (isLoop(s)) loops++;
      return statements <= MAX_STATEMENTS && loops <= 1 && everyStmtChild(s, expr, stmt);
    };
    fn.body.every(stmt);
    shapes.set(fn.name, {
      inlinable:
        !fn.async && !fn.generator && fn.captures === undefined && fn.classCaptures === undefined,
      bounded: statements <= MAX_STATEMENTS && loops <= 1,
      leaf,
      directCalls,
      calls,
    });
  }
  // Bodies a loop may hold: leaves first, then each small function whose
  // every call is a direct call of one of them. A function that calls
  // itself joins only once it is a member, so neither recursion nor mutual
  // recursion ever does.
  const bodies = new Set<string>();
  for (const [name, shape] of shapes)
    if (shape.inlinable && shape.bounded && shape.leaf) bodies.add(name);
  for (let depth = 1; depth < MAX_INLINE_DEPTH; depth++) {
    const added: string[] = [];
    for (const [name, shape] of shapes) {
      if (bodies.has(name)) continue;
      if (!shape.inlinable || !shape.bounded || !shape.directCalls) continue;
      if (shape.leaf || shape.calls.size === 0) continue;
      let onlyBodies = true;
      for (const callee of shape.calls) if (!bodies.has(callee)) onlyBodies = false;
      if (onlyBodies) added.push(name);
    }
    if (added.length === 0) break;
    for (const name of added) bodies.add(name);
  }
  if (bodies.size === 0) return NOTHING_INLINED;
  // Call sites of each candidate, and whether every one is inside a loop.
  const sites = new Map<string, { count: number; inLoops: boolean }>();
  for (const fn of mod.functions) {
    let depth = 0;
    const expr = (e: IrExpr): boolean => {
      if (e.kind === "call" && bodies.has(e.callee)) {
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
  const callees = new Set<string>();
  for (const [name, site] of sites)
    if (site.inLoops && site.count >= 1 && site.count <= MAX_CALL_SITES) callees.add(name);
  // Every body an inlined callee reaches through other inlined bodies goes
  // into the loop with it, so each of their calls is marked where that body
  // is emitted: the whole chain inlines, not just the outer wrapper's calls.
  const inlined = new Set<string>(callees);
  const pending = [...callees];
  while (pending.length > 0) {
    for (const callee of shapes.get(pending.pop()!)!.calls) {
      if (!bodies.has(callee) || inlined.has(callee)) continue;
      inlined.add(callee);
      pending.push(callee);
    }
  }
  const bodyCalls = new Map<string, ReadonlySet<string>>();
  for (const name of inlined) {
    const called = new Set<string>();
    for (const callee of shapes.get(name)!.calls) if (bodies.has(callee)) called.add(callee);
    if (called.size > 0) bodyCalls.set(name, called);
  }
  return { callees, bodyCalls };
}
