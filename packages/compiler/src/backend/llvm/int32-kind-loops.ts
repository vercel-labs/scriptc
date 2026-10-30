import type { IrExpr, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { MAX_LOOP_NODES, SIMPLE_STATEMENTS } from "./speculative-integers.js";

/** Int32 kind loops.
 *
 * An int32 array with checked stores (ir/int32-slots.ts) holds int32 slots
 * (or doubles, when its fill was short) until a store of a value that is
 * not an int32 widens it to doubles in place, so an access to it tests its
 * element kind first (LlEmitter.emitByElementKind). An innermost loop that
 * accesses such arrays tests their kinds once on entry instead
 * (emitLoopCopies). The fast copy runs when every one of them holds int32
 * slots and reads and writes them as int32 arrays; the wide copy runs when
 * every one holds doubles and accesses them as double arrays; a loop over
 * several arrays whose kinds differ runs the mixed copy, which tests the
 * kinds at each access. A store of the fast copy whose value is not an
 * int32 branches to the same statement in a third copy, which re-executes
 * it with kind tests (widening the array) and finishes the iteration, then
 * enters the mixed copy, or the wide copy when the loop has one array.
 * Re-execution is exact because such a store's statement evaluates nothing
 * but locals, literals, number arithmetic and element reads before it
 * writes.
 *
 * Nothing else can widen these arrays: they never reach code other than
 * the compiled element operations of their own function
 * (ir/int32-arrays.ts). */
export interface Int32KindLoopPlan {
  /** The arrays the fast copy reads and writes as int32 arrays, by local,
   * with one of their references in the loop. */
  arrays: Map<string, IrExpr>;
  /** Element writes and pushes whose value may not be an int32: the
   * statements the fast copy may leave at. */
  writes: Set<IrStmt>;
}

type KindLoop = Extract<IrStmt, { kind: "for" | "while" | "doWhile" }>;

/** A number or boolean expression whose evaluation has no effect: locals,
 * literals, arithmetic, comparisons and element reads of local arrays. */
function isPure(e: IrExpr): boolean {
  if (e.type.kind !== "f64" && e.type.kind !== "bool") return false;
  switch (e.kind) {
    case "numLit":
    case "boolLit":
    case "varRef":
      return true;
    case "bin":
      return (
        (e.left.type.kind === "f64" || e.left.type.kind === "bool") &&
        isPure(e.left) &&
        isPure(e.right)
      );
    case "unary":
      return isPure(e.operand);
    case "ternary":
      return isPure(e.cond) && isPure(e.then) && isPure(e.else_);
    case "arrayGet":
    case "arrayHas":
      return e.arr.kind === "varRef" && isPure(e.index);
    case "arrIntrinsic":
      return e.method === "getNumber" && e.receiver.kind === "varRef" && isPure(e.args[0]!);
    default:
      return false;
  }
}

/** The plan for `loop`, or null. `checked` names the int32 array locals
 * with checked stores of the function; `provenInt32` the values the static
 * range analysis proves int32s (stores that never leave the fast copy). */
export function planInt32KindLoop(
  loop: KindLoop,
  checked: (localId: string) => boolean,
  provenInt32: (e: IrExpr) => boolean,
): Int32KindLoopPlan | null {
  const arrays = new Map<string, IrExpr>();
  const writes = new Set<IrStmt>();
  const assigned = new Set<string>();
  let nodes = 0;
  let rejected = false;
  const reject = (): false => {
    rejected = true;
    return false;
  };
  const array = (e: IrExpr): string | null =>
    e.kind === "varRef" && checked(e.localId) ? e.localId : null;
  const push = (e: IrExpr): (IrExpr & { kind: "arrIntrinsic" }) | null =>
    e.kind === "arrIntrinsic" && e.method === "push" && array(e.receiver) !== null ? e : null;

  const expr = (e: IrExpr): boolean => {
    if (rejected) return false;
    nodes++;
    if (e.kind === "varRef" && checked(e.localId) && !arrays.has(e.localId))
      arrays.set(e.localId, e);
    // A push the statement walk did not take as a write: its values must
    // be proven int32s, since it cannot leave the fast copy.
    const pushed = push(e);
    if (pushed && !pushed.args.every(provenInt32)) return reject();
    return everyExprChild(e, expr, nested);
  };
  // Statements inside expressions run mid-expression, where the fast copy
  // cannot leave: they may not write these arrays.
  const nested = (s: IrStmt): boolean => {
    nodes++;
    if (s.kind === "assign" || s.kind === "varDecl") assigned.add(s.localId);
    if (s.kind === "arraySet" && array(s.arr) !== null && !provenInt32(s.value)) return reject();
    return everyStmtChild(s, expr, nested);
  };
  const stmt = (s: IrStmt): boolean => {
    if (rejected) return false;
    nodes++;
    if (!SIMPLE_STATEMENTS.has(s.kind)) return reject();
    if (s.kind === "assign" || s.kind === "varDecl") assigned.add(s.localId);
    if (s.kind === "arraySet" && array(s.arr) !== null && !provenInt32(s.value)) {
      if (!isPure(s.index) || !isPure(s.value)) return reject();
      writes.add(s);
      return everyStmtChild(s, expr, stmt);
    }
    const pushed = s.kind === "exprStmt" ? push(s.expr) : null;
    if (pushed && !pushed.args.every(provenInt32)) {
      if (!pushed.args.every(isPure)) return reject();
      writes.add(s);
      expr(pushed.receiver);
      pushed.args.forEach(expr);
      return !rejected;
    }
    return everyStmtChild(s, expr, stmt);
  };

  if (loop.cond) expr(loop.cond);
  if (loop.kind === "for" && loop.update) stmt(loop.update);
  for (const s of loop.body) stmt(s);
  if (rejected || nodes > MAX_LOOP_NODES || arrays.size === 0) return null;
  // A loop that rebinds one of the arrays could reach another array of
  // either kind.
  for (const id of arrays.keys()) if (assigned.has(id)) return null;
  return { arrays, writes };
}
