import {
  BYTES_ELEMENT_SIZE,
  F64,
  type IrExpr,
  type IrLocal,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import type { IntegerRange, IntegerRanges } from "../../ir/integer-ranges.js";
import type { IntegerCountedForLoop, IntegerPairedForLoop } from "../../ir/integer-loops.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { byteNumberAccess } from "../../ir/byte-numbers.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { exactInteger, widenInteger } from "./integer-values.js";
import {
  emitCountedLoopLimit,
  emitCountedLoopSafety,
  emitStartIntegerTest,
  emitValueIntegerTest,
} from "./counted-loops.js";
import { integerOrNaNRange } from "./wrapping-sums.js";
import { emitBytesData, emitBytesHeaderLength, emitBytesSharedStorage } from "./expr-bytes.js";
import { f64Lit } from "./common.js";
import { InternalCompilerError } from "../../errors.js";
import {
  emitStringAsciiFlag,
  emitStringByteLength,
  STRING_SCAN_UNITS_DECL,
  stringScanType,
} from "./string-reads.js";
import { unitSafeLoop } from "./string-unit-versions.js";

type Node = IrExpr | IrStmt;
type VarRef = IrExpr & { kind: "varRef" };

/** One loop-invariant integer operand of an affine index. */
interface Term {
  expr: IrExpr;
  /** 1 or -1. */
  sign: number;
}

interface KeyedTerm extends Term {
  key: string;
}

/** Every access of `receiver` at a while loop counter `c + d` happens while
 * `c < bound` (`c <= bound` when `inclusive`) holds and before the counter
 * advances, so it is in bounds when `bound + slack <= length`. */
interface BoundedCheck {
  receiver: number;
  bound: IrExpr;
  slack: number;
}

/** A while loop counter whose entry value the guard tests: an exact
 * integer of at least `min`. A counter that `| 0` wraps also needs every
 * bound of its loops at most `wrapLimit`, so that it never reaches 2^31. */
interface CounterCheck {
  ref: VarRef;
  min: number;
  wrapBounds: { bound: IrExpr; limit: number }[];
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
  terms: KeyedTerm[];
  minOffset: number;
  maxEnd: number;
}

export interface BytesLoopVersion {
  /** Typed-array accesses that are in bounds whenever the guard holds. */
  bounds: ReadonlySet<Node>;
  /** Worker programs: typed-array accesses whose views the guard proves
   * thread-owned (no shared storage). */
  owned: ReadonlySet<Node>;
  /** Root receiver bindings, read once before the loop; `string` marks a
   * string whose `charCodeAt` and `charAt` reads the version covers. */
  receivers: { ref: VarRef; global: boolean; string: boolean }[];
  /** Receivers the guard requires to have no shared storage for the fast
   * copy. */
  ownedReceivers: number[];
  /** Worker programs: when the bounds hold but a receiver in
   * `ownedReceivers` has shared storage, the loop runs a second fast copy
   * instead of the checked one. It skips the bounds checks of `bounds` and
   * keeps shared-safe accesses (emitBytesLoopVersionGuard's `sharedFast`). Set
   * when the version proves bounds as well as ownership. */
  sharedCopy: boolean;
  /** The string reads among `bounds`. */
  stringReads: ReadonlySet<Node>;
  /** The version's one string receiver, when the loop may also run over
   * its UTF-16 units if it is not ASCII (string-unit-versions.ts). */
  unitsReceiver: number | null;
  /** The units receiver's `length` reads in the loop. Both fast copies
   * read the length the guard took (its UTF-16 length) in their place. */
  unitLengths: ReadonlySet<IrExpr>;
  fixed: FixedCheck[];
  affine: AffineCheck[];
  /** While loops: accesses at a counter below a loop-invariant bound. */
  bounded: BoundedCheck[];
  counters: CounterCheck[];
  /** Keys of affine terms the guard tests at run time: exact integers
   * within GUARDED_TERM. */
  guarded: ReadonlySet<string>;
  /** The counted loop whose iteration space the affine checks cover. */
  counted: IntegerCountedForLoop | null;
  /** A two-counter loop (`for (let i = lo, j = hi; i < j; i++, j--)`) and
   * the receivers it indexes at either counter. Both counters stay between
   * the two starts, so the guard requires `lo >= 0` and `hi < length`. */
  paired: { loop: IntegerPairedForLoop; receivers: number[] } | null;
  /** The guard also requires every counter value within [-bound, bound]. */
  counterBound: number | null;
  /** Integer ranges of affine index operands that hold in the unchecked
   * loop (where the guard bounds the counter). */
  ranges: ReadonlyMap<IrExpr, IntegerRange>;
  /** Typed-array receivers whose element ranges the guard proves disjoint,
   * and the receiver of each of their element reads and writes. The fast
   * copy gives each receiver its own alias scope, so a store to one view
   * leaves the elements of the others in registers. Null when the loop
   * writes no element, or reads and writes a single view. */
  scopes: { receivers: number[]; nodes: ReadonlyMap<Node, number> } | null;
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
  /** Worker programs: an access of a view that may be shared tests the
   * view's shared storage first. */
  workers: boolean;
  /** Accesses already proved thread-owned by an enclosing version. */
  owned: ReadonlySet<Node>;
  /** String bindings held as a slice of another string (string-slices.ts):
   * they have no string header for the guard to read. */
  scalarStrings: ReadonlySet<string>;
  /** The functions a loop over a string's UTF-16 units may call; absent
   * or null where emitted code does not read the runtime's scan receiver. */
  unitSafeFunctions?: ReadonlySet<string> | null;
}

const MAX_COST = 400;
const MAX_FIXED_END = 2 ** 31;
const MAX_CHECKS = 8;
/** Alias-scoped views per loop: the guard tests every pair's ranges. */
const MAX_SCOPED_RECEIVERS = 6;
const MAX_OFFSET = 2 ** 31;
const SAFE = Number.MAX_SAFE_INTEGER;
/** The range the guard requires of an invariant index term without a
 * proven one: every index of a typed array of at most 2^32 elements. */
const GUARDED_TERM: IntegerRange = { min: -(2 ** 32), max: 2 ** 32 };
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
 *   `view.getUint32(i * 4)`. An invariant without a proven integer range,
 *   such as `base` for `const base = r * cols`, must also be an exact
 *   integer between -2^32 and 2^32, which the guard tests.
 *
 * `s.charCodeAt(index)` and `s.charAt(index)` (so `s[index]`) of a string
 * binding qualify the same way. A string is immutable: its bytes, its
 * length and the capacity-word bit that proves it ASCII (string-reads.ts)
 * are fixed when it is built. The guard also requires that bit, so each
 * UTF-16 unit is one byte and the length is the byte length. The fast copy
 * reads each unit with one byte load, and each character as the immortal
 * one-character string for its byte.
 *
 * In worker programs, every access of a view that may be shared tests its
 * shared storage. A view's storage is also fixed at construction, so the
 * same guard tests each invariant receiver once, and the fast copy reads
 * and writes thread-owned views directly.
 *
 * Only small synchronous loops are versioned (nested loops included), and
 * the emitter bounds how deeply versions nest. A loop whose nested loops
 * access typed arrays versions only for an access inside them. The checked
 * loop runs whenever the guard fails, and keeps every out-of-bounds read,
 * ignored write and NaN-index behavior. */
export function matchBytesLoopVersion(
  loop: IrStmt & { kind: "for" | "while" },
  counted: IntegerCountedForLoop | null,
  facts: BytesLoopFacts,
  paired: IntegerPairedForLoop | null = null,
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
  // The guard runs before the initializer, so a binding the initializer
  // writes is not invariant either: `for (let i = (a = b, 0); ...)` must
  // not keep the bounds the guard proved for the old `a`.
  if (
    (loop.kind === "for" && loop.init !== null && !scanStmt(loop.init)) ||
    !loop.body.every(scanStmt) ||
    (loop.cond !== null && !scanExpr(loop.cond)) ||
    (loop.kind === "for" && loop.update !== null && !scanStmt(loop.update))
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
    if (e.kind !== "varRef" || (e.type.kind !== "bytes" && e.type.kind !== "string")) return null;
    if (facts.scalarStrings.has(e.localId)) return null;
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
  // A pure loop-invariant number, evaluated again before the loop.
  const pureKey = (e: IrExpr): string | null => {
    if (e.kind === "numLit") return Number.isSafeInteger(e.value) ? `n${e.value}` : null;
    if (e.kind === "varRef")
      return invariant(e.localId) ? `v${e.localId.length}:${e.localId}` : null;
    if (
      e.kind === "bin" &&
      INVARIANT_OPS.has(e.op) &&
      e.left.type.kind === "f64" &&
      e.right.type.kind === "f64"
    ) {
      const left = pureKey(e.left),
        right = pureKey(e.right);
      return left !== null && right !== null ? `(${e.op} ${left} ${right})` : null;
    }
    return null;
  };
  // Invariant terms without a proven range, such as `base` in
  // `w[base + j]` with `const base = r * cols` for a parameter `cols`. The
  // guard tests each one: an exact integer (not -0) within GUARDED_TERM.
  const guardedRanges = new Map<IrExpr, IntegerRange>();
  const guardedNodes = new Map<IrExpr, string>();
  // The key of a loop-invariant index term, with a proven range or guarded.
  const invariantKey = (e: IrExpr): string | null => {
    const key = pureKey(e);
    if (key === null || facts.ranges.get(e)) return key;
    if (e.kind === "numLit") return null;
    guardedRanges.set(e, GUARDED_TERM);
    guardedNodes.set(e, key);
    return key;
  };
  const termRange = (e: IrExpr): IntegerRange => facts.ranges.get(e) ?? guardedRanges.get(e)!;
  interface Affine {
    /** The counter's coefficient; 0 when the value is loop-invariant. */
    counter: number;
    terms: KeyedTerm[];
    offset: number;
  }
  // Every operand of an affine index is `counter * k + Σ terms + offset`.
  // Invariant terms need proven ranges or the guard's test (guarded terms).
  // Operands that involve the counter need none: the guard bounds the
  // counter so that each of them is a safe integer, which makes the index's
  // double arithmetic exact.
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
          ...right.terms.map((t) => ({ expr: t.expr, sign: sign * t.sign, key: t.key })),
        ];
        const result = { counter: left.counter + sign * right.counter, terms, offset };
        if (result.counter !== 0 || facts.ranges.get(e)) return result;
      }
    }
    // A positive constant multiple of the counter: `i * 4`, `4 * i`,
    // `(i + 1) * 8`. (A negative factor turns a zero into -0.)
    if (e.kind === "bin" && e.op === "*") {
      const rightLiteral = e.right.kind === "numLit";
      const scaled = rightLiteral ? e.left : e.right;
      const literal = rightLiteral ? e.right : e.left;
      const factor = literal.kind === "numLit" ? literal.value : 0;
      if (
        literal.kind === "numLit" &&
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
      const r = termRange(t.expr);
      return sum + Math.max(Math.abs(r.min), Math.abs(r.max));
    }, 0);

  const whileAccesses = loop.kind === "while" ? whileCounterAccesses(loop) : null;
  function whileCounterAccesses(loop: IrStmt & { kind: "while" }) {
    return findWhileCounterAccesses(loop, {
      counterLocal: (id) => {
        const local = facts.locals.get(id);
        return (
          local?.type.kind === "f64" &&
          !local.boxed &&
          !local.tdz &&
          !facts.captured.has(id) &&
          facts.initialized.has(id)
        );
      },
      boundKey: (e) => {
        if (e.type.kind !== "f64") return null;
        // The guard evaluates the bound before the loop: a typed array's
        // length needs the binding itself, not a temp the body declares.
        if (
          e.kind === "bytesIntrinsic" &&
          e.method === "length" &&
          e.receiver.kind === "varRef" &&
          e.receiver.type.kind === "bytes" &&
          invariant(e.receiver.localId)
        )
          return `bytes-length:${e.receiver.localId}`;
        if (
          e.kind === "strIntrinsic" &&
          e.method === "length" &&
          e.args.length === 0 &&
          e.receiver.kind === "varRef" &&
          e.receiver.type.kind === "string" &&
          invariant(e.receiver.localId)
        )
          return `string-length:${e.receiver.localId}`;
        return pureKey(e);
      },
    });
  }
  const receivers: { ref: VarRef; global: boolean; string: boolean }[] = [];
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
      receivers.push({
        ref,
        global: !facts.locals.has(ref.localId),
        string: ref.type.kind === "string",
      });
    }
    return index;
  };
  // Worker programs: accesses through invariant receivers, proven or not,
  // become thread-owned when the guard finds no shared storage.
  const owned = new Map<number, Node[]>();
  // While loops: accesses at a counter below a bound, by receiver and bound.
  const boundedChecks = new Map<
    string,
    { check: BoundedCheck; nodes: { node: Node; access: WhileAccess }[] }
  >();
  const pairedCounters =
    paired !== null && counted === null ? new Set([paired.low.localId, paired.high.localId]) : null;
  const pairedNodes = new Map<number, Node[]>();
  // Accesses inside the loop's nested loops, and inside its nested while
  // loops.
  const nested = new Set<Node>();
  const nestedWhile = new Set<Node>();
  let loops = 0,
    whiles = 0;
  const access = (node: Node, array: IrExpr, index: IrExpr, width: number): void => {
    if (loops > 0) nested.add(node);
    if (whiles > 0) nestedWhile.add(node);
    const ref = root(array);
    if (!ref) return;
    if (facts.workers && ref.type.kind === "bytes" && !facts.owned.has(node)) {
      const receiver = receiverOf(ref);
      const nodes = owned.get(receiver);
      if (nodes) nodes.push(node);
      else owned.set(receiver, [node]);
    }
    if (facts.proven.has(node)) return;
    // An element at either counter of a two-counter loop.
    if (
      pairedCounters !== null &&
      width === 1 &&
      ref.type.kind === "bytes" &&
      index.kind === "varRef" &&
      pairedCounters.has(index.localId)
    ) {
      const receiver = receiverOf(ref);
      const nodes = pairedNodes.get(receiver);
      if (nodes) nodes.push(node);
      else pairedNodes.set(receiver, [node]);
      return;
    }
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
    const bounded = whileAccesses?.accesses.get(node);
    const loopCounter = bounded && whileAccesses!.counters.get(bounded.counter);
    if (bounded && loopCounter && (!loopCounter.wraps || loopCounter.bounds !== null)) {
      const receiver = receiverOf(ref);
      const key = `${receiver}|${bounded.key}|${bounded.adj}`;
      const slack = bounded.offset + width - 1 + bounded.adj;
      const group = boundedChecks.get(key);
      if (group) {
        group.check.slack = Math.max(group.check.slack, slack);
        group.nodes.push({ node, access: bounded });
      } else
        boundedChecks.set(key, {
          check: { receiver, bound: bounded.bound, slack },
          nodes: [{ node, access: bounded }],
        });
      return;
    }
    const range = facts.ranges.get(index);
    if (!range) return;
    const end = range.max + width - 1;
    // Only an end below 2^31: an outer loop must not pay for a guard that
    // bounds an inner loop's unbounded counter, and the counter of a loop to
    // an array's length reaches 2^32 - 2, a length no typed array in
    // practice has.
    if (range.min < 0 || end >= MAX_FIXED_END) return;
    const receiver = receiverOf(ref);
    const group = fixed.get(receiver);
    if (group) {
      group.check.end = Math.max(group.check.end, end);
      group.nodes.push(node);
    } else fixed.set(receiver, { check: { receiver, end }, nodes: [node] });
  };
  // Element reads and writes of each typed-array receiver, for alias scopes.
  const scoped = new Map<Node, number>();
  const writtenViews = new Set<number>();
  const scope = (node: Node, array: IrExpr, write: boolean): void => {
    const ref = root(array);
    if (!ref || ref.type.kind !== "bytes") return;
    const receiver = receiverOf(ref);
    scoped.set(node, receiver);
    if (write) writtenViews.add(receiver);
  };
  const visitExpr = (e: IrExpr): boolean => {
    if (e.kind === "bytesIntrinsic") {
      const numeric = byteNumberAccess(e);
      if (numeric) access(e, e.receiver, e.args[numeric.offsetArg]!, numeric.width);
      else if (e.method === "get" && e.args[0]) {
        access(e, e.receiver, e.args[0], 1);
        scope(e, e.receiver, false);
      }
    } else if (
      e.kind === "strIntrinsic" &&
      (e.method === "charCodeAt" || e.method === "charAt") &&
      e.args[0]
    )
      access(e, e.receiver, e.args[0], 1);
    return everyExprChild(e, visitExpr, visitStmt);
  };
  const visitStmt = (s: IrStmt): boolean => {
    if (s.kind === "bytesSet") {
      access(s, s.arr, s.index, 1);
      scope(s, s.arr, true);
    }
    const isLoop =
      s.kind === "for" || s.kind === "forOf" || s.kind === "while" || s.kind === "doWhile";
    const isWhile = s.kind === "while" || s.kind === "doWhile";
    if (isLoop) loops++;
    if (isWhile) whiles++;
    const result = everyStmtChild(s, visitExpr, visitStmt);
    if (isLoop) loops--;
    if (isWhile) whiles--;
    return result;
  };
  loop.body.every(visitStmt);
  if (loop.kind === "while") visitExpr(loop.cond);
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
  const fixedKept = [...fixed.values()].slice(0, MAX_CHECKS);
  const affineKept = affineGroups.slice(0, MAX_CHECKS - fixedKept.length);
  const boundedKept = [...boundedChecks.values()].slice(
    0,
    Math.max(0, MAX_CHECKS - fixedKept.length - affineKept.length),
  );
  const ownedKept = [...owned.entries()].slice(0, MAX_CHECKS);
  const pairedKept = [...pairedNodes.entries()].slice(
    0,
    Math.max(0, MAX_CHECKS - fixedKept.length - affineKept.length - boundedKept.length),
  );
  if (
    fixedKept.length === 0 &&
    affineKept.length === 0 &&
    boundedKept.length === 0 &&
    ownedKept.length === 0 &&
    pairedKept.length === 0
  )
    return null;
  // A while loop versions only for accesses at its counters. Its other
  // checks (thread-owned receivers, static indices) save a test or two per
  // pass, while a second copy of its body doubles the calls it makes, which
  // can keep a worker's job loop from inlining the function that runs a job.
  if (loop.kind === "while" && boundedKept.length === 0) return null;
  const bounds = new Set<Node>();
  const ownedNodes = new Set<Node>();
  const used = new Set<number>();
  for (const [receiver, nodes] of ownedKept) {
    used.add(receiver);
    for (const node of nodes) ownedNodes.add(node);
  }
  const ranges = new Map<IrExpr, IntegerRange>();
  const counterLow = Math.max(counted?.range.min ?? 0, -bound),
    counterHigh = Math.min(counted?.range.max ?? 0, bound);
  for (const group of fixedKept) {
    used.add(group.check.receiver);
    for (const node of group.nodes) bounds.add(node);
  }
  for (const group of affineKept) {
    used.add(group.check.receiver);
    for (const node of group.nodes) bounds.add(node);
    for (const operand of group.operands) {
      const shape = shapes.get(operand)!;
      const a = shape.counter * counterLow,
        b = shape.counter * counterHigh;
      let min = Math.min(a, b) + shape.offset,
        max = Math.max(a, b) + shape.offset;
      for (const term of shape.terms) {
        const r = termRange(term.expr);
        min += term.sign > 0 ? r.min : -r.max;
        max += term.sign > 0 ? r.max : -r.min;
      }
      if (counterLow > counterHigh) continue;
      // The guard's bound on the counter can narrow a range the operand
      // already has (a loop to a length proves only `i < 2^53`), so that
      // `i * 4` in the fast copy is exact integer arithmetic.
      const known = facts.ranges.get(operand);
      if (!known) ranges.set(operand, { min, max });
      else if (min > known.min || max < known.max)
        ranges.set(operand, { min: Math.max(min, known.min), max: Math.min(max, known.max) });
    }
  }
  // Guarded terms of the kept checks, and the range the guard proves for
  // every node of each in the fast copy.
  const guarded = new Set<string>();
  for (const group of affineKept)
    for (const term of group.check.terms) if (guardedRanges.has(term.expr)) guarded.add(term.key);
  for (const [node, key] of guardedNodes) if (guarded.has(key)) ranges.set(node, GUARDED_TERM);
  // While loop counters of the kept checks: each entry value is an exact
  // integer that no access offset takes below 0. In the fast copy each
  // access's index is below its length, and its counter read at least the
  // most negative offset.
  const narrow = (e: IrExpr, range: IntegerRange): void => {
    const known = ranges.get(e) ?? facts.ranges.get(e);
    ranges.set(
      e,
      known ? { min: Math.max(known.min, range.min), max: Math.min(known.max, range.max) } : range,
    );
  };
  const counterMins = new Map<string, number>();
  for (const group of boundedKept) {
    used.add(group.check.receiver);
    for (const { node, access } of group.nodes) {
      bounds.add(node);
      const min = 0 - access.offset;
      counterMins.set(access.counter, Math.max(counterMins.get(access.counter) ?? -SAFE, min));
      narrow(access.ref, { min: -MAX_OFFSET, max: SAFE });
      if (access.index !== access.ref) narrow(access.index, { min: 0, max: SAFE });
    }
  }
  for (const [receiver, nodes] of pairedKept) {
    used.add(receiver);
    for (const node of nodes) bounds.add(node);
  }
  // A loop whose nested loops access typed arrays versions only when the
  // guard proves the bounds of one of those accesses (or, in a worker
  // program, the ownership of one inside a nested while loop, which never
  // versions for ownership alone). Otherwise the guard covers accesses that
  // run once per pass, while each copy of the body repeats every nested
  // loop and each nested loop's own version.
  if (
    nested.size > 0 &&
    ![...bounds].some((node) => nested.has(node)) &&
    ![...ownedNodes].some((node) => nestedWhile.has(node))
  )
    return null;
  const counterChecks: CounterCheck[] = [];
  for (const [id, min] of counterMins) {
    const info = whileAccesses!.counters.get(id)!;
    counterChecks.push({
      ref: { kind: "varRef", localId: id, type: F64, loc: loop.loc },
      min,
      wrapBounds: info.wraps
        ? info.bounds!.map((b) => ({ bound: b.bound, limit: 2 ** 31 - info.sum - b.adj }))
        : [],
    });
  }
  // Alias scopes: at least two views, one of them written, each read only
  // through plain loads (in a worker program, a view the guard proves
  // thread-owned).
  const scopedReceivers = [...new Set(scoped.values())].sort((a, b) => a - b);
  const ownedSet = new Set(ownedKept.map(([receiver]) => receiver));
  const scoping =
    scopedReceivers.length >= 2 &&
    scopedReceivers.length <= MAX_SCOPED_RECEIVERS &&
    scopedReceivers.some((receiver) => writtenViews.has(receiver)) &&
    (!facts.workers || scopedReceivers.every((receiver) => ownedSet.has(receiver)));
  if (scoping) for (const receiver of scopedReceivers) used.add(receiver);
  // Renumber the receivers the kept checks use.
  const order = [...used].sort((a, b) => a - b);
  const renumber = new Map(order.map((old, index) => [old, index]));
  const stringReads = new Set<Node>();
  for (const group of [...fixedKept, ...affineKept])
    if (receivers[group.check.receiver]!.string)
      for (const node of group.nodes) stringReads.add(node);
  for (const group of boundedKept)
    if (receivers[group.check.receiver]!.string)
      for (const { node } of group.nodes) stringReads.add(node);
  const strings = order.filter((index) => receivers[index]!.string);
  const unitLengths =
    facts.unitSafeFunctions != null && strings.length === 1
      ? unitSafeLoop(loop, receivers[strings[0]!]!.ref.localId, facts.unitSafeFunctions)
      : null;
  const unitsReceiver = unitLengths !== null ? renumber.get(strings[0]!)! : null;
  const needsBound =
    affineKept.length > 0 &&
    counted !== null &&
    (counted.range.min < -bound || counted.range.max > bound);
  return {
    bounds,
    owned: ownedNodes,
    receivers: order.map((index) => receivers[index]!),
    ownedReceivers: ownedKept.map(([receiver]) => renumber.get(receiver)!),
    sharedCopy: ownedKept.length > 0 && bounds.size > 0,
    stringReads,
    unitsReceiver,
    unitLengths: unitLengths ?? new Set<IrExpr>(),
    fixed: fixedKept.map((g) => ({
      receiver: renumber.get(g.check.receiver)!,
      end: g.check.end,
    })),
    affine: affineKept.map((g) => ({
      receiver: renumber.get(g.check.receiver)!,
      scale: g.check.scale,
      terms: g.check.terms,
      minOffset: g.check.minOffset,
      maxEnd: g.check.maxEnd,
    })),
    bounded: boundedKept.map((g) => ({
      receiver: renumber.get(g.check.receiver)!,
      bound: g.check.bound,
      slack: g.check.slack,
    })),
    counters: counterChecks,
    guarded,
    counted: affineKept.length > 0 ? counted : null,
    paired:
      paired !== null && pairedKept.length > 0
        ? { loop: paired, receivers: pairedKept.map(([receiver]) => renumber.get(receiver)!) }
        : null,
    counterBound: needsBound ? bound : null,
    ranges,
    scopes: scoping
      ? {
          receivers: scopedReceivers.map((receiver) => renumber.get(receiver)!),
          nodes: new Map([...scoped].map(([node, receiver]) => [node, renumber.get(receiver)!])),
        }
      : null,
  };
}

