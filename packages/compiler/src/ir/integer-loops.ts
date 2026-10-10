import type { IrExpr, IrLocal, IrStmt } from "./ir.js";
import type { IntegerRange, IntegerRanges } from "./integer-ranges.js";

import { everyExprChild, everyStmtChild, everyStmtList } from "./traverse.js";
import { byteNumberAccess } from "./byte-numbers.js";

/** A canonical byte loop whose induction variable is mathematically an
 * unsigned integer for every body entry. Backends may keep this binding in
 * integer storage while the loop runs, converting to f64 at ordinary JS
 * number uses and using the integer directly for typed-array indices. */
export interface IntegerBytesForLoop {
  localId: string;
  limitReceiver: IrExpr;
}

export interface IntegerCountedForLoop {
  localId: string;
  start: IrExpr;
  limit: IrExpr;
  step: number;
  inclusive: boolean;
  guarded: boolean;
  /** The limit needs the run-time `guardLimit` test (part of `guarded`). */
  limitGuarded: boolean;
  /** The start has no proven integer range: the versioned loop also tests
   * that it is an exact integer (not -0) of at most 2^53 in magnitude. */
  startGuarded: boolean;
  guardLimit: number;
  range: IntegerRange;
}

function constantStep(update: IrStmt | null, id: string): number | null {
  if (update?.kind === "exprStmt" && update.expr.kind === "incDec" && update.expr.localId === id)
    return update.expr.op === "+" ? 1 : -1;
  if (
    update?.kind !== "assign" ||
    update.localId !== id ||
    update.value.kind !== "bin" ||
    update.value.left.kind !== "varRef" ||
    update.value.left.localId !== id ||
    update.value.right.kind !== "numLit"
  )
    return null;
  const value = update.value.right.value;
  const step = update.value.op === "+" ? value : update.value.op === "-" ? -value : 0;
  return Number.isSafeInteger(step) && step !== 0 && Math.abs(step) <= 2147483647 ? step : null;
}

/** Pure initial values may be evaluated again on a fallback path. Bounds
 * additionally have to remain invariant throughout the loop. Array length
 * is allowed only in the initializer; its mutable value is never hoisted
 * from a condition. Typed-array lengths are fixed for a given receiver. */
function stableLoopValue(
  value: IrExpr,
  locals: ReadonlyMap<string, IrLocal>,
  body: IrStmt[],
  invariant: boolean,
  counter: string,
): boolean {
  switch (value.kind) {
    case "numLit":
      return true;
    case "varRef": {
      const local = locals.get(value.localId);
      return (
        value.localId !== counter &&
        local !== undefined &&
        !local.boxed &&
        !local.tdz &&
        (!invariant || !writesLocal(body, value.localId))
      );
    }
    case "bin":
      return (
        (value.op === "+" ||
          value.op === "-" ||
          value.op === "&" ||
          value.op === ">>>" ||
          value.op === "|") &&
        stableLoopValue(value.left, locals, body, invariant, counter) &&
        stableLoopValue(value.right, locals, body, invariant, counter)
      );
    case "bytesIntrinsic":
    case "arrIntrinsic":
      return (
        (value.method === "length" ||
          (value.kind === "bytesIntrinsic" && value.method === "byteLength")) &&
        (value.kind === "bytesIntrinsic" || !invariant) &&
        value.receiver.kind === "varRef" &&
        stableLoopValue(value.receiver, locals, body, invariant, counter)
      );
    default:
      return false;
  }
}

/** Normalize finite loop progress into signed i64 storage. Unknown limits
 * are guarded before versioning small innermost loops; proven bounds need
 * no duplicate body. Every body entry must remain exactly representable.
 * A final update may round beyond the limit: the scoped counter cannot be
 * observed after that update, and both representations exit the loop. */
