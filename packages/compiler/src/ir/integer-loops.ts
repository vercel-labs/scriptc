import type { IrExpr, IrLocal, IrStmt } from "./ir.js";

/** A canonical byte loop whose induction variable is mathematically an
 * unsigned integer for every body entry. Backends may keep this binding in
 * integer storage while the loop runs, converting to f64 at ordinary JS
 * number uses and using the integer directly for typed-array indices. */
export interface IntegerBytesForLoop {
  localId: string;
  limitReceiver: IrExpr;
}

/** True when a lowered subtree writes `localId`. Local ids are unique per
 * function, so a generic structured walk is sufficient and includes writes
 * nested in expressions, branches, nested loops, and try/finally bodies. */
function writesLocal(value: unknown, localId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => writesLocal(item, localId));
  if (value === null || typeof value !== "object") return false;
  const node = value as { kind?: unknown; localId?: unknown };
  if (
    (node.kind === "assign" || node.kind === "assignExpr" || node.kind === "incDec") &&
    node.localId === localId
  ) {
    return true;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "type" || key === "loc") continue;
    if (writesLocal(child, localId)) return true;
  }
  return false;
}

function isUnitIncrement(update: IrStmt | null, localId: string): boolean {
  // The frontend normally lowers `i++` to `i = i + 1` before backend
  // emission. Accept the incDec form too so this analysis remains valid for
  // hand-built IR and if normalization is moved later in the pipeline.
  if (update?.kind === "exprStmt") {
    return (
      update.expr.kind === "incDec" &&
      update.expr.localId === localId &&
      update.expr.op === "+"
    );
  }
  return (
    update?.kind === "assign" &&
    update.localId === localId &&
    update.value.kind === "bin" &&
    update.value.op === "+" &&
    update.value.left.kind === "varRef" &&
    update.value.left.localId === localId &&
    update.value.right.kind === "numLit" &&
    update.value.right.value === 1
  );
}

/** Recognize the deliberately small, semantics-transparent first tier of
 * integer induction:
 *
 *   for (let i = 0; i < bytes.length; i++) { ... }
 *
 * The binding must be an unboxed mutable f64 local and the body must not
 * write it. The exact zero start plus unit increment and ScrBytes' fixed,
 * safe-integer length prove every body value is an exactly representable
 * non-negative integer. A captured loop binding is boxed and therefore
 * refused (per-iteration binding identity remains on the generic path).
 */
export function matchIntegerBytesForLoop(
  stmt: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
): IntegerBytesForLoop | null {
  const init = stmt.init;
  if (
    init?.kind !== "varDecl" ||
    init.init?.kind !== "numLit" ||
    init.init.value !== 0 ||
    Object.is(init.init.value, -0)
  ) {
    return null;
  }
  const local = locals.get(init.localId);
  if (local?.type.kind !== "f64" || !local.mutable || local.boxed === true) return null;

  const cond = stmt.cond;
  if (
    cond?.kind !== "bin" ||
    cond.op !== "<" ||
    cond.left.kind !== "varRef" ||
    cond.left.localId !== init.localId ||
    cond.right.kind !== "bytesIntrinsic" ||
    cond.right.method !== "length" ||
    cond.right.receiver.kind !== "varRef" ||
    cond.right.receiver.type.kind !== "bytes"
  ) {
    return null;
  }
  const receiverLocal = locals.get(cond.right.receiver.localId);
  if (receiverLocal?.boxed === true) return null;

  if (!isUnitIncrement(stmt.update, init.localId)) return null;
  if (writesLocal(stmt.body, init.localId)) return null;

  return { localId: init.localId, limitReceiver: cond.right.receiver };
}
