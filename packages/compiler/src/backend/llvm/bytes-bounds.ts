import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import type { IntegerRanges } from "../../ir/integer-ranges.js";
import { integerArithmeticRange, type IntegerRange } from "../../ir/integer-ranges.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "../../ir/traverse.js";
import { isStableReceiverOperand } from "../../ir/analysis.js";
import { byteNumberAccess } from "../../ir/byte-numbers.js";

interface Extent {
  receiver: string;
  offset: number;
}
interface Bound extends Extent {
  counter: string;
  minimum: number;
}
type Node = IrExpr | IrStmt;
const FLIPPED: Readonly<Record<string, string>> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
  "===": "===",
  "==": "==",
  "!==": "!==",
  "!=": "!=",
};

/** Relational proofs for fixed typed-array lengths. Cached lengths retain
 * their receiver identity only when that binding is never reassigned.
 * Loops may use offsets in either direction, but both index integrality
 * and receiver stability are established separately from the relation.
 * For loops hold one bound over the body. While loops start from the
 * condition's bound and follow the body in order: increments raise it and
 * comparisons with the length in if conditions narrow it. Indexes are
 * `counter + c` or `L + d - counter`, where L is the receiver's length. */
export function findBytesBounds(fn: IrFunction, ranges: IntegerRanges): ReadonlySet<Node> {
  const proved = new Map<Node, boolean>();
  if (fn.async || fn.generator || !fn.locals.some((local) => local.type.kind === "bytes"))
    return new Set();
  const locals = new Map(fn.locals.map((l) => [l.id, l]));
  const captured = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  const changed = new Set<string>();
  const initializers = new Map<string, IrExpr>();
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "assignExpr" || e.kind === "incDec") changed.add(e.localId);
      return true;
    },
    stmt: (s) => {
      if (s.kind === "assign" || s.kind === "forOf") changed.add(s.localId);
      if (s.kind === "varDecl" && s.init) initializers.set(s.localId, s.init);
      return true;
    },
  });
  const eligible = (id: string): boolean => {
    const local = locals.get(id);
    return local !== undefined && !local.boxed && !local.tdz && !captured.has(id);
  };
  const cached = new Map<string, Extent | null>();
  const resolving = new Set<string>();
  function extent(e: IrExpr, cache: boolean): Extent | null {
    if (
      e.kind === "bytesIntrinsic" &&
      (e.method === "length" ||
        (e.method === "byteLength" &&
          e.receiver.type.kind === "bytes" &&
          (e.receiver.type.elem === "u8" || e.receiver.type.elem === "u8c"))) &&
      e.receiver.kind === "varRef" &&
      eligible(e.receiver.localId) &&
      (!cache || !changed.has(e.receiver.localId))
    )
      return { receiver: e.receiver.localId, offset: 0 };
    if (e.kind === "varRef" && eligible(e.localId) && !changed.has(e.localId)) {
      const previous = cached.get(e.localId);
      if (previous !== undefined) return previous;
      const init = initializers.get(e.localId);
      if (!init || resolving.has(e.localId)) return null;
      resolving.add(e.localId);
      const result = extent(init, true);
      resolving.delete(e.localId);
      cached.set(e.localId, result);
      return result;
    }
    if (
      e.kind === "bin" &&
      (e.op === "+" || e.op === "-") &&
      e.right.kind === "numLit" &&
      Number.isSafeInteger(e.right.value) &&
      ranges.get(e)
    ) {
      const left = extent(e.left, cache);
      const offset = left ? left.offset + (e.op === "+" ? e.right.value : -e.right.value) : NaN;
      if (left && Number.isSafeInteger(offset)) return { receiver: left.receiver, offset };
    }
    return null;
  }
  function affine(e: IrExpr, counter: string): number | null {
    if (e.kind === "varRef" && e.localId === counter) return 0;
    if (
      e.kind !== "bin" ||
      (e.op !== "+" && e.op !== "-") ||
      e.right.kind !== "numLit" ||
      !Number.isSafeInteger(e.right.value)
    )
      return null;
    const left = affine(e.left, counter);
    if (left === null) return null;
    const result = left + (e.op === "+" ? e.right.value : -e.right.value);
    return Number.isSafeInteger(result) ? result : null;
  }
  /** For an index of the form `L + d - counter` (`len - 1 - i`, `right - i`
   * with `right = len - 1`), where L is the receiver's length: d. */
  function reversed(e: IrExpr, bound: Bound): number | null {
    if (e.kind !== "bin" || (e.op !== "+" && e.op !== "-")) return null;
    if (e.op === "-" && e.right.kind === "varRef" && e.right.localId === bound.counter) {
      const length = extent(e.left, false);
      return length && length.receiver === bound.receiver ? length.offset : null;
    }
    if (e.right.kind !== "numLit" || !Number.isSafeInteger(e.right.value)) return null;
    const left = reversed(e.left, bound);
    if (left === null) return null;
    const result = left + (e.op === "+" ? e.right.value : -e.right.value);
    return Number.isSafeInteger(result) ? result : null;
  }
  function affineRange(e: IrExpr, bound: Bound): IntegerRange | null {
    if (e.kind === "varRef" && e.localId === bound.counter) {
      const max = Number.MAX_SAFE_INTEGER + bound.offset - 1;
      return Number.isSafeInteger(max) && bound.minimum <= max ? { min: bound.minimum, max } : null;
    }
    if (
      e.kind !== "bin" ||
      (e.op !== "+" && e.op !== "-") ||
      e.right.kind !== "numLit" ||
      !Number.isSafeInteger(e.right.value)
    )
      return null;
    const left = affineRange(e.left, bound);
    return left
      ? integerArithmeticRange(e.op, left, { min: e.right.value, max: e.right.value })
      : null;
  }
  function stable(body: IrStmt[], receiver: string, counter: string): boolean {
    return everyStmtList(body, {
      expr: (e) => {
        if (
          (e.kind === "assignExpr" || e.kind === "incDec") &&
          (e.localId === receiver || e.localId === counter)
        )
          return false;
        return isStableReceiverOperand(e, receiver);
      },
      stmt: (s) => {
        if (s.kind === "assign" && (s.localId === receiver || s.localId === counter)) return false;
        switch (s.kind) {
          case "varDecl":
          case "assign":
          case "exprStmt":
          case "bytesSet":
          case "if":
          case "block":
          case "for":
          case "while":
          case "doWhile":
          case "break":
          case "continue":
          case "return":
            return true;
          default:
            return false;
        }
      },
    });
  }
  function loopBound(s: IrStmt & { kind: "for" }): Bound | null {
    if (
      s.init?.kind !== "varDecl" ||
      !s.init.init ||
      !eligible(s.init.localId) ||
      s.cond?.kind !== "bin"
    )
      return null;
    const counter = s.init.localId;
    let right = s.cond.right,
      op: string = s.cond.op;
    if (s.cond.left.kind !== "varRef" || s.cond.left.localId !== counter) {
      if (right.kind !== "varRef" || right.localId !== counter) return null;
      right = s.cond.left;
      op = FLIPPED[op] ?? "";
    }
    const update = s.update;
    let step = 0;
    if (
      update?.kind === "assign" &&
      update.localId === counter &&
      update.value.kind === "bin" &&
      update.value.left.kind === "varRef" &&
      update.value.left.localId === counter &&
      update.value.right.kind === "numLit"
    ) {
      step =
        update.value.op === "+"
          ? update.value.right.value
          : update.value.op === "-"
            ? -update.value.right.value
            : 0;
    } else if (
      update?.kind === "exprStmt" &&
      update.expr.kind === "incDec" &&
      update.expr.localId === counter
    )
      step = update.expr.op === "+" ? 1 : -1;
    if (!Number.isSafeInteger(step) || step === 0) return null;
    let result: Bound | null = null;
    if (step > 0 && (op === "<" || op === "<=")) {
      const length = extent(right, false),
        start = ranges.get(s.init.init);
      if (length && start)
        result = {
          ...length,
          counter,
          offset: length.offset + (op === "<=" ? 1 : 0),
          minimum: start.min,
        };
    } else if (
      step < 0 &&
      (op === ">" || op === ">=") &&
      right.kind === "numLit" &&
      Number.isFinite(right.value)
    ) {
      const start = extent(s.init.init, false);
      if (start)
        result = {
          ...start,
          counter,
          offset: start.offset + 1,
          minimum: op === ">" ? Math.floor(right.value) + 1 : Math.ceil(right.value),
        };
    }
    return result && stable(s.body, result.receiver, counter) ? result : null;
  }
  /** A comparison of the counter with the receiver's length: the operator
   * with the counter on the left, and the length's offset. */
  function lengthComparison(e: IrExpr, bound: Bound): { op: string; offset: number } | null {
    if (e.kind !== "bin") return null;
    let other = e.right,
      op: string = e.op;
    if (e.left.kind !== "varRef" || e.left.localId !== bound.counter) {
      if (other.kind !== "varRef" || other.localId !== bound.counter) return null;
      other = e.left;
      op = FLIPPED[op] ?? op;
    }
    const length = extent(other, false);
    return length && length.receiver === bound.receiver ? { op, offset: length.offset } : null;
  }
  /** The step of `counter = counter + c` with a positive literal c, or null. */
  function increment(s: IrStmt, counter: string): number | null {
    return s.kind === "assign" &&
      s.localId === counter &&
      s.value.kind === "bin" &&
      s.value.op === "+" &&
      s.value.left.kind === "varRef" &&
      s.value.left.localId === counter &&
      s.value.right.kind === "numLit" &&
      Number.isSafeInteger(s.value.right.value) &&
      s.value.right.value > 0
      ? s.value.right.value
      : null;
  }
  function writes(s: IrStmt, id: string): boolean {
    return !everyStmtList([s], {
      expr: (e) => (e.kind !== "assignExpr" && e.kind !== "incDec") || e.localId !== id,
      stmt: (child) =>
        !(
          ((child.kind === "assign" || child.kind === "forOf" || child.kind === "varDecl") &&
            child.localId === id) ||
          (child.kind === "tryCatch" && child.catchLocalId === id)
        ),
    });
  }
  /** A while loop whose condition bounds an integer counter by a typed
   * array's length. The body may write the counter only by statements
   * that add a positive literal, and may not write the receiver. Calls
   * cannot write either binding (both are uncaptured locals), and a typed
   * array's length is fixed at construction, so the body may hold calls. */
  function whileBound(s: IrStmt & { kind: "while" }): Bound | null {
    const cond = s.cond;
    if (cond.kind !== "bin") return null;
    const counterRef = [cond.left, cond.right].find(
      (side, i) =>
        side.kind === "varRef" &&
        eligible(side.localId) &&
        extent(i === 0 ? cond.right : cond.left, false) !== null,
    );
    const minimum = counterRef ? ranges.get(counterRef)?.min : undefined;
    if (counterRef?.kind !== "varRef" || minimum === undefined) return null;
    const counter = counterRef.localId;
    const length = extent(counterRef === cond.left ? cond.right : cond.left, false)!;
    const receiver = length.receiver;
    const comparison = lengthComparison(cond, { receiver, counter, offset: 0, minimum });
    if (comparison?.op !== "<" && comparison?.op !== "<=") return null;
    // An increment is a statement of the body: one inside an expression
    // (a comma expression's statements) would run where flow does not
    // follow it.
    const writesOk = everyStmtList(s.body, {
      expr: (e) =>
        ((e.kind !== "assignExpr" && e.kind !== "incDec") ||
          (e.localId !== counter && e.localId !== receiver)) &&
        everyExprChild(
          e,
          () => true,
          (child) => !writes(child, counter),
        ),
      stmt: (child) => {
        if (child.kind === "assign" && child.localId === counter)
          return increment(child, counter) !== null;
        if (child.kind === "assign" || child.kind === "forOf" || child.kind === "varDecl")
          return child.localId !== counter && child.localId !== receiver;
        return (
          child.kind !== "tryCatch" ||
          (child.catchLocalId !== counter && child.catchLocalId !== receiver)
        );
      },
    });
    return writesOk
      ? {
          receiver,
          counter,
          offset: comparison.offset + (comparison.op === "<=" ? 1 : 0),
          minimum,
        }
      : null;
  }
  function access(node: Node, array: IrExpr, index: IrExpr, active: Bound[], width: number): void {
    const integer = ranges.get(index);
    let safe = false;
    if (array.kind === "varRef" && eligible(array.localId)) {
      for (const bound of active) {
        if (array.localId !== bound.receiver) continue;
        if (!integer && !affineRange(index, bound)) continue;
        const offset = affine(index, bound.counter);
        if (
          offset !== null &&
          bound.minimum + offset >= 0 &&
          bound.offset + offset + width - 1 <= 0
        ) {
          safe = true;
          break;
        }
        // counter < L + bound.offset and counter >= bound.minimum put
        // L + d - counter in [0, L - width].
        const d = integer ? reversed(index, bound) : null;
        if (d !== null && bound.offset <= d + 1 && bound.minimum >= d + width) {
          safe = true;
          break;
        }
      }
    }
    proved.set(node, (proved.get(node) ?? true) && safe);
  }
  function expr(e: IrExpr, active: Bound[]): boolean {
    if (e.kind === "bytesIntrinsic" && e.method === "get" && e.args[0])
      access(e, e.receiver, e.args[0], active, 1);
    const numeric = byteNumberAccess(e);
    if (numeric && e.kind === "bytesIntrinsic")
      access(e, e.receiver, e.args[numeric.offsetArg]!, active, numeric.width);
    return everyExprChild(
      e,
      (child) => expr(child, active),
      (child) => stmt(child, active),
    );
  }
  /** The bounds where `cond` is true and where it is false, from the
   * bound before it. */
  function narrow(cond: IrExpr, bound: Bound): [Bound, Bound] {
    const comparison = lengthComparison(cond, bound);
    if (!comparison) return [bound, bound];
    const j = comparison.offset,
      offset = bound.offset;
    // counter < L + j, counter <= L + j, and counter !== L + j.
    const below = { ...bound, offset: Math.min(offset, j) },
      atMost = { ...bound, offset: Math.min(offset, j + 1) },
      unequal = offset === j + 1 ? { ...bound, offset: j } : bound;
    switch (comparison.op) {
      case "<":
        return [below, bound];
      case "<=":
        return [atMost, bound];
      case ">":
        return [bound, atMost];
      case ">=":
        return [bound, below];
      case "===":
      case "==":
        return [atMost, unequal];
      case "!==":
      case "!=":
        return [unequal, atMost];
      default:
        return [bound, bound];
    }
  }
  /** Visits a while body in order, from the bound that holds on entry.
   * Returns the bound at the end of the list. Its offset is -Infinity (and
   * its minimum Infinity) when the end is unreachable, and Infinity when
   * nothing bounds the counter there. Every write of the counter adds a
   * positive literal (whileBound), so the minimum survives any write. */
  function flow(list: IrStmt[], active: Bound[], bound: Bound): Bound {
    for (const s of list) {
      const current = Number.isFinite(bound.offset) ? [...active, bound] : active;
      const step = increment(s, bound.counter);
      if (step !== null) {
        bound = { ...bound, offset: bound.offset + step, minimum: bound.minimum + step };
      } else if (s.kind === "if") {
        expr(s.cond, current);
        const [then, else_] = narrow(s.cond, bound);
        const left = flow(s.then, active, then),
          right = s.else_ ? flow(s.else_, active, else_) : else_;
        bound = {
          ...bound,
          offset: Math.max(left.offset, right.offset),
          minimum: Math.min(left.minimum, right.minimum),
        };
      } else if (s.kind === "block" && !s.labels?.length) {
        bound = flow(s.body, active, bound);
      } else if (writes(s, bound.counter)) {
        stmt(s, active);
        bound = { ...bound, offset: Infinity };
      } else {
        stmt(s, current);
        if (
          s.kind === "break" ||
          s.kind === "continue" ||
          s.kind === "return" ||
          s.kind === "throw"
        )
          bound = { ...bound, offset: -Infinity, minimum: Infinity };
      }
    }
    return bound;
  }
  function stmt(s: IrStmt, active: Bound[]): boolean {
    if (s.kind === "bytesSet") access(s, s.arr, s.index, active, 1);
    if (s.kind === "while") {
      expr(s.cond, active);
      const bound = whileBound(s);
      if (!bound) return s.body.every((child) => stmt(child, active));
      flow(s.body, active, bound);
      return true;
    }
    if (s.kind === "for") {
      if (s.init) stmt(s.init, active);
      if (s.cond) expr(s.cond, active);
      if (s.update) stmt(s.update, active);
      const bound = loopBound(s);
      const body = bound ? [...active, bound] : active;
      return s.body.every((child) => stmt(child, body));
    }
    return everyStmtChild(
      s,
      (child) => expr(child, active),
      (child) => stmt(child, active),
    );
  }
  fn.body.every((s) => stmt(s, []));
  return new Set([...proved].filter(([, safe]) => safe).map(([node]) => node));
}