/** A typed-array access at a while loop counter: `counter + offset`, read
 * or written while `counter < bound` (`<=` when `adj` is 1) holds. */
interface WhileAccess {
  counter: string;
  /** The index, and the counter's read in it. */
  index: IrExpr;
  ref: IrExpr;
  bound: IrExpr;
  key: string;
  adj: number;
  offset: number;
}

interface WhileCounter {
  /** Some increment is `c = (c + k) | 0`. */
  wraps: boolean;
  /** The sum of every increment literal in the loop. */
  sum: number;
  /** One bound from the condition of the loop and of every nested while
   * loop that advances the counter; null when one of them has none. */
  bounds: { bound: IrExpr; adj: number }[] | null;
}

/** `counter = counter + k`, `counter = (counter + k) | 0` or `counter++`. */
function counterStep(s: IrStmt): { id: string; k: number; wraps: boolean } | null {
  if (s.kind === "exprStmt" && s.expr.kind === "incDec" && s.expr.op === "+")
    return { id: s.expr.localId, k: 1, wraps: false };
  if (s.kind !== "assign") return null;
  let value = s.value,
    wraps = false;
  if (
    value.kind === "bin" &&
    value.op === "|" &&
    value.right.kind === "numLit" &&
    value.right.value === 0 &&
    value.left.kind === "bin"
  ) {
    value = value.left;
    wraps = true;
  }
  if (
    value.kind !== "bin" ||
    value.op !== "+" ||
    value.left.kind !== "varRef" ||
    value.left.localId !== s.localId ||
    value.right.kind !== "numLit" ||
    !Number.isSafeInteger(value.right.value) ||
    value.right.value <= 0 ||
    value.right.value > MAX_OFFSET
  )
    return null;
  return { id: s.localId, k: value.right.value, wraps };
}