export function matchIntegerCountedForLoop(
  stmt: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
  ranges: IntegerRanges = new Map(),
): IntegerCountedForLoop | null {
  const init = stmt.init;
  if (init?.kind !== "varDecl" || !init.init) return null;
  const local = locals.get(init.localId);
  if (local?.type.kind !== "f64" || !local.mutable || local.boxed || local.tdz) return null;
  const start = init.init;
  let startRange =
    start.kind === "numLit" && Number.isSafeInteger(start.value) && !Object.is(start.value, -0)
      ? { min: start.value, max: start.value }
      : ranges.get(start);
  // An unproven start is tested at run time, on a versioned loop.
  const startGuarded = !startRange && start.kind !== "numLit" && start.type.kind === "f64";
  if (startGuarded) startRange = { min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
  if (
    !startRange ||
    startRange.min < -Number.MAX_SAFE_INTEGER ||
    startRange.max > Number.MAX_SAFE_INTEGER ||
    !stableLoopValue(start, locals, stmt.body, false, local.id)
  )
    return null;
  const step = constantStep(stmt.update, local.id);
  if (step === null || writesLocal(stmt.body, local.id)) return null;
  const cond = stmt.cond;
  if (cond?.kind !== "bin") return null;
  let limit = cond.right,
    op: string = cond.op;
  if (cond.left.kind !== "varRef" || cond.left.localId !== local.id) {
    if (cond.right.kind !== "varRef" || cond.right.localId !== local.id) return null;
    limit = cond.left;
    op = ({ "<": ">", "<=": ">=", ">": "<", ">=": "<=" } as Record<string, string>)[op] ?? "";
  }
  if (step > 0 ? op !== "<" && op !== "<=" : op !== ">" && op !== ">=") return null;
  if (!stableLoopValue(limit, locals, stmt.body, true, local.id)) return null;
  const inclusive = op === "<=" || op === ">=";
  const guardLimit = step > 0 ? 2 ** 53 - (inclusive ? 1 : 0) : -(2 ** 53) + (inclusive ? 1 : 0);
  const boundRange =
    limit.kind === "numLit" ? { min: limit.value, max: limit.value } : ranges.get(limit);
  const limitGuarded =
    !boundRange || (step > 0 ? !(boundRange.max <= guardLimit) : !(boundRange.min >= guardLimit));
  if (limitGuarded && limit.kind === "numLit") return null;
  const guarded = limitGuarded || startGuarded;
  let useful = false;
  let cost = 0;
  const counter = (e: IrExpr): boolean =>
    (e.kind === "varRef" && e.localId === local.id) ||
    (e.kind === "bin" &&
      (e.op === "+" || e.op === "-" || e.op === "*") &&
      (counter(e.left) || counter(e.right)));
  const expr = (e: IrExpr): boolean => {
    if (
      e.kind === "bin" &&
      (((e.op === "&" ||
        e.op === "|" ||
        e.op === "^" ||
        e.op === "<<" ||
        e.op === ">>" ||
        e.op === ">>>") &&
        (counter(e.left) || counter(e.right))) ||
        (e.op === "%" && counter(e.left)))
    )
      useful = true;
    if (e.kind === "bytesIntrinsic") {
      const numeric = byteNumberAccess(e);
      const offset = e.args[numeric ? numeric.offsetArg : 0];
      if ((numeric || e.method === "get") && offset && counter(offset)) useful = true;
    }
    if (
      e.kind === "libCall" &&
      (e.fn === "math.imul" || e.fn === "math.clz32") &&
      e.args.some(counter)
    )
      useful = true;
    return (!guarded || ++cost <= 80) && everyExprChild(e, expr, bodyStmt);
  };
  const bodyStmt = (s: IrStmt): boolean => {
    if (s.kind === "bytesSet" && counter(s.index)) useful = true;
    if (
      guarded &&
      (s.kind === "for" || s.kind === "forOf" || s.kind === "while" || s.kind === "doWhile")
    )
      return false;
    return (!guarded || ++cost <= 80) && everyStmtChild(s, expr, bodyStmt);
  };
  if (!stmt.body.every(bodyStmt) || !useful) return null;
  const range =
    step > 0
      ? {
          min: startRange.min,
          max: Math.max(
            startRange.min,
            Math.min(
              Number.MAX_SAFE_INTEGER,
              boundRange
                ? Math.ceil(boundRange.max) - (inclusive ? 0 : 1)
                : Number.MAX_SAFE_INTEGER,
            ),
          ),
        }
      : {
          min: Math.min(
            startRange.max,
            Math.max(
              -Number.MAX_SAFE_INTEGER,
              boundRange
                ? Math.floor(boundRange.min) + (inclusive ? 0 : 1)
                : -Number.MAX_SAFE_INTEGER,
            ),
          ),
          max: startRange.max,
        };
  return {
    localId: local.id,
    start,
    limit,
    step,
    inclusive,
    guarded,
    limitGuarded,
    startGuarded,
    guardLimit,
    range,
  };
}

/** True when a lowered subtree writes `localId`. Local ids are unique per
 * function, so typed traversal includes writes
 * nested in expressions, branches, nested loops, and try/finally bodies. */
function writesLocal(body: IrStmt[], localId: string): boolean {
  return !everyStmtList(body, {
    expr: (expr) =>
      (expr.kind !== "assignExpr" && expr.kind !== "incDec") || expr.localId !== localId,
    stmt: (stmt) => stmt.kind !== "assign" || stmt.localId !== localId,
  });
}

function isUnitIncrement(update: IrStmt | null, localId: string): boolean {
  // The frontend normally lowers `i++` to `i = i + 1` before backend
  // emission. Accept the incDec form too so this analysis remains valid for
  // hand-built IR and if normalization is moved later in the pipeline.
  if (update?.kind === "exprStmt") {
    return (
      update.expr.kind === "incDec" && update.expr.localId === localId && update.expr.op === "+"
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

/** Array lengths are uint32, so zero-based loops and nested `j = i + 1`
 * loops have exact integer induction even when the body changes length.
 * Only active array induction bindings may seed a nested loop. Their body
 * values are at most 2^32 - 2, making the increment safe on 32-bit targets. */
export function matchIntegerArrayForLoop(
  stmt: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
  outer: ReadonlySet<string>,
): IntegerBytesForLoop | null {
  const init = stmt.init;
  if (init?.kind !== "varDecl" || !init.init) return null;
  const start = init.init;
  const zero = start.kind === "numLit" && start.value === 0 && !Object.is(start.value, -0);
  const nested =
    start.kind === "bin" &&
    start.op === "+" &&
    start.left.kind === "varRef" &&
    outer.has(start.left.localId) &&
    start.right.kind === "numLit" &&
    start.right.value === 1;
  const local = locals.get(init.localId);
  if (
    (!zero && !nested) ||
    local?.type.kind !== "f64" ||
    !local.mutable ||
    local.boxed ||
    local.tdz
  )
    return null;
  const cond = stmt.cond;
  if (
    cond?.kind !== "bin" ||
    cond.op !== "<" ||
    cond.left.kind !== "varRef" ||
    cond.left.localId !== local.id ||
    cond.right.kind !== "arrIntrinsic" ||
    cond.right.method !== "length" ||
    cond.right.receiver.kind !== "varRef" ||
    cond.right.receiver.type.kind !== "array" ||
    locals.get(cond.right.receiver.localId)?.boxed ||
    !isUnitIncrement(stmt.update, local.id) ||
    writesLocal(stmt.body, local.id)
  )
    return null;
  return { localId: local.id, limitReceiver: cond.right.receiver };
}
