import { isStableReceiverOperand } from "../../ir/analysis.js";
import { isRefCounted, type IrExpr, type IrStmt } from "../../ir/ir.js";
import type { LlvmEmitterContext, LlValue } from "./expr-context.js";

/** The value of a sequence whose statements are only throwing guards over
 * scalar conditions: `if (cond) throw` with no else, where the throw is the
 * runtime's coded Node error (a derived constructor's `this` before super()
 * lowers to exactly this, and so does an asserted array element read's
 * presence test). Such guards read no reference and replace no
 * owner, so the sequence can be read wherever its result can: the guards
 * still run in place, and only the result is borrowed. Null otherwise. */
export function guardedValue(e: IrExpr): IrExpr | null {
  if (e.kind !== "seqExpr") return null;
  for (const s of e.stmts) {
    if (
      s.kind !== "if" ||
      s.else_ !== null ||
      isRefCounted(s.cond.type) ||
      !scalarGuardCondition(s.cond) ||
      s.then.length !== 1
    )
      return null;
    const only = s.then[0]!;
    if (
      only.kind !== "exprStmt" ||
      only.expr.kind !== "libCall" ||
      only.expr.fn !== "error.nodeThrow" ||
      !only.expr.args.every((arg) => arg.kind === "numLit" || arg.kind === "strLit")
    )
      return null;
  }
  return e.result;
}

function scalarGuardCondition(e: IrExpr): boolean {
  switch (e.kind) {
    case "boolLit":
    case "numLit":
    case "varRef":
      return !isRefCounted(e.type);
    case "unary":
      return scalarGuardCondition(e.operand);
    case "bin":
      return (
        (e.op === "===" || e.op === "!==") &&
        scalarGuardCondition(e.left) &&
        scalarGuardCondition(e.right)
      );
    // An asserted element read's presence test (`xs[i]!`): it reads the
    // slot's state without taking a reference.
    case "arrayState":
      return simpleRead(e.arr) && scalarGuardCondition(e.index);
    default:
      return false;
  }
}

/** A local, or a field read through a chain of fields of one. */
function simpleRead(e: IrExpr): boolean {
  return e.kind === "varRef" || (e.kind === "fieldGet" && simpleRead(e.obj));
}

function stableProjection(host: LlvmEmitterContext, e: IrExpr): boolean {
  switch (e.kind) {
    case "varRef":
    case "seqExpr":
      return host.canBorrowReceiver(e);
    case "unionNarrow":
    case "downcast":
    case "upcast":
      return stableProjection(host, e.value);
    case "fieldGet":
    case "recordGet":
      return stableProjection(host, e.obj);
    case "ternary":
      return (
        scalarComputation(host, e.cond) &&
        stableProjection(host, e.then) &&
        stableProjection(host, e.else_)
      );
    case "libCall":
      return e.fn === "error.nodeThrow";
    default:
      return false;
  }
}

/** Scalar field computations cannot replace any owner on the receiver's
 * projection path. Calls, reference writes, captures and suspension remain
 * on the owning path. A checked projection may throw at its original use. */
function scalarComputation(host: LlvmEmitterContext, e: IrExpr): boolean {
  if (isRefCounted(e.type)) return false;
  switch (e.kind) {
    case "numLit":
    case "boolLit":
    case "varRef":
      return true;
    case "bin":
      return scalarComputation(host, e.left) && scalarComputation(host, e.right);
    case "unary":
    case "toBool":
      return scalarComputation(host, e.operand);
    case "fieldGet":
    case "recordGet":
      return stableProjection(host, e.obj);
    case "unionIsTag":
      return stableProjection(host, e.value);
    case "libCall":
      return isStableReceiverOperand(e, "");
    default:
      return false;
  }
}

/** The lowering of a scalar compound field assignment snapshots a receiver,
 * the old field, the RHS and the result. Borrow that receiver only when the
 * entire sequence cannot invalidate its owner. Preserve all snapshots and
 * evaluation order; in particular an effectful RHS still owns the receiver. */
export function emitBorrowedFieldSequence(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "seqExpr" },
): LlValue | null {
  const first = e.stmts[0];
  if (
    first?.kind !== "varDecl" ||
    !first.init ||
    !isRefCounted(first.init.type) ||
    !host.canBorrowReceiver(first.init)
  )
    return null;
  const binding = host.binding(first.localId);
  if (binding.kind !== "local" || binding.local?.mutable || !scalarComputation(host, e.result))
    return null;
  const rest = e.stmts.slice(1);
  if (
    rest.length === 0 ||
    !rest.every((s: IrStmt) => {
      if (s.kind === "varDecl")
        return (
          s.init !== null &&
          !isRefCounted(host.binding(s.localId).type) &&
          scalarComputation(host, s.init)
        );
      return (
        (s.kind === "fieldSet" || s.kind === "recordSet") &&
        s.obj.kind === "varRef" &&
        s.obj.localId === first.localId &&
        scalarComputation(host, s.value)
      );
    })
  )
    return null;
  const receiver = host.emitReadReceiver(first.init);
  host.B.line(`store ptr ${receiver.name}, ptr ${binding.slot}`);
  for (const stmt of rest) host.emitStmt(stmt);
  return host.emitExpr(e.result);
}