/** Typed-array and string accesses of a while loop that happen at a
 * counter below a loop-invariant bound. A counter is a number local that
 * the loop changes only by positive integer increments, written as
 * statements of the body, of its blocks and branches, or of nested while
 * loops. The condition of the loop, an `if` or a `&&` chain that compares
 * the counter below a bound (`while (pos < end && bytes[pos] === 32)
 * pos++`, or `s.charCodeAt(pos)` of a string) makes it below that bound
 * until the next increment on the path. The counter starts at its entry
 * value and only grows (a `| 0` increment never wraps when every bound is
 * at most 2^31 minus the increments), so an access at `counter + d` is in
 * bounds for the whole loop when the entry value is at least `-d` and
 * `bound + d < length` (`+ 1` for `<=`). */
function findWhileCounterAccesses(
  loop: IrStmt & { kind: "while" },
  host: {
    counterLocal: (id: string) => boolean;
    /** A key for a bound expression whose value the loop never changes. */
    boundKey: (e: IrExpr) => string | null;
  },
): { accesses: Map<Node, WhileAccess>; counters: Map<string, WhileCounter> } {
  const steps = new Map<string, { sum: number; wraps: boolean }>();
  const refused = new Set<string>();
  // Increments count only as statements of the loop's straight-line
  // structure; any other write refuses the binding.
  const writes = (list: readonly IrStmt[], direct: boolean): void => {
    for (const s of list) {
      const step = counterStep(s);
      if (step && direct) {
        const prior = steps.get(step.id);
        steps.set(step.id, {
          sum: (prior?.sum ?? 0) + step.k,
          wraps: (prior?.wraps ?? false) || step.wraps,
        });
        continue;
      }
      if (step) refused.add(step.id);
      const nested =
        direct &&
        (s.kind === "if" || s.kind === "while" || (s.kind === "block" && !s.labels?.length));
      if (s.kind === "assign" || s.kind === "varDecl" || s.kind === "forOf") refused.add(s.localId);
      if (s.kind === "tryCatch" && s.catchLocalId) refused.add(s.catchLocalId);
      everyStmtChild(
        s,
        (e) => (exprWrites(e), true),
        (c) => (writes([c], nested), true),
      );
    }
  };
  const exprWrites = (e: IrExpr): void => {
    if (e.kind === "assignExpr" || e.kind === "incDec") refused.add(e.localId);
    everyExprChild(
      e,
      (c) => (exprWrites(c), true),
      (c) => (writes([c], false), true),
    );
  };
  exprWrites(loop.cond);
  writes(loop.body, true);
  const counter = (id: string): boolean =>
    steps.has(id) && !refused.has(id) && host.counterLocal(id);

  type Fact = { bound: IrExpr; key: string; adj: number };
  type Clean = ReadonlyMap<string, Fact>;
  // The bounds a condition puts on counters while it holds.
  const facts = (cond: IrExpr, into: Map<string, Fact>): void => {
    if (cond.kind === "toBool") return facts(cond.operand, into);
    if (cond.kind === "logical" && cond.op === "&&") {
      facts(cond.left, into);
      facts(cond.right, into);
      return;
    }
    if (cond.kind !== "bin") return;
    const below = cond.op === "<" || cond.op === "<=",
      above = cond.op === ">" || cond.op === ">=";
    const c = below ? cond.left : above ? cond.right : null,
      bound = below ? cond.right : cond.left;
    if (c?.kind !== "varRef" || !counter(c.localId) || into.has(c.localId)) return;
    const key = host.boundKey(bound);
    if (key === null) return;
    into.set(c.localId, { bound, key, adj: cond.op === "<=" || cond.op === ">=" ? 1 : 0 });
  };
  // The facts that hold after either of two paths.
  const meet = (a: Clean | null, b: Clean | null): Clean | null => {
    if (a === null) return b;
    if (b === null) return a;
    const out = new Map<string, Fact>();
    for (const [id, fact] of a) if (b.get(id) === fact) out.set(id, fact);
    return out;
  };
  const withFacts = (clean: Clean, cond: IrExpr): Clean => {
    const out = new Map(clean);
    facts(cond, out);
    return out;
  };
  const accesses = new Map<Node, WhileAccess>();
  const record = (node: Node, index: IrExpr, clean: Clean): void => {
    let ref: IrExpr = index,
      offset = 0;
    if (index.kind === "bin" && (index.op === "+" || index.op === "-")) {
      const literal =
        index.right.kind === "numLit" ? index.right : index.op === "+" ? index.left : null;
      const other = literal === index.right ? index.left : index.right;
      if (literal?.kind !== "numLit" || !Number.isSafeInteger(literal.value)) return;
      if (Math.abs(literal.value) > MAX_OFFSET || Object.is(literal.value, -0)) return;
      offset = index.op === "-" ? -literal.value : literal.value;
      ref = other;
    }
    if (ref.kind !== "varRef") return;
    const fact = clean.get(ref.localId);
    if (fact) accesses.set(node, { counter: ref.localId, index, ref, ...fact, offset });
  };
  const expr = (e: IrExpr, clean: Clean): void => {
    if (e.kind === "bytesIntrinsic") {
      const numeric = byteNumberAccess(e);
      const index = numeric
        ? e.args[numeric.offsetArg]
        : e.method === "get"
          ? e.args[0]
          : undefined;
      if (index) record(e, index, clean);
    }
    if (
      e.kind === "strIntrinsic" &&
      (e.method === "charCodeAt" || e.method === "charAt") &&
      e.args[0]
    )
      record(e, e.args[0], clean);
    if (e.kind === "logical" && e.op === "&&") {
      expr(e.left, clean);
      expr(e.right, withFacts(clean, e.left));
      return;
    }
    if (e.kind === "ternary") {
      expr(e.cond, clean);
      expr(e.then, withFacts(clean, e.cond));
      expr(e.else_, clean);
      return;
    }
    everyExprChild(
      e,
      (c) => (expr(c, clean), true),
      (c) => (stmts([c], clean), true),
    );
  };
  // Walks statements in order; the result is the clean state where the
  // list falls through, or null when it never does.
  const stmts = (list: readonly IrStmt[], clean: Clean): Clean | null => {
    let current: Clean | null = clean;
    for (const s of list) {
      if (current === null) return null;
      const step = counterStep(s);
      if (step) {
        const next: Map<string, Fact> = new Map(current);
        next.delete(step.id);
        current = next;
        continue;
      }
      switch (s.kind) {
        case "if": {
          expr(s.cond, current);
          const then = stmts(s.then, withFacts(current, s.cond));
          const otherwise = stmts(s.else_ ?? [], current);
          current = meet(then, otherwise);
          break;
        }
        case "while": {
          // A pass of the nested loop may follow its own increments.
          const advanced: Map<string, Fact> = new Map(current);
          for (const id of writtenCounters(s.body)) advanced.delete(id);
          expr(s.cond, advanced);
          stmts(s.body, withFacts(advanced, s.cond));
          current = advanced;
          break;
        }
        case "block":
          if (!s.labels?.length) {
            current = stmts(s.body, current);
            break;
          }
          everyStmtChild(
            s,
            (e) => (expr(e, current!), true),
            (c) => (stmts([c], current!), true),
          );
          break;
        case "bytesSet":
          record(s, s.index, current);
          everyStmtChild(
            s,
            (e) => (expr(e, current!), true),
            (c) => (stmts([c], current!), true),
          );
          break;
        case "break":
        case "continue":
        case "return":
        case "throw":
          everyStmtChild(
            s,
            (e) => (expr(e, current!), true),
            (c) => (stmts([c], current!), true),
          );
          current = null;
          break;
        default:
          everyStmtChild(
            s,
            (e) => (expr(e, current!), true),
            (c) => (stmts([c], current!), true),
          );
          break;
      }
    }
    return current;
  };
  const writtenCounters = (list: readonly IrStmt[]): Set<string> => {
    const out = new Set<string>();
    const visit = (s: IrStmt): boolean => {
      const step = counterStep(s);
      if (step) out.add(step.id);
      return everyStmtChild(s, () => true, visit);
    };
    list.every(visit);
    return out;
  };
  expr(loop.cond, new Map());
  stmts(loop.body, withFacts(new Map(), loop.cond));

  // Each counter's bounds: the loop's and those of nested while loops that
  // advance it.
  const counters = new Map<string, WhileCounter>();
  const loops: (IrStmt & { kind: "while" })[] = [loop];
  const collectLoops = (s: IrStmt): boolean => {
    if (s.kind === "while") loops.push(s);
    return everyStmtChild(s, () => true, collectLoops);
  };
  loop.body.every(collectLoops);
  for (const [id, step] of steps) {
    if (!counter(id)) continue;
    let bounds: WhileCounter["bounds"] = [];
    for (const l of loops) {
      if (l !== loop && !writtenCounters(l.body).has(id)) continue;
      const fact = withFacts(new Map(), l.cond).get(id);
      if (!fact) {
        bounds = null;
        break;
      }
      bounds.push({ bound: fact.bound, adj: fact.adj });
    }
    counters.set(id, { ...step, bounds });
  }
  return { accesses, counters };
}

