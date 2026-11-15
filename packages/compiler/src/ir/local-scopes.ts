/* Where a declared local may be named.
 *
 * Local ids are function-wide, but the value a `varDecl` gives a local is
 * owned by the region the declaration sits in, and the backend releases it
 * when that region ends:
 *
 *   - a declaration in a statement list: the list (a block, a branch, a loop
 *     body, the cases of a `switch`, a `for` with its initializer);
 *   - a declaration in a `seqExpr`'s statements (a hidden local of an
 *     expression): the expressions of the statement the sequence belongs to.
 *     The condition of an `if`, `while`, `do` or `for` is such a region of
 *     its own, which ends before the branch is taken; inside the arm of a
 *     lazy operator (`?:`, `&&`, `||`, `??`, an optional chain's body, a
 *     `switch` case test) the region is that arm, which may not run.
 *
 * A use after the region ended reads released storage when the local holds a
 * reference. `localScopeUses` reports each such use and the validator
 * rejects them; `ownEscapingLocals` is the lowering's one rule that keeps its
 * output inside these regions. */
import { isRefCounted } from "./ir.js";
import type { IrExpr, IrFunction, IrLocal, IrStmt, SrcLoc } from "./ir.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";

/** What ended a local's region before the use. */
export type LocalScopeEnd = "block" | "statement" | "condition" | "arm";

export interface LocalScopeUse {
  local: IrLocal;
  ended: LocalScopeEnd;
  /** The kind of the statement that owned the region. */
  owner: IrStmt["kind"];
  loc: SrcLoc;
}

const unreachable = (): boolean => true;

/** Every use of a local of `fn` after the region that owns its value ended.
 * Only locals that hold a reference count (a refcounted type, or a box
 * shared with closures); a scalar's slot is the function's. */
