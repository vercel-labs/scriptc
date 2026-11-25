import { isStableReceiverOperand } from "../../ir/analysis.js";
import { isRefCounted, type IrExpr, type IrStmt } from "../../ir/ir.js";
import type { LlvmEmitterContext, LlValue } from "./expr-context.js";

/** The value of a sequence whose statements are only throwing guards over
 * scalar conditions: `if (cond) throw` with no else, where the throw is the
 * runtime's coded Node error (a derived constructor's `this` before super()
 * lowers to exactly this). Such guards read no reference and replace no
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

/** A sequence that stabilizes one read in a local it declares and then only
 * projects that local: `(const %propertyRecv = <read>; <checked projection of
 * %propertyRecv>)`, the form runtimeOptionalPropertyReceiver builds for a
 * receiver whose source cannot be written twice. The local is a stable
 * binding — declared once and never rewritten — so every read of it in the
 * projection names the value the statement stored, and the statement keeps
 * that value alive for the whole scope whether it took a reference for it or
 * lent one. The projection therefore borrows it, exactly as
 * `const p = <read>; p` does. Null for any other sequence. */
export function stabilizedValue(
  host: LlvmEmitterContext,
  e: IrExpr,
): { readonly init: IrExpr; readonly localId: string } | null {
  if (e.kind !== "seqExpr") return null;
  const [only] = e.stmts;
  if (e.stmts.length !== 1 || only?.kind !== "varDecl" || only.init === null) return null;
  const init = only.init;
  if (!isRefCounted(init.type) || !host.stableCallBindings.has(only.localId)) return null;
  if (!projectsLocal(host, e.result, only.localId)) return null;
  return { init, localId: only.localId };
}

/** Whether `e` reads the reference local `localId` and nothing else as a
 * reference: a checked projection of it (its narrowing, casts and the
 * throwing guards around them), with scalar conditions computing the way. */
function projectsLocal(host: LlvmEmitterContext, e: IrExpr, localId: string): boolean {
  switch (e.kind) {
    case "varRef":
      return e.localId === localId;
    case "unionNarrow":
    case "downcast":
    case "upcast":
      return projectsLocal(host, e.value, localId);
    case "ternary":
      return (
        scalarComputation(host, e.cond) &&
        projectsLocal(host, e.then, localId) &&
        projectsLocal(host, e.else_, localId)
      );
    case "libCall":
      return e.fn === "error.nodeThrow";
    case "seqExpr": {
      const guarded = guardedValue(e);
      return guarded !== null && projectsLocal(host, guarded, localId);
    }
    default:
      return false;
  }
}

function scalarGuardCondition(e: IrExpr): boolean {
  switch (e.kind) {
    case "boolLit":
    case "varRef":
      return !isRefCounted(e.type);
    case "unary":
      return scalarGuardCondition(e.operand);
    default:
      return false;
  }
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