/** Branches to `fast` when every access the version proves is in bounds for
 * every iteration and every view it proves thread-owned has no shared
 * storage, and to `slow` otherwise (including a counted loop whose
 * integer form is not established, or a module receiver not yet set).
 *
 * With `sharedFast` (a version with `sharedCopy`), the ownership tests are
 * separate: when everything else holds but a view has shared storage, the
 * guard branches to `sharedFast` instead of `slow`.
 *
 * With `unitsFast`, the version's units receiver may instead be a string
 * that is not ASCII: the guard has the runtime publish it as the scan
 * receiver (one read), tests the same accesses against its UTF-16 length,
 * and branches to `unitsFast`. It returns the units pointer that copy
 * reads, which stays valid while the loop runs (string-unit-versions.ts),
 * and for a version with a units receiver, the receiver's UTF-16 length
 * on both fast paths (an i64). */
export function emitBytesLoopVersionGuard(
  host: LlvmEmitterContext,
  version: BytesLoopVersion,
  fast: string,
  slow: string,
  unitsFast?: string,
  sharedFast?: string,
): { units: string | null; length: string | null } | null {
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
  const unitsIndex = unitsFast !== undefined ? version.unitsReceiver : null;
  const units: { read: { pointer: string; taken: string; published: string } | null } = {
    read: null,
  };
  const widen = (len: string): string => {
    if (host.sizeType === "i64") return len;
    const wide = B.tmp();
    B.line(`${wide} = zext ${host.sizeType} ${len} to i64`);
    return wide;
  };
  const lengths = receivers.map((receiver, index) => {
    if (index === unitsIndex) {
      const read = emitUnitsLength(host, receiver, () => emitUnitsSpan(host, version, index));
      units.read = read;
      return read.length;
    }
    return widen(
      version.receivers[index]!.string
        ? emitStringByteLength(host, receiver)
        : emitBytesHeaderLength(host, receiver),
    );
  });
  const conditions: string[] = [];
  // The published count is the receiver's UTF-16 length only while the
  // runtime publishes the receiver itself.
  if (units.read) conditions.push(units.read.published);
  // A string's byte length is its UTF-16 length when it is ASCII.
  version.receivers.forEach(({ string }, index) => {
    if (string && index !== unitsIndex)
      conditions.push(emitStringAsciiFlag(host, receivers[index]!));
  });
  // Without `sharedFast`, shared storage sends the loop to the checked copy
  // with the other failed tests; with it, only to the shared fast copy.
  const ownership: string[] = [];
  for (const index of version.ownedReceivers) {
    const owned = B.tmp();
    B.line(`${owned} = icmp eq ptr ${emitBytesSharedStorage(host, receivers[index]!)}, null`);
    (sharedFast !== undefined ? ownership : conditions).push(owned);
  }
  for (const check of version.fixed) {
    const ok = B.tmp();
    B.line(`${ok} = icmp ugt i64 ${lengths[check.receiver]}, ${check.end}`);
    conditions.push(ok);
  }
  if (version.scopes) {
    // Every pair of scoped views covers disjoint bytes: one ends at or
    // before the other starts. An empty view covers none.
    const spans = version.scopes.receivers.map((index) => {
      const type = version.receivers[index]!.ref.type as IrType & { kind: "bytes" };
      const start = B.tmp(),
        size = B.tmp(),
        end = B.tmp();
      B.line(`${start} = ptrtoint ptr ${emitBytesData(host, receivers[index]!)} to i64`);
      B.line(`${size} = mul nuw i64 ${lengths[index]}, ${BYTES_ELEMENT_SIZE[type.elem]}`);
      B.line(`${end} = add nuw i64 ${start}, ${size}`);
      return { start, end };
    });
    spans.forEach((a, i) => {
      for (const b of spans.slice(i + 1)) {
        const before = B.tmp(),
          after = B.tmp(),
          apart = B.tmp();
        B.line(`${before} = icmp ule i64 ${a.end}, ${b.start}`);
        B.line(`${after} = icmp ule i64 ${b.end}, ${a.start}`);
        B.line(`${apart} = or i1 ${before}, ${after}`);
        conditions.push(apart);
      }
    });
  }
  for (const counter of version.counters) {
    const value = host.emitExpr(counter.ref);
    // A counter held as an integer (an int32 slot) is exact already and
    // needs at most its lower bound tested.
    const integer = exactInteger(host, value, counter.ref);
    if (integer && integer.range.max <= SAFE) {
      if (integer.range.min < counter.min) {
        const ok = B.tmp();
        B.line(`${ok} = icmp sge i64 ${widenInteger(host, integer)}, ${counter.min}`);
        conditions.push(ok);
      }
    } else conditions.push(emitValueIntegerTest(host, value, counter.ref, counter.min, SAFE).ok);
    for (const wrap of counter.wrapBounds) {
      const bound = host.emitExpr(wrap.bound);
      const boundInteger = exactInteger(host, bound, wrap.bound);
      if (boundInteger && boundInteger.range.max <= wrap.limit) continue;
      const ok = B.tmp();
      B.line(`${ok} = fcmp ole double ${bound.name}, ${f64Lit(wrap.limit)}`);
      conditions.push(ok);
    }
  }
  for (const check of version.bounded) {
    // `bound <= length - slack` in doubles: both sides are exact (a length
    // is below 2^53 and a slack below 2^32), and NaN fails.
    const bound = host.emitExpr(check.bound).name;
    const length = B.tmp(),
      room = B.tmp(),
      ok = B.tmp();
    B.line(`${length} = uitofp i64 ${lengths[check.receiver]} to double`);
    B.line(`${room} = fsub double ${length}, ${f64Lit(check.slack)}`);
    B.line(`${ok} = fcmp ole double ${bound}, ${room}`);
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
    else if (startValue.nanInteger !== undefined && integerOrNaNRange(host, counted.start))
      // The counted-loop safety test required the ordered bit.
      start = startValue.nanInteger;
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
        if (version.guarded.has(term.key)) {
          const tested = emitValueIntegerTest(
            host,
            value,
            term.expr,
            GUARDED_TERM.min,
            GUARDED_TERM.max,
          );
          conditions.push(tested.ok);
          const sum = B.tmp();
          B.line(`${sum} = ${term.sign > 0 ? "add" : "sub"} i64 ${base}, ${tested.integer}`);
          base = sum;
          continue;
        }
        const integer = exactInteger(host, value, term.expr);
        if (!integer) {
          // Unreachable: every term has a proven range. Stay checked.
          B.br(slow);
          B.startBlock(B.newLabel("bytes.version.dead"));
          return null;
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
  if (version.paired !== null) {
    // Both counters stay within [lo, hi] (exact integers below 2^53): every
    // access at either one is in bounds when `lo >= 0` and `hi < length`.
    const { loop } = version.paired;
    const [low, high] = [loop.low.start, loop.high.start].map((expr) => {
      const tested = emitStartIntegerTest(host, expr, -SAFE, SAFE);
      if (tested.ok !== "true") conditions.push(tested.ok);
      return tested.integer;
    });
    const nonNegative = B.tmp();
    B.line(`${nonNegative} = icmp sge i64 ${low}, 0`);
    conditions.push(nonNegative);
    for (const receiver of version.paired.receivers) {
      // Lengths are at most 2^53 elements: a signed comparison is exact.
      const below = B.tmp();
      B.line(`${below} = icmp slt i64 ${high}, ${lengths[receiver]}`);
      conditions.push(below);
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
  const length = version.unitsReceiver !== null ? lengths[version.unitsReceiver]! : null;
  const taken = units.read;
  const target = taken ? B.newLabel("bytes.version.units") : fast;
  if (sharedFast !== undefined && taken)
    throw new InternalCompilerError("llvm emitter bug: a shared fast copy with a units copy");
  if (sharedFast !== undefined && ownership.length > 0) {
    // The bounds hold: unshared views take the owned copy.
    const split = B.newLabel("bytes.version.owned");
    let owned = ownership[0]!;
    for (const cond of ownership.slice(1)) {
      const all = B.tmp();
      B.line(`${all} = and i1 ${owned}, ${cond}`);
      owned = all;
    }
    if (valid === "true") B.br(split);
    else B.condBr(valid, split, slow);
    B.startBlock(split);
    B.condBr(owned, target, sharedFast);
  } else if (valid === "true") B.br(target);
  else B.condBr(valid, target, slow);
  if (!taken) return { units: null, length };
  B.startBlock(target);
  B.condBr(taken.taken, unitsFast!, fast);
  return { units: taken.pointer, length };
}

/** The range of indexes a version's loop reads from its units receiver, as
 * two doubles: a counted loop's start and limit, or a while loop's one
 * counter and the receiver's bound. Both NaN when the version gives no such
 * range. The runtime converts the receiver at once only when the range is
 * long enough to pay for it (scr_str_scan_units_for). */
function emitUnitsSpan(
  host: LlvmEmitterContext,
  version: BytesLoopVersion,
  receiver: number,
): { from: string; to: string } {
  // Locals and literals only: they read no string (a `length` of the
  // receiver would measure it). Anything else leaves the range unbounded.
  const number = (expr: IrExpr): string | null => {
    if (expr.kind !== "varRef" && expr.kind !== "numLit") return null;
    const value = host.emitExpr(expr);
    return value.type.kind === "f64" ? value.name : null;
  };
  const unbounded = { from: "0x7FF8000000000000", to: "0x7FF8000000000000" };
  const counted = version.counted;
  let from: IrExpr, to: IrExpr;
  if (counted) [from, to] = [counted.start, counted.limit];
  else {
    const bounded = version.bounded.filter((check) => check.receiver === receiver);
    if (version.counters.length !== 1 || bounded.length !== 1 || version.paired !== null)
      return unbounded;
    [from, to] = [version.counters[0]!.ref, bounded[0]!.bound];
  }
  const start = number(from),
    limit = number(to);
  return start !== null && limit !== null ? { from: start, to: limit } : unbounded;
}

/** The length of a version's units receiver `s` in UTF-16 units: its byte
 * length when it is ASCII; otherwise, once it is the scan receiver, the
 * published unit count (0 when the runtime does not hold its units). When
 * `s` is not already the scan receiver, the runtime converts it to units
 * and publishes it if the loop's `span` makes that pay
 * (scr_str_scan_units_for). Also the units pointer, whether the loop is to
 * read it, and whether the published receiver is `s`. */
function emitUnitsLength(
  host: LlvmEmitterContext,
  s: string,
  span: () => { from: string; to: string },
): { length: string; pointer: string; taken: string; published: string } {
  const B = host.B;
  const sz = host.sizeType;
  const type = stringScanType(sz);
  const ascii = emitStringAsciiFlag(host, s);
  const bytes = emitStringByteLength(host, s);
  const from = B.currentLabel();
  const publish = B.newLabel("bytes.version.publish"),
    join = B.newLabel("bytes.version.length");
  B.condBr(ascii, join, publish);
  B.startBlock(publish);
  // When `s` is already the scan receiver (an earlier loop over it published
  // it), its units stay published until the runtime clears the scan: skip
  // the call. Loops re-entered over one string take that path; the weights
  // keep the call and its reach out of the loop's code.
  const held = B.tmp(),
    holds = B.tmp();
  B.line(`${held} = load ptr, ptr @scr_str_scan`);
  B.line(`${holds} = icmp eq ptr ${held}, ${s}`);
  const call = B.newLabel("bytes.version.publish.units"),
    load = B.newLabel("bytes.version.publish.load");
  B.condBr(holds, load, call, `, !prof !{!"branch_weights", i32 1000, i32 1}`);
  B.startBlock(call);
  host.declare(STRING_SCAN_UNITS_DECL);
  const receiver = B.tmp(),
    same = B.tmp(),
    pointerSlot = B.tmp(),
    pointer = B.tmp(),
    countSlot = B.tmp(),
    count = B.tmp(),
    published = B.tmp();
  const { from: first, to: bound } = span();
  B.line(`call void @scr_str_scan_units_for(ptr ${s}, double ${first}, double ${bound})`);
  B.br(load);
  B.startBlock(load);
  B.line(`${receiver} = load ptr, ptr @scr_str_scan`);
  B.line(`${same} = icmp eq ptr ${receiver}, ${s}`);
  B.line(`${pointerSlot} = getelementptr inbounds ${type}, ptr @scr_str_scan, i32 0, i32 1`);
  B.line(`${pointer} = load ptr, ptr ${pointerSlot}`);
  B.line(`${countSlot} = getelementptr inbounds ${type}, ptr @scr_str_scan, i32 0, i32 2`);
  B.line(`${count} = load ${sz}, ptr ${countSlot}`);
  B.line(`${published} = select i1 ${same}, ${sz} ${count}, ${sz} 0`);
  const end = B.currentLabel();
  B.br(join);
  B.startBlock(join);
  const length = B.tmp(),
    units = B.tmp(),
    taken = B.tmp();
  B.line(`${length} = phi ${sz} [ ${bytes}, %${from} ], [ ${published}, %${end} ]`);
  B.line(`${units} = phi ptr [ null, %${from} ], [ ${pointer}, %${end} ]`);
  B.line(`${taken} = phi i1 [ false, %${from} ], [ true, %${end} ]`);
  const exact = B.tmp();
  B.line(`${exact} = phi i1 [ true, %${from} ], [ ${same}, %${end} ]`);
  let wide = length;
  if (sz !== "i64") {
    wide = B.tmp();
    B.line(`${wide} = zext ${sz} ${length} to i64`);
  }
  return { length: wide, pointer: units, taken, published: exact };
}

function scaleCounter(host: LlvmEmitterContext, value: string, scale: number): string {
  if (scale === 1) return value;
  const scaled = host.B.tmp();
  host.B.line(`${scaled} = mul i64 ${value}, ${scale}`);
  return scaled;
}