export function localScopeUses(fn: IrFunction): LocalScopeUse[] {
  const uses: LocalScopeUse[] = [];
  /** The locals whose region ended: what ended it, and its statement. */
  const ended = new Map<string, LocalScopeEnd>();
  const owners = new Map<string, IrStmt["kind"]>();
  // The locals of the open regions, innermost last, and where each open
  // region starts: `blocks` for statement lists, `frames` for expression
  // regions (a statement's own expressions, or a lazy arm).
  const blocks: string[] = [];
  const frames: string[] = [];
  const frameStarts: number[] = [];
  const statements: IrStmt[] = [];

  const end = (region: string[], start: number, how: LocalScopeEnd, owner: IrStmt): void => {
    for (let i = start; i < region.length; i++) {
      ended.set(region[i]!, how);
      owners.set(region[i]!, owner.kind);
    }
    region.length = start;
  };
  const declare = (localId: string, region: string[]): void => {
    region.push(localId);
    if (ended.size > 0) ended.delete(localId);
  };
  const use = (localId: string, loc: SrcLoc): void => {
    if (ended.size === 0) return;
    const how = ended.get(localId);
    if (how === undefined) return;
    const local = fn.locals.find((l) => l.id === localId);
    if (local === undefined || (local.boxed !== true && !isRefCounted(local.type))) return;
    uses.push({ local, ended: how, owner: owners.get(localId)!, loc });
  };

  const arm = (e: IrExpr): void => {
    const start = frames.length;
    frameStarts.push(start);
    expr(e);
    frameStarts.pop();
    if (frames.length > start) end(frames, start, "arm", statements[statements.length - 1]!);
  };
  const expr = (e: IrExpr): boolean => {
    switch (e.kind) {
      case "varRef":
      case "incDec":
        use(e.localId, e.loc);
        return true;
      case "assignExpr":
        use(e.localId, e.loc);
        return expr(e.value);
      case "closure":
        for (let i = 0; i < e.captures.length; i++) use(e.captures[i]!, e.loc);
        return true;
      case "classRef":
        if (e.captures !== undefined)
          for (let i = 0; i < e.captures.length; i++) use(e.captures[i]!, e.loc);
        return true;
      case "seqExpr":
        for (let i = 0; i < e.stmts.length; i++) stmt(e.stmts[i]!, true);
        return expr(e.result);
      case "ternary":
        expr(e.cond);
        arm(e.then);
        arm(e.else_);
        return true;
      case "logical":
      case "nullish":
      case "orDefault":
        expr(e.left);
        arm(e.right);
        return true;
      case "optChain":
        expr(e.receiver);
        arm(e.body);
        return true;
      default:
        return everyExprChild(e, expr, unreachable);
    }
  };

  const block = (body: IrStmt[], owner: IrStmt, bound: string | null): void => {
    const start = blocks.length;
    if (bound !== null) declare(bound, blocks);
    for (let i = 0; i < body.length; i++) stmt(body[i]!, false);
    if (blocks.length > start) end(blocks, start, "block", owner);
  };
  /** The condition of `s` is evaluated: its region ends before the branch. */
  const condition = (s: IrStmt): void => {
    const start = frameStarts[frameStarts.length - 1]!;
    if (frames.length > start) end(frames, start, "condition", s);
  };
  /** `sequence`: `s` is a statement of a `seqExpr`, whose declarations
   * belong to the expression region around the sequence. */
  const stmt = (s: IrStmt, sequence: boolean): boolean => {
    const start = frames.length;
    frameStarts.push(start);
    statements.push(s);
    switch (s.kind) {
      case "varDecl":
        if (s.init !== null) expr(s.init);
        break;
      case "assign":
        use(s.localId, s.loc);
        expr(s.value);
        break;
      case "rethrow":
        use(s.localId, s.loc);
        break;
      case "block":
        block(s.body, s, null);
        break;
      case "if":
        expr(s.cond);
        condition(s);
        block(s.then, s, null);
        if (s.else_ !== null) block(s.else_, s, null);
        break;
      case "while":
        expr(s.cond);
        condition(s);
        block(s.body, s, null);
        break;
      case "doWhile": {
        // The body runs again after the condition: what the condition
        // declares has ended when the body's second pass reads it.
        const reported = uses.length;
        expr(s.cond);
        uses.length = reported;
        condition(s);
        block(s.body, s, null);
        expr(s.cond);
        condition(s);
        break;
      }
      case "for": {
        const loop = blocks.length;
        // Several initializers come as a block whose declarations are the
        // loop's own.
        if (s.init !== null) {
          if (s.init.kind === "block")
            for (let i = 0; i < s.init.body.length; i++) stmt(s.init.body[i]!, false);
          else stmt(s.init, false);
        }
        if (s.cond !== null) {
          expr(s.cond);
          condition(s);
        }
        block(s.body, s, null);
        if (s.update !== null) stmt(s.update, false);
        if (blocks.length > loop) end(blocks, loop, "block", s);
        break;
      }
      case "forOf":
        expr(s.iterable);
        block(s.body, s, s.localId);
        break;
      case "switch": {
        expr(s.disc);
        for (let i = 0; i < s.cases.length; i++) {
          const test = s.cases[i]!.test;
          if (test !== null) arm(test);
        }
        const cases = blocks.length;
        for (let i = 0; i < s.cases.length; i++) {
          const body = s.cases[i]!.body;
          for (let j = 0; j < body.length; j++) stmt(body[j]!, false);
        }
        if (blocks.length > cases) end(blocks, cases, "block", s);
        break;
      }
      case "tryCatch":
        block(s.tryBody, s, null);
        if (s.catchBody !== null) block(s.catchBody, s, s.catchLocalId);
        if (s.finallyBody !== null) block(s.finallyBody, s, null);
        break;
      default:
        everyStmtChild(s, expr, unreachable);
    }
    statements.pop();
    frameStarts.pop();
    if (frames.length > start) end(frames, start, "statement", s);
    // The declaration takes effect after its initializer: in a sequence the
    // region around the sequence owns it, which is the innermost open one
    // now that the statement's own region has ended.
    if (s.kind === "varDecl") declare(s.localId, sequence ? frames : blocks);
    return true;
  };

  frameStarts.push(0);
  for (let i = 0; i < fn.body.length; i++) stmt(fn.body[i]!, false);
  return uses;
}

