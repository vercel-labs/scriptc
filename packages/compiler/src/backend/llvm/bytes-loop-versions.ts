import type { IrExpr, IrLocal, IrStmt } from "../../ir/ir.js";
import type { IntegerRange, IntegerRanges } from "../../ir/integer-ranges.js";
import type { IntegerCountedForLoop } from "../../ir/integer-loops.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { byteNumberAccess } from "../../ir/byte-numbers.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { exactInteger, widenInteger } from "./integer-values.js";
import { emitCountedLoopLimit, emitCountedLoopSafety } from "./counted-loops.js";
import { emitBytesHeaderLength } from "./expr-bytes.js";

type Node = IrExpr | IrStmt;
type VarRef = IrExpr & { kind: "varRef" };

/** One loop-invariant integer operand of an affine index. */
interface Term {
  expr: IrExpr;
  sign: 1 | -1;
}

/** Every access of `receiver` at a static index range ends below `end + 1`. */
interface FixedCheck {
  receiver: number;
  end: number;
}

/** Every access of `receiver` at `scale * counter + Σ terms + offset` has an
 * offset in [minOffset, maxEnd - width + 1]; `maxEnd` includes the width. */
interface AffineCheck {
  receiver: number;
  scale: number;
  terms: Term[];
  minOffset: number;
  maxEnd: number;
}

export interface BytesLoopVersion {
  /** Typed-array accesses that are in bounds whenever the guard holds. */
  bounds: ReadonlySet<Node>;
  /** Root receiver bindings, read once before the loop. */
  receivers: { ref: VarRef; global: boolean }[];
  fixed: FixedCheck[];
  affine: AffineCheck[];
  /** The counted loop whose iteration space the affine checks cover. */
  counted: IntegerCountedForLoop | null;
  /** The guard also requires every counter value within [-bound, bound]. */
  counterBound: number | null;
  /** Integer ranges of affine index operands that hold in the unchecked
   * loop (where the guard bounds the counter). */
  ranges: ReadonlyMap<IrExpr, IntegerRange>;
}

export interface BytesLoopFacts {
  /** The function's own locals (not module globals). */
  locals: ReadonlyMap<string, IrLocal>;
  /** Module globals whose slot no call can replace: stable constants and
   * the private bindings of a guarded initializer. */
  invariantGlobals: ReadonlySet<string>;
  captured: ReadonlySet<string>;
  ranges: IntegerRanges;
  /** Locals definitely initialized when the loop is entered. */
  initialized: ReadonlySet<string>;
  /** Accesses already proved in bounds without a guard. */
  proven: ReadonlySet<Node>;
}

const MAX_COST = 400;
const MAX_FIXED_END = 2 ** 32;
const MAX_CHECKS = 8;
const MAX_OFFSET = 2 ** 31;
const SAFE = Number.MAX_SAFE_INTEGER;
const INVARIANT_OPS = new Set(["+", "-", "*", "&", "|", "^", "<<", ">>", ">>>"]);

/** Loop versioning for typed-array bounds. A typed array's length and data
 * pointer are fixed at construction (ScrBytes has no resize, transfer or
 * detach), so an access is in bounds for the whole loop when its receiver
 * binding and index operands cannot change while it runs. One test before
 * the loop then covers every iteration:
 *
 * - a statically ranged integer index `[lo, hi]` (lo >= 0) needs
 *   `hi < length`, such as `table[x & 0xff]` or a constant-trip counter;
 * - an index `k * counter + invariant + c` of a counted loop needs its first
 *   and last values in bounds, such as `out[base + i]` for `i < n` or
 *   `view.getUint32(i * 4)`.
 *
 * Only small synchronous loops are versioned (nested loops included), and
 * the emitter bounds how deeply versions nest. The checked loop runs
 * whenever the guard fails, and keeps every out-of-bounds read, ignored
 * write and NaN-index behavior. */
export function matchBytesLoopVersion(
  loop: IrStmt & { kind: "for" },
  counted: IntegerCountedForLoop | null,
  facts: BytesLoopFacts,
): BytesLoopVersion | null {
  const written = new Set<string>();
  const temps = new Map<string, IrExpr>();
  let cost = 0;
  const scanExpr = (e: IrExpr): boolean => {
    if (++cost > MAX_COST) return false;
    if (e.kind === "assignExpr" || e.kind === "incDec") written.add(e.localId);
    return everyExprChild(e, scanExpr, scanStmt);
  };
  const scanStmt = (s: IrStmt): boolean => {
    if (++cost > MAX_COST) return false;
    switch (s.kind) {
      case "forOf":
        written.add(s.localId);
        break;
      case "varDecl": {
        if (temps.has(s.localId) || written.has(s.localId)) temps.delete(s.localId);
        else if (s.init) temps.set(s.localId, s.init);
        written.add(s.localId);
        break;
      }
      case "assign":
        written.add(s.localId);
        break;
      case "tryCatch":
        if (s.catchLocalId) written.add(s.catchLocalId);
        break;
      default:
        break;
    }
    return everyStmtChild(s, scanExpr, scanStmt);
  };
  if (
    !loop.body.every(scanStmt) ||
    (loop.cond !== null && !scanExpr(loop.cond)) ||
    (loop.update !== null && !scanStmt(loop.update))
  )
    return null;
  // A body temp stands for its initializer only when it is a constant
  // binding assigned exactly once, by that declaration.
  const declared = new Map<string, number>();
  const countDecls = (s: IrStmt): boolean => {
    if (s.kind === "varDecl") declared.set(s.localId, (declared.get(s.localId) ?? 0) + 1);
    return everyStmtChild(s, countExprDecls, countDecls);
  };
  const countExprDecls = (e: IrExpr): boolean => everyExprChild(e, countExprDecls, countDecls);
  loop.body.every(countDecls);
  const temp = (id: string): IrExpr | null => {
    const local = facts.locals.get(id);
    const init = temps.get(id);
    if (
      !init ||
      !local ||
      local.mutable ||
      local.boxed ||
      local.tdz ||
      facts.captured.has(id) ||
      declared.get(id) !== 1
    )
      return null;
    return init;
  };
  const counter = counted?.localId ?? null;
  // A binding keeps its loop-entry value for the whole loop.
  const invariant = (id: string): boolean => {
    if (written.has(id) || id === counter) return false;
    const local = facts.locals.get(id);
    if (local)
      return !local.boxed && !local.tdz && !facts.captured.has(id) && facts.initialized.has(id);
    return facts.invariantGlobals.has(id);
  };
  const resolving = new Set<string>();
  const root = (e: IrExpr): VarRef | null => {
    if (e.kind !== "varRef" || e.type.kind !== "bytes") return null;
    const init = temp(e.localId);
    if (init) {
      if (resolving.has(e.localId)) return null;
      resolving.add(e.localId);
      const result = root(init);
      resolving.delete(e.localId);
      return result;
    }
    return invariant(e.localId) ? e : null;
  };
  // A pure integer operand evaluated again before the loop.
  const invariantKey = (e: IrExpr): string | null => {
    if (!facts.ranges.get(e)) return null;
    if (e.kind === "numLit") return Number.isSafeInteger(e.value) ? `n${e.value}` : null;
    if (e.kind === "varRef")
      return invariant(e.localId) ? `v${e.localId.length}:${e.localId}` : null;
    if (
      e.kind === "bin" &&
      INVARIANT_OPS.has(e.op) &&
      e.left.type.kind === "f64" &&
      e.right.type.kind === "f64"
    ) {
      const left = invariantKey(e.left),
        right = invariantKey(e.right);
      return left !== null && right !== null ? `(${e.op} ${left} ${right})` : null;
    }
    return null;
  };
  interface Affine {
    /** The counter's coefficient; 0 when the value is loop-invariant. */
    counter: number;
    terms: (Term & { key: string })[];
    offset: number;
  }
  // Every operand of an affine index is `counter * k + Σ terms + offset`.
  // Invariant terms need proven ranges. Operands that involve the counter
  // need none: the guard bounds the counter so that each of them is a safe
  // integer, which makes the index's double arithmetic exact.
  const shapes = new Map<IrExpr, Affine | null>();
  const affine = (e: IrExpr): Affine | null => {
    if (shapes.has(e)) return shapes.get(e)!;
    const result = affineShape(e);
    shapes.set(e, result);
    return result;
  };
  const affineShape = (e: IrExpr): Affine | null => {
    if (e.kind === "numLit")
      return Number.isSafeInteger(e.value) && Math.abs(e.value) <= MAX_OFFSET
        ? { counter: 0, terms: [], offset: e.value }
        : null;
    if (e.kind === "varRef") {
      if (e.localId === counter) return { counter: 1, terms: [], offset: 0 };
      const init = temp(e.localId);
      if (init) {
        if (resolving.has(e.localId)) return null;
        resolving.add(e.localId);
        const result = affine(init);
        resolving.delete(e.localId);
        return result;
      }
    }
    if (
      e.kind === "bin" &&
      (e.op === "+" || e.op === "-") &&
      e.left.type.kind === "f64" &&
      e.right.type.kind === "f64"
    ) {
      const left = affine(e.left),
        right = affine(e.right);
      if (left && right && (left.counter === 0 || right.counter === 0)) {
        const sign = e.op === "+" ? 1 : -1;
        const offset = left.offset + sign * right.offset;
        if (Math.abs(offset) > MAX_OFFSET) return null;
        const terms = [
          ...left.terms,
          ...right.terms.map((t) => ({ ...t, sign: (sign * t.sign) as 1 | -1 })),
        ];
        const result = { counter: left.counter + sign * right.counter, terms, offset };
        if (result.counter !== 0 || facts.ranges.get(e)) return result;
      }
    }
    // A positive constant multiple of the counter: `i * 4`, `4 * i`,
    // `(i + 1) * 8`. (A negative factor turns a zero into -0.)
    if (e.kind === "bin" && e.op === "*") {
      const literal =
        e.right.kind === "numLit" ? e.right : e.left.kind === "numLit" ? e.left : null;
      const scaled = literal === e.right ? e.left : e.right;
      const factor = literal?.value ?? 0;
      if (
        literal &&
        scaled.type.kind === "f64" &&
        Number.isSafeInteger(factor) &&
        factor > 0 &&
        factor <= MAX_OFFSET
      ) {
        const inner = affine(scaled);
        if (inner && inner.counter !== 0 && inner.terms.length === 0) {
          const counterScale = inner.counter * factor,
            offset = inner.offset * factor;
          if (Math.abs(counterScale) <= MAX_OFFSET && Math.abs(offset) <= MAX_OFFSET)
            return { counter: counterScale, terms: [], offset };
        }
      }
    }
    const key = invariantKey(e);
    return key !== null ? { counter: 0, terms: [{ expr: e, sign: 1, key }], offset: 0 } : null;
  };
  // The operands of an index that involve the counter.
  const chain = (e: IrExpr, out: Set<IrExpr>): void => {
    if (!shapes.get(e)?.counter) return;
    out.add(e);
    if (e.kind === "varRef") {
      const init = temp(e.localId);
      if (init) chain(init, out);
    } else if (e.kind === "bin") {
      chain(e.left, out);
      chain(e.right, out);
    }
  };
  const termMagnitude = (terms: Term[]): number =>
    terms.reduce((sum, t) => {
      const r = facts.ranges.get(t.expr)!;
      return sum + Math.max(Math.abs(r.min), Math.abs(r.max));
    }, 0);

  const receivers: { ref: VarRef; global: boolean }[] = [];
  const receiverIndex = new Map<string, number>();
  const fixed = new Map<number, { check: FixedCheck; nodes: Node[] }>();
  const affineChecks = new Map<
    string,
    { check: AffineCheck; nodes: Node[]; operands: Set<IrExpr> }
  >();
  const receiverOf = (ref: VarRef): number => {
    let index = receiverIndex.get(ref.localId);
    if (index === undefined) {
      index = receivers.length;
      receiverIndex.set(ref.localId, index);
      receivers.push({ ref, global: !facts.locals.has(ref.localId) });
    }
    return index;
  };
  const access = (node: Node, array: IrExpr, index: IrExpr, width: number): void => {
    if (facts.proven.has(node)) return;
    const ref = root(array);
    if (!ref) return;
    const shape = counter !== null ? affine(index) : null;
    if (shape && shape.counter !== 0) {
      const operands = new Set<IrExpr>();
      chain(index, operands);
      const terms = [...shape.terms].sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : a.sign - b.sign,
      );
      const receiver = receiverOf(ref);
      const key = `${receiver}|${shape.counter}|${terms.map((t) => `${t.sign}${t.key}`).join(",")}`;
      const end = shape.offset + width - 1;
      const group = affineChecks.get(key);
      if (group) {
        group.check.minOffset = Math.min(group.check.minOffset, shape.offset);
        group.check.maxEnd = Math.max(group.check.maxEnd, end);
        group.nodes.push(node);
        for (const operand of operands) group.operands.add(operand);
      } else
        affineChecks.set(key, {
          check: { receiver, scale: shape.counter, terms, minOffset: shape.offset, maxEnd: end },
          nodes: [node],
          operands,
        });
      return;
    }
    const range = facts.ranges.get(index);
    if (!range) return;
    const end = range.max + width - 1;
    // Only a length a buffer can have: an outer loop must not pay for a
    // guard that bounds an inner loop's unbounded counter.
    if (range.min < 0 || end >= MAX_FIXED_END) return;
    const receiver = receiverOf(ref);
    const group = fixed.get(receiver);
    if (group) {
      group.check.end = Math.max(group.check.end, end);
      group.nodes.push(node);
    } else fixed.set(receiver, { check: { receiver, end }, nodes: [node] });
  };
  const visitExpr = (e: IrExpr): boolean => {
    if (e.kind === "bytesIntrinsic") {
      const numeric = byteNumberAccess(e);
      if (numeric) access(e, e.receiver, e.args[numeric.offsetArg]!, numeric.width);
      else if (e.method === "get" && e.args[0]) access(e, e.receiver, e.args[0], 1);
    }
    return everyExprChild(e, visitExpr, visitStmt);
  };
  const visitStmt = (s: IrStmt): boolean => {
    if (s.kind === "bytesSet") access(s, s.arr, s.index, 1);
    return everyStmtChild(s, visitExpr, visitStmt);
  };
  loop.body.every(visitStmt);
  // Bound the counter so every counter operand stays a safe integer.
  let bound = SAFE;
  const affineGroups = [...affineChecks.values()].filter((group) => {
    let limit = SAFE;
    for (const operand of group.operands) {
      const shape = shapes.get(operand)!;
      const room = SAFE - termMagnitude(shape.terms) - Math.abs(shape.offset);
      limit = Math.min(limit, Math.floor(room / Math.abs(shape.counter)));
    }
    if (limit < 0 || !counted) return false;
    bound = Math.min(bound, limit);
    return true;
  });
  const groups = [...fixed.values(), ...affineGroups].slice(0, MAX_CHECKS);
  if (groups.length === 0) return null;
  const bounds = new Set<Node>();
  const used = new Set<number>();
  const ranges = new Map<IrExpr, IntegerRange>();
  const counterLow = Math.max(counted?.range.min ?? 0, -bound),
    counterHigh = Math.min(counted?.range.max ?? 0, bound);
  for (const group of groups) {
    used.add(group.check.receiver);
    for (const node of group.nodes) bounds.add(node);
    if (!("operands" in group)) continue;
    for (const operand of group.operands) {
      if (facts.ranges.get(operand)) continue;
      const shape = shapes.get(operand)!;
      const a = shape.counter * counterLow,
        b = shape.counter * counterHigh;
      let min = Math.min(a, b) + shape.offset,
        max = Math.max(a, b) + shape.offset;
      for (const term of shape.terms) {
        const r = facts.ranges.get(term.expr)!;
        min += term.sign > 0 ? r.min : -r.max;
        max += term.sign > 0 ? r.max : -r.min;
      }
      if (counterLow <= counterHigh) ranges.set(operand, { min, max });
    }
  }
  const kept = groups.map((g) => g.check);
  const affineKept = kept.filter((c): c is AffineCheck => "terms" in c);
  // Renumber the receivers the kept checks use.
  const order = [...used].sort((a, b) => a - b);
  const renumber = new Map(order.map((old, index) => [old, index]));
  const needsBound =
    affineKept.length > 0 &&
    counted !== null &&
    (counted.range.min < -bound || counted.range.max > bound);
  return {
    bounds,
    receivers: order.map((index) => receivers[index]!),
    fixed: kept
      .filter((c): c is FixedCheck => !("terms" in c))
      .map((c) => ({ ...c, receiver: renumber.get(c.receiver)! })),
    affine: affineKept.map((c) => ({ ...c, receiver: renumber.get(c.receiver)! })),
    counted: affineKept.length > 0 ? counted : null,
    counterBound: needsBound ? bound : null,
    ranges,
  };
}