/** The lowering's rule for a hidden local that outlives the expression that
 * declares it (a narrowed operand a condition saved and a branch reads
 * again): the statement list around the expression's statement owns it. The
 * list declares the local empty before that statement and the sequence
 * assigns it, so the value lives until the list's scope ends, on every exit
 * the backend already handles for a declared local. A local that is still
 * used after that list (the list is a branch, the use follows the `if`)
 * moves out one list at a time. Rewrites `fn` in place; answers whether it
 * changed. Functions whose locals stay inside their regions are not touched.
 *
 * A local declared by a statement list itself and used after the list is not
 * a hidden local of an expression; it is left for the validator to report. */
export function ownEscapingLocals(fn: IrFunction): boolean {
  let uses = localScopeUses(fn);
  if (uses.length === 0) return false;
  const moved = new Set<string>();
  for (;;) {
    const escaping = new Set<string>();
    for (const u of uses)
      if (u.ended !== "block" || moved.has(u.local.id)) escaping.add(u.local.id);
    if (escaping.size === 0) break;
    const relocated = relocate(fn.body, escaping);
    if (relocated.size === 0) break;
    for (const id of relocated) moved.add(id);
    for (const local of fn.locals) if (relocated.has(local.id)) local.mutable = true;
    uses = localScopeUses(fn);
  }
  return moved.size > 0;
}

/** Moves the declaration of each local of `ids` to the statement list around
 * it: a declaration in a sequence becomes an assignment there, and one a
 * list already owns leaves for the next list out. Answers the locals it
 * moved. */
function relocate(top: IrStmt[], ids: ReadonlySet<string>): Set<string> {
  const relocated = new Set<string>();
  /** The locals to declare before the statement of the innermost statement
   * list that is being walked. */
  let found: string[] = [];

  const expr = (e: IrExpr): boolean => {
    if (e.kind !== "seqExpr") return everyExprChild(e, expr, unreachable);
    for (let i = 0; i < e.stmts.length; i++) {
      const s = e.stmts[i]!;
      if (s.kind === "varDecl" && ids.has(s.localId)) {
        found.push(s.localId);
        if (s.init === null) {
          e.stmts.splice(i--, 1);
          continue;
        }
        e.stmts[i] = { kind: "assign", localId: s.localId, value: s.init, loc: s.loc };
      }
      statement(e.stmts[i]!);
    }
    return expr(e.result);
  };
  const list = (body: IrStmt[], outermost: boolean): void => {
    const outer = found;
    for (let i = 0; i < body.length; i++) {
      const s = body[i]!;
      if (!outermost && s.kind === "varDecl" && s.init === null && ids.has(s.localId)) {
        body.splice(i--, 1);
        outer.push(s.localId);
        continue;
      }
      found = [];
      statement(s);
      for (const localId of found) {
        // One declaration per local: a second sequence that declared it
        // assigns the same local, and the next round moves the declaration
        // out if that assignment lies outside this list.
        if (relocated.has(localId)) continue;
        relocated.add(localId);
        body.splice(i++, 0, { kind: "varDecl", localId, init: null, loc: s.loc });
      }
    }
    found = outer;
  };
  const statement = (s: IrStmt): boolean => {
    switch (s.kind) {
      case "block":
        list(s.body, false);
        break;
      case "if":
        expr(s.cond);
        list(s.then, false);
        if (s.else_ !== null) list(s.else_, false);
        break;
      case "while":
        expr(s.cond);
        list(s.body, false);
        break;
      case "doWhile":
        list(s.body, false);
        expr(s.cond);
        break;
      case "for":
        if (s.init !== null) {
          if (s.init.kind === "block") for (const inner of s.init.body) statement(inner);
          else statement(s.init);
        }
        if (s.cond !== null) expr(s.cond);
        if (s.update !== null) statement(s.update);
        list(s.body, false);
        break;
      case "forOf":
        expr(s.iterable);
        list(s.body, false);
        break;
      case "switch":
        // The cases share one scope that control enters at any case: a
        // declaration belongs before the switch, not inside a case.
        expr(s.disc);
        for (const c of s.cases) {
          if (c.test !== null) expr(c.test);
          for (const inner of c.body) statement(inner);
        }
        break;
      case "tryCatch":
        list(s.tryBody, false);
        if (s.catchBody !== null) list(s.catchBody, false);
        if (s.finallyBody !== null) list(s.finallyBody, false);
        break;
      default:
        everyStmtChild(s, expr, unreachable);
    }
    return true;
  };
  list(top, true);
  return relocated;
}