/** Branches to `fast` when every access the version proves is in bounds for
 * every iteration, and to `slow` otherwise (including a counted loop whose
 * integer form is not established, or a module receiver not yet set). */
export function emitBytesLoopVersionGuard(
  host: LlvmEmitterContext,
  version: BytesLoopVersion,
  fast: string,
  slow: string,
): void {
  const B = host.B;
  const next = (cond: string): void => {
    if (cond === "true") return;
    const ok = B.newLabel("bytes.version.check");
    B.condBr(cond, ok, slow);
    B.startBlock(ok);
  };
  const counted = version.counted;
  if (counted?.guarded) next(emitCountedLoopSafety(host, counted));
  const receivers = version.receivers.map(({ ref, global }) => {
    const value = host.emitReadReceiver(ref).name;
    if (global) {
      const set = B.tmp();
      B.line(`${set} = icmp ne ptr ${value}, null`);
      next(set);
    }
    return value;
  });
  const lengths = receivers.map((receiver) => {
    const len = emitBytesHeaderLength(host, receiver);
    if (host.sizeType === "i64") return len;
    const wide = B.tmp();
    B.line(`${wide} = zext ${host.sizeType} ${len} to i64`);
    return wide;
  });
  const conditions: string[] = [];
  for (const check of version.fixed) {
    const ok = B.tmp();
    B.line(`${ok} = icmp ugt i64 ${lengths[check.receiver]}, ${check.end}`);
    conditions.push(ok);
  }
  if (counted && version.affine.length > 0) {
    // The first and last counter values, in ascending order. The last value
    // of a non-unit step is exact: `start + ⌊(limit ∓ 1 - start) / step⌋ *
    // step`. A loop that runs no iteration may compute anything here.
    const startValue = host.emitExpr(counted.start);
    const startInteger = exactInteger(host, startValue, counted.start);
    let start: string;
    if (startInteger) start = widenInteger(host, startInteger);
    else {
      // The counted-loop safety test above proved an exact integer.
      start = B.tmp();
      B.line(`${start} = fptosi double ${startValue.name} to i64`);
    }
    const limit = emitCountedLoopLimit(host, counted);
    const step = Math.abs(counted.step);
    const edge = B.tmp();
    B.line(`${edge} = add i64 ${limit}, ${counted.step > 0 ? -1 : 1}`);
    let last = edge;
    if (step !== 1) {
      const span = B.tmp(),
        whole = B.tmp(),
        covered = B.tmp();
      last = B.tmp();
      B.line(
        counted.step > 0
          ? `${span} = sub i64 ${edge}, ${start}`
          : `${span} = sub i64 ${start}, ${edge}`,
      );
      B.line(`${whole} = sdiv i64 ${span}, ${step}`);
      B.line(`${covered} = mul i64 ${whole}, ${step}`);
      B.line(`${last} = ${counted.step > 0 ? "add" : "sub"} i64 ${start}, ${covered}`);
    }
    const low = counted.step > 0 ? start : last;
    const high = counted.step > 0 ? last : start;
    if (version.counterBound !== null) {
      const above = B.tmp(),
        below = B.tmp();
      B.line(`${above} = icmp sge i64 ${low}, ${-version.counterBound}`);
      B.line(`${below} = icmp sle i64 ${high}, ${version.counterBound}`);
      conditions.push(above, below);
    }
    for (const check of version.affine) {
      let base = "0";
      for (const term of check.terms) {
        const value = host.emitExpr(term.expr);
        const integer = exactInteger(host, value, term.expr);
        if (!integer) {
          // Unreachable: every term has a proven range. Stay checked.
          B.br(slow);
          B.startBlock(B.newLabel("bytes.version.dead"));
          return;
        }
        const wide = widenInteger(host, integer);
        const sum = B.tmp();
        B.line(`${sum} = ${term.sign > 0 ? "add" : "sub"} i64 ${base}, ${wide}`);
        base = sum;
      }
      // Products wrap only for a loop with no iteration: within the
      // iteration space every scaled counter is a proven safe integer.
      const scaledLow = scaleCounter(host, low, check.scale),
        scaledHigh = scaleCounter(host, high, check.scale);
      const first = B.tmp(),
        final = B.tmp(),
        nonNegative = B.tmp(),
        below = B.tmp(),
        both = B.tmp();
      B.line(`${first} = add i64 ${check.scale > 0 ? scaledLow : scaledHigh}, ${base}`);
      B.line(`${final} = add i64 ${check.scale > 0 ? scaledHigh : scaledLow}, ${base}`);
      const firstOffset = B.tmp(),
        lastEnd = B.tmp();
      B.line(`${firstOffset} = add i64 ${first}, ${check.minOffset}`);
      B.line(`${lastEnd} = add i64 ${final}, ${check.maxEnd}`);
      B.line(`${nonNegative} = icmp sge i64 ${firstOffset}, 0`);
      // Lengths are at most 2^53 elements: a signed comparison is exact.
      B.line(`${below} = icmp slt i64 ${lastEnd}, ${lengths[check.receiver]}`);
      B.line(`${both} = and i1 ${nonNegative}, ${below}`);
      conditions.push(both);
    }
  }
  let valid = "true";
  for (const cond of conditions) {
    if (valid === "true") valid = cond;
    else {
      const all = B.tmp();
      B.line(`${all} = and i1 ${valid}, ${cond}`);
      valid = all;
    }
  }
  if (valid === "true") B.br(fast);
  else B.condBr(valid, fast, slow);
}

function scaleCounter(host: LlvmEmitterContext, value: string, scale: number): string {
  if (scale === 1) return value;
  const scaled = host.B.tmp();
  host.B.line(`${scaled} = mul i64 ${value}, ${scale}`);
  return scaled;
}
