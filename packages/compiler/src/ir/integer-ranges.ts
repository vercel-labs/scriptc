import type { IrExpr, IrFunction, IrStmt } from "./ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "./traverse.js";
import { byteNumberAccess, byteNumberRange } from "./byte-numbers.js";
import {
  BYTES_LENGTH_RANGE,
  boundedIntegerLoopFacts,
  guardedLoopCounterFacts,
  integerPathFallsThrough,
  STRING_MAX_UNITS,
} from "./integer-loop-facts.js";

/** Exactly representable integers, excluding negative zero. Facts describe
 * the evaluated value, never a later read of the same local binding. */
export interface IntegerRange {
  min: number;
  max: number;
}
export type IntegerRanges = ReadonlyMap<IrExpr, IntegerRange | null>;
/** Facts per expression, and per for loop the bindings its body writes only
 * as bounded cursors (boundedIntegerLoopFacts): each holds an integer in its
 * loop range on entry and at every write in the loop. */
export interface IntegerRangeFacts {
  ranges: IntegerRanges;
  loopRanges: ReadonlyMap<IrStmt, ReadonlyMap<string, IntegerRange>>;
}
/** Ranges assumed for locals on entry to while and for loops
 * (loop-entry-ranges.ts), after a for loop's initializer:
 * the facts inside such a loop hold in a copy of it that runs only after a
 * test proves every assumed local is an integer in its range. After the
 * loop, its assumed locals and its writes carry no facts. */
export type LoopEntryAssumptions = ReadonlyMap<IrStmt, ReadonlyMap<string, IntegerRange>>;
const SIGNED: IntegerRange = { min: -2147483648, max: 2147483647 };
const UNSIGNED: IntegerRange = { min: 0, max: 4294967295 };
/** Int32 and uint32 at once: the bound under which `%` (modeled only for
 * non-negative dividends) can close a loop-carried local. */
const NON_NEGATIVE: IntegerRange = { min: 0, max: 2147483647 };
const EXACT_LIMIT = 2 ** 53;
type Facts = Map<string, IntegerRange>;

function union(left: IntegerRange, right: IntegerRange): IntegerRange {
  return { min: Math.min(left.min, right.min), max: Math.max(left.max, right.max) };
}
function merge(into: Facts, left: Facts, right: Facts): void {
  into.clear();
  for (const [id, value] of left) {
    const other = right.get(id);
    if (other) into.set(id, union(value, other));
  }
}
export function integerArithmeticRange(
  op: string,
  left: IntegerRange,
  right: IntegerRange,
): IntegerRange | null {
  let min: number;
  let max: number;
  if (op === "+") {
    min = left.min + right.min;
    max = left.max + right.max;
  } else if (op === "-") {
    min = left.min - right.max;
    max = left.max - right.min;
  } else if (op === "*") {
    if (
      (left.min <= 0 && left.max >= 0 && right.min < 0) ||
      (right.min <= 0 && right.max >= 0 && left.min < 0)
    )
      return null;
    const products = [
      left.min * right.min,
      left.min * right.max,
      left.max * right.min,
      left.max * right.max,
    ];
    min = Math.min(...products);
    max = Math.max(...products);
  } else if (op === "%" && left.min >= 0 && right.min > 0) {
    return { min: 0, max: Math.min(left.max, right.max - 1) };
  } else return null;
  return Number.isSafeInteger(min) && Number.isSafeInteger(max) ? { min, max } : null;
}

export const INT32_RANGE: IntegerRange = SIGNED;
export const NON_NEGATIVE_INT32_RANGE: IntegerRange = NON_NEGATIVE;
export function withinInt32(range: IntegerRange | null | undefined): boolean {
  return !!range && range.min >= SIGNED.min && range.max <= SIGNED.max;
}
export function withinUint32(range: IntegerRange | null | undefined): boolean {
  return !!range && range.min >= UNSIGNED.min && range.max <= UNSIGNED.max;
}

export type BitwiseOp = "&" | "|" | "^" | "<<" | ">>" | ">>>";
export function isBitwiseOp(op: string): op is BitwiseOp {
  return op === "&" || op === "|" || op === "^" || op === "<<" || op === ">>" || op === ">>>";
}

/** What an operand of a bitwise operator is known to be: a range of exact
 * integers, or, for a numeric literal that is not one (2^53 + 2, 0.5, NaN,
 * Infinity), its value. Unknown operands are null. */
export type BitwiseOperand = IntegerRange | number | null;
function operandView(e: IrExpr, range: IntegerRange | null): BitwiseOperand {
  return range ?? (e.kind === "numLit" ? e.value : null);
}

/** The values ToInt32 can produce from the operand. A range inside int32 is
 * its own image; [2^31, 2^32) shifts down by 2^32; anything wider or unknown
 * wraps to the whole int32 range. */
function int32View(operand: BitwiseOperand): IntegerRange {
  if (typeof operand === "number") return { min: operand | 0, max: operand | 0 };
  if (withinInt32(operand)) return operand!;
  if (operand && operand.min > SIGNED.max && operand.max <= UNSIGNED.max)
    return { min: operand.min - 2 ** 32, max: operand.max - 2 ** 32 };
  return SIGNED;
}
/** The values ToUint32 can produce from the operand. */
function uint32View(operand: BitwiseOperand): IntegerRange {
  if (typeof operand === "number") return { min: operand >>> 0, max: operand >>> 0 };
  if (withinUint32(operand)) return operand!;
  if (operand && operand.min >= SIGNED.min && operand.max < 0)
    return { min: operand.min + 2 ** 32, max: operand.max + 2 ** 32 };
  return UNSIGNED;
}
/** The shift counts (`ToUint32(count) & 31`) the operand can produce. */
function shiftCounts(operand: BitwiseOperand): IntegerRange {
  const counts = uint32View(operand);
  return counts.max - counts.min < 32 && (counts.min & 31) <= (counts.max & 31)
    ? { min: counts.min & 31, max: counts.max & 31 }
    : { min: 0, max: 31 };
}
/** The smallest 2^k - 1 at or above a non-negative int32 or uint32. */
function bitCover(value: number): number {
  let cover = 0;
  while (cover < value) cover = cover * 2 + 1;
  return cover;
}

/** The result range of a JS bitwise operator over its operands' ranges.
 * Every result is an exact integer and never -0. */
export function bitwiseRange(
  op: BitwiseOp,
  leftOperand: BitwiseOperand,
  rightOperand: BitwiseOperand,
): IntegerRange {
  if (op === ">>>") {
    const value = uint32View(leftOperand),
      counts = shiftCounts(rightOperand);
    return {
      min: Math.floor(value.min / 2 ** counts.max),
      max: Math.floor(value.max / 2 ** counts.min),
    };
  }
  const left = int32View(leftOperand);
  if (op === ">>" || op === "<<") {
    const counts = shiftCounts(rightOperand);
    if (op === ">>")
      return {
        min: Math.min(
          Math.floor(left.min / 2 ** counts.min),
          Math.floor(left.min / 2 ** counts.max),
        ),
        max: Math.max(
          Math.floor(left.max / 2 ** counts.min),
          Math.floor(left.max / 2 ** counts.max),
        ),
      };
    const min = Math.min(left.min * 2 ** counts.min, left.min * 2 ** counts.max),
      max = Math.max(left.max * 2 ** counts.min, left.max * 2 ** counts.max);
    return withinInt32({ min, max }) ? { min, max } : SIGNED;
  }
  const right = int32View(rightOperand);
  if (op === "&") {
    // Clearing bits of a non-negative value cannot raise it; a negative
    // operand keeps the result at or below the other operand's maximum.
    if (left.min >= 0 && right.min >= 0) return { min: 0, max: Math.min(left.max, right.max) };
    if (left.min >= 0) return { min: 0, max: left.max };
    if (right.min >= 0) return { min: 0, max: right.max };
    if (left.max < 0 && right.max < 0)
      return { min: SIGNED.min, max: Math.min(left.max, right.max) };
    return SIGNED;
  }
  if (left.min === 0 && left.max === 0) return right;
  if (right.min === 0 && right.max === 0) return left;
  if (left.min >= 0 && right.min >= 0) {
    const max = bitCover(Math.max(left.max, right.max));
    return op === "|" ? { min: Math.max(left.min, right.min), max } : { min: 0, max };
  }
  if (op === "|") {
    // Setting bits of a negative int32 raises it toward -1.
    if (left.max < 0 && right.max < 0) return { min: Math.max(left.min, right.min), max: -1 };
    if (left.max < 0) return { min: left.min, max: -1 };
    if (right.max < 0) return { min: right.min, max: -1 };
  }
  return SIGNED;
}

/** The operand a bitwise operator returns unchanged when that operand is an
 * int32 (a uint32 for `>>>`): `x | 0`, `x ^ 0`, `x & -1`, `x << 0`, `x >> 0`
 * and `x >>> 0`, with the literal on either side where the operator is
 * commutative. Literals count by their converted value (`x | 2 ** 32`). */
export function bitwiseIdentityOperand(e: IrExpr & { kind: "bin" }): "left" | "right" | null {
  const neutral = (literal: IrExpr): boolean => {
    if (literal.kind !== "numLit") return false;
    if (e.op === "&") return (literal.value | 0) === -1;
    if (e.op === "|" || e.op === "^") return (literal.value | 0) === 0;
    return false;
  };
  if (e.op === "<<" || e.op === ">>" || e.op === ">>>")
    return e.right.kind === "numLit" && ((e.right.value >>> 0) & 31) === 0 ? "left" : null;
  if (e.op !== "&" && e.op !== "|" && e.op !== "^") return null;
  if (neutral(e.right)) return "left";
  if (neutral(e.left)) return "right";
  return null;
}

/** Whole-program facts about storage outside the analyzed function, each
 * proven by the caller (int32-slots.ts): every value a field slot, a
 * captured (boxed) binding or a function result can hold, and the values
 * every caller passes to a parameter. Absent entries carry no proof. */
export interface IntegerSlotFacts {
  params?: ReadonlyMap<string, IntegerRange>;
  field?: (className: string, field: string) => IntegerRange | null;
  call?: (callee: string) => IntegerRange | null;
  boxed?: (localId: string) => IntegerRange | null;
  /** Locals and globals an Int32 contract covers (ir/contract-check.ts):
   * every write anywhere is proven int32, so every read is one. */
  locals?: (localId: string) => IntegerRange | null;
  /** Number arrays whose every present element is an int32 (Int32[]
   * contracts): an element read that found a value reads an int32. */
  elements?: (arr: IrExpr) => boolean;
  /** Element reads narrowed out of a union (`xs[i]!`, also when a union
   * local holds the read) keep the element's range, and a ternary arm that
   * always throws yields no value. Only modules with int32 array candidates
   * (ir/int32-arrays.ts) set it, so no other program's ranges change. */
  narrowedReads?: boolean;
}

/** A local read, or a numeric local plus or minus an integer literal
 * (`i + 1`, `1 + i`, `i - 2`): the local and its offset. */
function offsetRef(e: IrExpr): { localId: string; offset: number } | null {
  if (e.kind === "varRef") return { localId: e.localId, offset: 0 };
  if (e.kind !== "bin" || (e.op !== "+" && e.op !== "-") || e.type.kind !== "f64") return null;
  const literal = (x: IrExpr): number | null =>
    x.kind === "numLit" && Number.isSafeInteger(x.value) && !Object.is(x.value, -0)
      ? x.value
      : null;
  const right = literal(e.right);
  if (e.left.kind === "varRef" && e.left.type.kind === "f64" && right !== null)
    return { localId: e.left.localId, offset: e.op === "+" ? right : -right };
  const left = literal(e.left);
  if (e.op === "+" && e.right.kind === "varRef" && e.right.type.kind === "f64" && left !== null)
    return { localId: e.right.localId, offset: left };
  return null;
}

/** Library calls that always throw. */
const THROWING_LIB = /^error\.\w*Throw$/;

function throws(e: IrExpr): boolean {
  return e.kind === "libCall" && THROWING_LIB.test(e.fn);
}

/** The values written to each union-typed local of `fn` by declarations
 * and assignments; null for a local that another write reaches or that a
 * closure captures. */
function unionLocalWrites(
  fn: IrFunction,
  captures: ReadonlySet<string>,
): Map<string, IrExpr[] | null> {
  const unionLocals = new Set(
    fn.locals
      .filter((l) => l.type.kind === "union" && !l.boxed && !captures.has(l.id))
      .map((l) => l.id),
  );
  const result = new Map<string, IrExpr[] | null>();
  const add = (id: string, value: IrExpr | null): void => {
    if (!unionLocals.has(id)) return;
    const list = result.get(id);
    if (list === null) return;
    if (value === null) result.set(id, null);
    else if (list) list.push(value);
    else result.set(id, [value]);
  };
  everyStmtList(fn.body, {
    stmt: (s) => {
      if (s.kind === "varDecl" && s.init) add(s.localId, s.init);
      else if (s.kind === "assign") add(s.localId, s.value);
      else if (s.kind === "forOf") add(s.localId, null);
      else if (s.kind === "tryCatch" && s.catchLocalId) add(s.catchLocalId, null);
      return true;
    },
    expr: (e) => {
      if (e.kind === "assignExpr") add(e.localId, null);
      return true;
    },
  });
  return result;
}

/** Structured local dataflow. Calls cannot write uncaptured local slots,
 * but argument expressions can; unknown evaluation forms invalidate all
 * syntactically written slots before their children are inspected. Loops
 * discard loop-carried facts and retain only invariant or induction facts,
 * except closed locals: a local whose region-entry value is inside a fixed
 * bound (int32, uint32 or non-negative int32) and whose every write inside
 * the region evaluates inside it, assuming every such local is (bitwise
 * results, exact `+ - * %` over in-range operands such as
 * `v = (v * 31 + n) % 1000003`, literals and slots in range), keeps the
 * range those writes and its entry value span across the region.
 * Suspensions and captured bindings deliberately remain outside the proof. */
export function analyzeIntegerRanges(fn: IrFunction, slots: IntegerSlotFacts = {}): IntegerRanges {
  return analyzeIntegerRangeFacts(fn, slots).ranges;
}

/** analyzeIntegerRanges with the loop ranges of the function's for loops. */
export function analyzeIntegerRangeFacts(
  fn: IrFunction,
  slots: IntegerSlotFacts = {},
  entries?: LoopEntryAssumptions,
): IntegerRangeFacts {
  const ranges = new Map<IrExpr, IntegerRange | null>();
  const loopRanges = new Map<IrStmt, Map<string, IntegerRange>>();
  if (fn.async || fn.generator) return { ranges, loopRanges };
  const captures = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  const eligible = new Set(
    fn.locals
      .filter((l) => l.type.kind === "f64" && !l.boxed && !l.tdz && !captures.has(l.id))
      .map((l) => l.id),
  );
  const loopLocals = new Map(fn.locals.filter((l) => !captures.has(l.id)).map((l) => [l.id, l]));
  // With narrowed reads, the values written to union locals (an element
  // read held before it is narrowed), or null for a local some other write
  // (assignExpr, for-of, catch, capture) reaches.
  const unionWrites = slots.narrowedReads ? unionLocalWrites(fn, captures) : null;
  // A captured binding has no local dataflow: only a proof that covers
  // every write of the shared box anywhere applies to its reads.
  const boxedRange = (localId: string): IntegerRange | null => {
    const boxed = eligible.has(localId) ? null : (slots.boxed?.(localId) ?? null);
    return boxed ?? slots.locals?.(localId) ?? null;
  };
  const slotRange = (e: IrExpr): IntegerRange | null =>
    e.type.kind !== "f64"
      ? null
      : e.kind === "fieldGet"
        ? (slots.field?.(e.className, e.field) ?? null)
        : e.kind === "call"
          ? (slots.call?.(e.callee) ?? null)
          : e.kind === "arrayGet" && slots.elements?.(e.arr) === true
            ? INT32_RANGE
            : null;

  /** Every write of a local in the given nodes: the written value, or null
   * for writes whose value is not an ordinary expression (++/--, for-of
   * and catch bindings). Declarations are reported separately. */
  function regionWrites(nodes: (IrExpr | IrStmt)[]): {
    values: Map<string, (IrExpr | null)[]>;
    declared: Set<string>;
  } {
    const values = new Map<string, (IrExpr | null)[]>();
    const declared = new Set<string>();
    const add = (id: string, value: IrExpr | null): void => {
      if (!eligible.has(id)) return;
      const list = values.get(id);
      if (list) list.push(value);
      else values.set(id, [value]);
    };
    const walkExpr = (value: IrExpr): boolean => {
      if (value.kind === "assignExpr") add(value.localId, value.value);
      else if (value.kind === "incDec") add(value.localId, null);
      return everyExprChild(value, walkExpr, walkStmt);
    };
    const walkStmt = (value: IrStmt): boolean => {
      if (value.kind === "assign") add(value.localId, value.value);
      else if (value.kind === "varDecl") {
        declared.add(value.localId);
        if (value.init) add(value.localId, value.init);
      } else if (value.kind === "forOf") add(value.localId, null);
      else if (value.kind === "tryCatch" && value.catchLocalId) add(value.catchLocalId, null);
      return everyStmtChild(value, walkExpr, walkStmt);
    };
    for (const node of nodes) {
      if ("type" in node) walkExpr(node as IrExpr);
      else walkStmt(node as IrStmt);
    }
    return { values, declared };
  }
  let functionWrites: Map<string, (IrExpr | null)[]> | null = null;
  const noInvariants = new Map<string, IntegerRange>();

  /** Locals that hold an exact integer inside a fixed bound (int32, uint32
   * or non-negative int32) everywhere inside and after a region whose
   * control flow this analysis does not follow, with a range inside that
   * bound. A candidate either enters with a fact inside the bound or is
   * declared inside the region and written only there (definite assignment:
   * every read follows one of those writes). For each bound, the greatest
   * fixpoint keeps candidates whose every write evaluates inside it, by the
   * same interval rules as `expr` (exact safe integers, never -0), while the
   * candidates are assumed inside it; the closures are independent, so a
   * local written both ways (`x | 0` and `x >>> 0`) closes under neither
   * int32 nor uint32. `invariant` holds ranges of locals that hold at every
   * read inside the region (an induction counter the body never writes).
   *
   * The closed range then narrows to the entry fact joined with the writes'
   * values under the bound: by induction over the region's execution every
   * candidate stays inside its narrowed range (itself inside the bound), so
   * each write evaluates inside the hull the bound proved for it. */
  function closedLocals(
    nodes: (IrExpr | IrStmt)[],
    entry: Facts,
    invariant: ReadonlyMap<string, IntegerRange>,
  ): Map<string, IntegerRange> {
    const { values, declared } = regionWrites(nodes);
    const result = new Map<string, IntegerRange>();
    if (values.size === 0) return result;
    const within = (bound: IntegerRange, range: IntegerRange | null | undefined): boolean =>
      !!range && range.min >= bound.min && range.max <= bound.max;
    const closure = (bound: IntegerRange): Map<string, IntegerRange> => {
      const closed = new Set<string>();
      for (const [id, list] of values) {
        if (within(bound, entry.get(id))) closed.add(id);
        else if (declared.has(id)) {
          functionWrites ??= regionWrites(fn.body).values;
          if (functionWrites.get(id)?.length === list.length) closed.add(id);
        }
      }
      // The values an expression can produce while every closed candidate
      // holds a value inside `bound`, or null.
      const value = (e: IrExpr): IntegerRange | null => {
        if (e.type.kind !== "f64") return null;
        switch (e.kind) {
          case "numLit":
            return Number.isSafeInteger(e.value) && !Object.is(e.value, -0)
              ? { min: e.value, max: e.value }
              : null;
          case "bin": {
            const left = value(e.left),
              right = value(e.right);
            if (isBitwiseOp(e.op))
              return bitwiseRange(e.op, operandView(e.left, left), operandView(e.right, right));
            return left && right ? integerArithmeticRange(e.op, left, right) : null;
          }
          case "unary": {
            const operand = value(e.operand);
            if (e.op === "~") {
              const bits = int32View(operandView(e.operand, operand));
              return { min: -bits.max - 1, max: -bits.min - 1 };
            }
            // -x is -0 for x = 0.
            return e.op === "-" && operand && (operand.max < 0 || operand.min > 0)
              ? { min: -operand.max, max: -operand.min }
              : null;
          }
          case "libCall": {
            if (e.fn === "math.imul") return SIGNED;
            if (e.fn === "math.clz32") return { min: 0, max: 32 };
            if ((e.fn === "math.min" || e.fn === "math.max") && e.args.length > 0) {
              const args = e.args.map(value);
              if (args.some((a) => a === null)) return null;
              const known = args as IntegerRange[];
              const mins = known.map((a) => a.min),
                maxes = known.map((a) => a.max);
              return e.fn === "math.min"
                ? { min: Math.min(...mins), max: Math.min(...maxes) }
                : { min: Math.max(...mins), max: Math.max(...maxes) };
            }
            return null;
          }
          case "ternary": {
            const yes = value(e.then),
              no = value(e.else_);
            return yes && no ? union(yes, no) : null;
          }
          case "logical": {
            const left = value(e.left),
              right = value(e.right);
            return left && right ? union(left, right) : null;
          }
          case "assignExpr":
            return value(e.value);
          case "seqExpr":
            return value(e.result);
          case "varRef": {
            const known = invariant.get(e.localId);
            if (known) return known;
            if (closed.has(e.localId)) return bound;
            if (!values.has(e.localId) && entry.has(e.localId)) return entry.get(e.localId)!;
            return boxedRange(e.localId);
          }
          case "fieldGet":
          case "arrayGet":
          case "call":
            return slotRange(e);
          default:
            return null;
        }
      };
      const hulls = new Map<string, IntegerRange>();
      for (let changed = true; changed;) {
        changed = false;
        for (const id of closed) {
          let hull: IntegerRange | null = entry.get(id) ?? null;
          for (const write of values.get(id)!) {
            const range = write && value(write);
            if (!within(bound, range)) {
              hull = null;
              break;
            }
            hull = hull ? union(hull, range!) : range;
          }
          if (hull) hulls.set(id, hull);
          else {
            closed.delete(id);
            changed = true;
          }
        }
      }
      return new Map([...closed].map((id) => [id, hulls.get(id)!]));
    };
    const closures = [closure(SIGNED), closure(UNSIGNED), closure(NON_NEGATIVE)];
    for (const id of entry.keys()) {
      let range: IntegerRange | null = null;
      for (const closed of closures) {
        const hull = closed.get(id);
        if (hull)
          range = range
            ? { min: Math.max(range.min, hull.min), max: Math.min(range.max, hull.max) }
            : hull;
      }
      if (range) result.set(id, range);
    }
    return result;
  }

  // Loop ranges of the bindings the enclosing for loops bound
  // (boundedIntegerLoopFacts) while their bodies are analyzed.
  let counterRanges: ReadonlyMap<string, IntegerRange> = new Map();
  /** The value a write stores in a binding a for loop bounds. Every value
   * the binding holds in the loop lies in its loop range, so the written
   * value takes that range even when its operands' ranges add past it
   * (`changes = changes + 1` with `changes` at the loop's limit). */
  function boundedWrite(id: string, value: IrExpr, facts: Facts): IntegerRange | null {
    const bound = counterRanges.get(id);
    const before = ranges.get(value);
    const computed = expr(value, facts);
    if (!bound) return computed;
    const range = computed
      ? { min: Math.max(computed.min, bound.min), max: Math.min(computed.max, bound.max) }
      : bound;
    if (range.min > range.max) return computed;
    ranges.set(value, before === undefined ? range : before ? union(before, range) : null);
    return range;
  }

  /** narrowedRange through a union local: every value written to it. */
  function narrowedValue(
    value: IrExpr,
    unionId: string,
    tag: number,
  ): IntegerRange | null | "never" {
    if (value.kind !== "varRef") return narrowedRange(value, unionId, tag);
    const written = unionWrites?.get(value.localId);
    if (!written || written.length === 0) return null;
    let result: IntegerRange | null | "never" = "never";
    for (const w of written) {
      const arm = narrowedRange(w, unionId, tag);
      if (arm === "never") continue;
      if (arm === null) return null;
      result = result === "never" ? arm : union(result, arm);
    }
    return result;
  }
  /** The range of the values of union tag `tag` that `value` (already
   * analyzed) can hold: "never" when no arm holds that tag. */
  function narrowedRange(
    value: IrExpr,
    unionId: string,
    tag: number,
  ): IntegerRange | null | "never" {
    if (value.kind === "seqExpr") return narrowedRange(value.result, unionId, tag);
    if (value.kind === "ternary") {
      const yes = narrowedRange(value.then, unionId, tag),
        no = narrowedRange(value.else_, unionId, tag);
      if (yes === "never") return no;
      if (no === "never") return yes;
      return yes && no ? union(yes, no) : null;
    }
    if (value.kind === "unionWrap" && value.unionId === unionId) {
      if (value.tag !== tag) return "never";
      return value.value.kind === "arrayGet" ? (ranges.get(value.value) ?? null) : null;
    }
    return null;
  }
  function remember(e: IrExpr, range: IntegerRange | null): IntegerRange | null {
    // Shared IR objects have to satisfy the proof at every occurrence.
    const previous = ranges.get(e);
    ranges.set(
      e,
      previous === undefined ? range : previous && range ? union(previous, range) : null,
    );
    return range;
  }
  function set(facts: Facts, id: string, range: IntegerRange | null): void {
    if (range && eligible.has(id)) facts.set(id, range);
    else facts.delete(id);
  }
  function writes(node: IrExpr | IrStmt): Set<string> {
    const result = new Set<string>();
    const e = (value: IrExpr): boolean => {
      if (value.kind === "assignExpr" || value.kind === "incDec") result.add(value.localId);
      return true;
    };
    const s = (value: IrStmt): boolean => {
      if (value.kind === "assign" || value.kind === "varDecl" || value.kind === "forOf")
        result.add(value.localId);
      if (value.kind === "tryCatch" && value.catchLocalId) result.add(value.catchLocalId);
      return true;
    };
    const walkExpr = (value: IrExpr): boolean =>
      e(value) && everyExprChild(value, walkExpr, walkStmt);
    const walkStmt = (value: IrStmt): boolean =>
      s(value) && everyStmtChild(value, walkExpr, walkStmt);
    if ("type" in node) walkExpr(node as IrExpr);
    else walkStmt(node as IrStmt);
    return result;
  }
  function invalidate(facts: Facts, nodes: (IrExpr | IrStmt)[]): void {
    for (const node of nodes) for (const id of writes(node)) facts.delete(id);
  }
  /** Invalidate the region's writes, keeping int32- and uint32-closed
   * locals at their closed range. `entry` is the state before any of the
   * region's writes can run. */
  function havoc(facts: Facts, nodes: (IrExpr | IrStmt)[], entry: Facts): void {
    havocWith(facts, nodes, entry, noInvariants);
  }
  /** `havoc` with ranges that hold at every read inside the region. */
  function havocWith(
    facts: Facts,
    nodes: (IrExpr | IrStmt)[],
    entry: Facts,
    invariant: ReadonlyMap<string, IntegerRange>,
  ): void {
    const closed = closedLocals(nodes, entry, invariant);
    invalidate(facts, nodes);
    for (const [id, range] of closed) facts.set(id, range);
  }
  function refine(condition: IrExpr, truth: boolean, facts: Facts): void {
    // A comparison constrains operand snapshots. If evaluating it writes a
    // binding, the current slot may no longer contain the compared value.
    if (writes(condition).size > 0) return;
    if (condition.kind === "toBool") return refine(condition.operand, truth, facts);
    if (condition.kind === "unary" && condition.op === "!")
      return refine(condition.operand, !truth, facts);
    if (
      condition.kind === "logical" &&
      ((condition.op === "&&" && truth) || (condition.op === "||" && !truth))
    ) {
      refine(condition.left, truth, facts);
      refine(condition.right, truth, facts);
      return;
    }
    if (condition.kind !== "bin") return;
    let ref = condition.left;
    let bound = condition.right;
    let op: string = condition.op;
    if (offsetRef(ref) === null && offsetRef(bound) !== null) {
      [ref, bound] = [bound, ref];
      op =
        (
          { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "===": "===", "!==": "!==" } as Record<
            string,
            string
          >
        )[op] ?? "";
    }
    const target = offsetRef(ref);
    if (target === null) return;
    const literalBound =
      bound.kind === "numLit" && Number.isFinite(bound.value)
        ? { min: bound.value, max: bound.value }
        : ranges.get(bound);
    if (!literalBound) return;
    // An Int32 contract local holds an int32 even where the dataflow has
    // no fact for it (loop headers, after unknown regions).
    const previous =
      facts.get(target.localId) ??
      (eligible.has(target.localId) ? (slots.locals?.(target.localId) ?? undefined) : undefined);
    if (!previous) return;
    // `x + c < b` bounds x as `x < b - c` does. A sum that rounds has a
    // magnitude of at least 2^53, so against a bound within 2^52 every
    // comparison answers as the exact sum would.
    const offset = target.offset;
    if (
      offset !== 0 &&
      (Math.abs(offset) > 2 ** 31 ||
        Math.abs(literalBound.min) > 2 ** 52 ||
        Math.abs(literalBound.max) > 2 ** 52)
    )
      return;
    if (!truth)
      op =
        (
          { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "===": "!==", "!==": "===" } as Record<
            string,
            string
          >
        )[op] ?? "";
    // The sum `x + c` is an integer, so the bound rounds to an integer first
    // and the offset comes off after: integer arithmetic below 2^53 is exact,
    // where subtracting the offset from a fractional bound could round
    // across an integer.
    let { min, max } = previous;
    if (op === "<") max = Math.min(max, Math.ceil(literalBound.max) - 1 - offset);
    else if (op === "<=") max = Math.min(max, Math.floor(literalBound.max) - offset);
    else if (op === ">") min = Math.max(min, Math.floor(literalBound.min) + 1 - offset);
    else if (op === ">=") min = Math.max(min, Math.ceil(literalBound.min) - offset);
    else if (op === "===") {
      min = Math.max(min, Math.ceil(literalBound.min) - offset);
      max = Math.min(max, Math.floor(literalBound.max) - offset);
    } else if (
      op === "!==" &&
      literalBound.min === literalBound.max &&
      Number.isInteger(literalBound.min)
    ) {
      // Excluding one value narrows a range that ends at it.
      const excluded = literalBound.min - offset;
      if (min === excluded) min += 1;
      else if (max === excluded) max -= 1;
    }
    if (min <= max && Number.isInteger(min) && Number.isInteger(max))
      facts.set(target.localId, { min, max });
  }
  function expr(e: IrExpr, facts: Facts): IntegerRange | null {
    let range: IntegerRange | null = null;
    switch (e.kind) {
      case "numLit":
        if (Number.isSafeInteger(e.value) && !Object.is(e.value, -0))
          range = { min: e.value, max: e.value };
        break;
      case "varRef":
        range = facts.get(e.localId) ?? boxedRange(e.localId);
        break;
      case "assignExpr":
        range = boundedWrite(e.localId, e.value, facts);
        set(facts, e.localId, range);
        break;
      case "incDec": {
        // A binding a for loop bounds holds a value in its loop range at
        // every point of the loop, also where a statement around this
        // increment has discarded its fact.
        const bound = counterRanges.get(e.localId);
        const before = facts.get(e.localId) ?? bound ?? null;
        const sum = before ? integerArithmeticRange(e.op, before, { min: 1, max: 1 }) : null;
        const after =
          bound && sum
            ? { min: Math.max(sum.min, bound.min), max: Math.min(sum.max, bound.max) }
            : sum;
        set(facts, e.localId, after);
        range = e.prefix ? after : before;
        break;
      }
      case "bin": {
        const left = expr(e.left, facts);
        const right = expr(e.right, facts);
        if (e.type.kind !== "f64") break;
        if (isBitwiseOp(e.op))
          range = bitwiseRange(e.op, operandView(e.left, left), operandView(e.right, right));
        else if (left && right) range = integerArithmeticRange(e.op, left, right);
        break;
      }
      case "unary": {
        const operand = expr(e.operand, facts);
        if (e.op === "~") {
          const value = int32View(operandView(e.operand, operand));
          range = { min: -value.max - 1, max: -value.min - 1 };
        } else if (e.op === "-" && operand && (operand.max < 0 || operand.min > 0))
          range = { min: -operand.max, max: -operand.min };
        break;
      }
      case "ternary": {
        expr(e.cond, facts);
        const yes = new Map(facts),
          no = new Map(facts);
        refine(e.cond, true, yes);
        refine(e.cond, false, no);
        const left = expr(e.then, yes),
          right = expr(e.else_, no);
        merge(facts, yes, no);
        if (left && right) range = union(left, right);
        // With narrowed reads: an arm that always throws yields no value,
        // so the other arm's range is the result's.
        else if (slots.narrowedReads && throws(e.then)) range = right;
        else if (slots.narrowedReads && throws(e.else_)) range = left;
        break;
      }
      case "logical": {
        const left = expr(e.left, facts);
        const skipped = new Map(facts),
          evaluated = new Map(facts);
        refine(e.left, e.op === "&&", evaluated);
        const right = expr(e.right, evaluated);
        merge(facts, skipped, evaluated);
        if (left && right) range = union(left, right);
        break;
      }
      case "seqExpr":
        body(e.stmts, facts);
        range = expr(e.result, facts);
        break;
      case "libCall": {
        const args = e.args.map((a) => expr(a, facts));
        if (e.fn === "math.imul") range = SIGNED;
        else if (e.fn === "math.clz32") range = { min: 0, max: 32 };
        else if (
          (e.fn === "math.min" || e.fn === "math.max") &&
          args.length > 0 &&
          args.every((a) => a !== null)
        ) {
          const known = args as IntegerRange[];
          const mins = known.map((a) => a.min),
            maxes = known.map((a) => a.max);
          range =
            e.fn === "math.min"
              ? { min: Math.min(...mins), max: Math.min(...maxes) }
              : { min: Math.max(...mins), max: Math.max(...maxes) };
        }
        break;
      }
      case "bytesIntrinsic": {
        expr(e.receiver, facts);
        for (const arg of e.args) expr(arg, facts);
        const numeric = byteNumberAccess(e);
        if (numeric && !numeric.write) range = byteNumberRange(numeric);
        else if (e.method === "length" || e.method === "byteLength" || e.method === "byteOffset")
          range = BYTES_LENGTH_RANGE;
        else if (e.method === "get" && e.invalidNaN !== true && e.receiver.type.kind === "bytes") {
          const elem = e.receiver.type.elem;
          if (elem === "u8" || elem === "u8c") range = { min: 0, max: 255 };
          else if (elem === "i8") range = { min: -128, max: 127 };
          else if (elem === "u16") range = { min: 0, max: 65535 };
          else if (elem === "i16") range = { min: -32768, max: 32767 };
          else if (elem === "u32") range = UNSIGNED;
          else if (elem === "i32") range = SIGNED;
        }
        break;
      }
      case "arrIntrinsic":
        // Callbacks and arguments can have writes hidden in lazy lowering.
        havoc(facts, [e], facts);
        everyExprChild(
          e,
          (child) => {
            expr(child, new Map(facts));
            return true;
          },
          (child) => {
            body([child], new Map(facts));
            return true;
          },
        );
        if (e.method === "length") range = UNSIGNED;
        break;
      case "strIntrinsic":
        // The conservative child handling of unknown forms; only the result
        // range is new: a length or a found index is an int32.
        havoc(facts, [e], facts);
        everyExprChild(
          e,
          (child) => {
            expr(child, new Map(facts));
            return true;
          },
          (child) => {
            body([child], new Map(facts));
            return true;
          },
        );
        if (e.type.kind === "f64") {
          if (e.method === "length") range = { min: 0, max: STRING_MAX_UNITS };
          // A string holds at most SCR_STR_MAX_CAP (0x7fffffff) bytes.
          else if (e.method === "byteLength") range = { min: 0, max: STRING_MAX_UNITS };
          // An empty needle is found at the clamped position, up to the length.
          else if (e.method === "indexOf") range = { min: -1, max: STRING_MAX_UNITS };
        }
        break;
      case "fieldGet":
        expr(e.obj, facts);
        range = slotRange(e);
        break;
      case "unionNarrow":
        // Only modules with narrowed reads take this rule: the narrow
        // evaluates its operand first, and throws for every arm of another
        // tag, so an element read `xs[i]!` (a ternary of the wrapped
        // element and a wrapped undefined) has the element's range.
        if (!slots.narrowedReads || e.type.kind !== "f64") {
          range = conservative(e, facts);
          break;
        }
        expr(e.value, facts);
        {
          const arm = narrowedValue(e.value, e.unionId, e.tag);
          range = arm === "never" ? null : arm;
        }
        break;
      default:
        range = conservative(e, facts);
        break;
    }
    return remember(e, range);
  }
  /** An unknown node: do not assume the traversal order is an evaluation
   * order. Every child gets the same conservative entry state. */
  function conservative(e: IrExpr, facts: Facts): IntegerRange | null {
    havoc(facts, [e], facts);
    everyExprChild(
      e,
      (child) => {
        expr(child, new Map(facts));
        return true;
      },
      (child) => {
        body([child], new Map(facts));
        return true;
      },
    );
    // A direct call's result carries its whole-program return proof.
    return slotRange(e);
  }
  function induction(
    s: IrStmt & { kind: "for" },
    facts: Facts,
  ): { id: string; range: IntegerRange } | null {
    if (s.init?.kind !== "varDecl" || !eligible.has(s.init.localId)) return null;
    const id = s.init.localId,
      start = facts.get(id);
    if (!start) return null;
    let step = 0;
    const update = s.update;
    if (
      update?.kind === "assign" &&
      update.localId === id &&
      update.value.kind === "bin" &&
      update.value.left.kind === "varRef" &&
      update.value.left.localId === id &&
      update.value.right.kind === "numLit" &&
      update.value.right.value === 1
    ) {
      step = update.value.op === "+" ? 1 : update.value.op === "-" ? -1 : 0;
    } else if (
      update?.kind === "exprStmt" &&
      update.expr.kind === "incDec" &&
      update.expr.localId === id
    )
      step = update.expr.op === "+" ? 1 : -1;
    if (!step || s.body.some((node) => writes(node).has(id)) || (s.cond && writes(s.cond).has(id)))
      return null;
    return {
      id,
      range:
        step > 0 ? { min: start.min, max: EXACT_LIMIT } : { min: -EXACT_LIMIT, max: start.max },
    };
  }
  function body(stmts: IrStmt[], facts: Facts): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "varDecl":
          set(facts, s.localId, s.init ? expr(s.init, facts) : null);
          break;
        case "assign":
          set(facts, s.localId, boundedWrite(s.localId, s.value, facts));
          break;
        case "exprStmt":
          expr(s.expr, facts);
          break;
        case "return":
          if (s.value) expr(s.value, facts);
          facts.clear();
          break;
        case "block": {
          const before = new Map(facts);
          body(s.body, facts);
          // A labeled break can skip the tail of this block. We have no
          // exit-edge lattice here, so discard its written facts at a join.
          if (
            !everyStmtList(s.body, {
              expr: () => true,
              stmt: (node) => node.kind !== "break" && node.kind !== "continue",
            })
          )
            havoc(facts, s.body, before);
          break;
        }
        case "if": {
          expr(s.cond, facts);
          const yes = new Map(facts),
            no = new Map(facts);
          refine(s.cond, true, yes);
          refine(s.cond, false, no);
          body(s.then, yes);
          if (s.else_) body(s.else_, no);
          if (!integerPathFallsThrough(s.then)) {
            facts.clear();
            for (const [id, range] of no) facts.set(id, range);
          } else if (s.else_ && !integerPathFallsThrough(s.else_)) {
            facts.clear();
            for (const [id, range] of yes) facts.set(id, range);
          } else merge(facts, yes, no);
          break;
        }
        case "for": {
          if (s.init) body([s.init], facts);
          // The initializer writes none of the assumed locals.
          const assumed = entries?.get(s);
          if (assumed) for (const [id, range] of assumed) if (!facts.has(id)) set(facts, id, range);
          const counter = induction(s, facts);
          const bounded = boundedIntegerLoopFacts(s, loopLocals, facts);
          const loop = new Map(facts);
          // Only the update writes the counter, so its header range holds at
          // every read in the condition, the body and the update.
          const invariant = new Map<string, IntegerRange>();
          if (counter) invariant.set(counter.id, counter.range);
          if (s.init?.kind === "varDecl") {
            const id = s.init.localId,
              range = bounded.get(id),
              other = invariant.get(id);
            if (range)
              invariant.set(
                id,
                other
                  ? { min: Math.max(range.min, other.min), max: Math.min(range.max, other.max) }
                  : range,
              );
          }
          havocWith(
            loop,
            [...s.body, ...(s.cond ? [s.cond] : []), ...(s.update ? [s.update] : [])],
            loop,
            invariant,
          );
          if (counter) loop.set(counter.id, counter.range);
          for (const [id, range] of bounded) loop.set(id, range);
          if (s.cond) expr(s.cond, loop);
          const inside = new Map(loop);
          if (s.cond) refine(s.cond, true, inside);
          // Only the body's writes are the ones the bound counted.
          const outer = counterRanges;
          const headWrites = s.cond ? writes(s.cond) : new Set<string>();
          if (s.update) for (const id of writes(s.update)) headWrites.add(id);
          const cursors = new Map<string, IntegerRange>();
          for (const [id, range] of bounded)
            if (id !== counter?.id && !headWrites.has(id)) cursors.set(id, range);
          // A loop analyzed again (inside another loop) keeps the bindings
          // every analysis bounds, with the union of their ranges.
          const previous = loopRanges.get(s);
          if (!previous) loopRanges.set(s, cursors);
          else
            for (const [id, range] of previous) {
              const other = cursors.get(id);
              if (other) previous.set(id, union(range, other));
              else previous.delete(id);
            }
          const active = new Map(outer);
          for (const [id, range] of cursors) active.set(id, range);
          counterRanges = active;
          try {
            body(s.body, inside);
          } finally {
            counterRanges = outer;
          }
          // Continue can bypass any body assignment. The update therefore
          // starts from header invariants rather than the body's exit facts,
          // plus what the condition proved about bindings the body never
          // writes (they still hold the values the condition tested).
          if (s.update) {
            const entry = new Map(loop);
            if (s.cond) {
              const refined = new Map(loop);
              refine(s.cond, true, refined);
              const written = new Set<string>();
              for (const node of s.body) for (const id of writes(node)) written.add(id);
              for (const [id, range] of refined) if (!written.has(id)) entry.set(id, range);
            }
            body([s.update], entry);
          }
          havoc(facts, [s], facts);
          if (assumed) {
            invalidate(facts, [s]);
            for (const id of assumed.keys()) facts.delete(id);
          }
          break;
        }
        case "while":
        case "doWhile": {
          const assumed = entries?.get(s);
          if (assumed) for (const [id, range] of assumed) if (!facts.has(id)) set(facts, id, range);
          // Counters the condition bounds keep their range at every read
          // inside and after the loop.
          const guarded =
            s.kind === "while" ? guardedLoopCounterFacts(s, loopLocals, facts) : noInvariants;
          // The same bounds hold on entry and at every write in the loop,
          // which is what a proven integer loop needs (loopRanges). A loop
          // analyzed again keeps the bindings every analysis bounds.
          if (s.kind === "while") {
            const previous = loopRanges.get(s);
            if (!previous) loopRanges.set(s, new Map(guarded));
            else
              for (const [id, range] of previous) {
                const other = guarded.get(id);
                if (other) previous.set(id, union(range, other));
                else previous.delete(id);
              }
          }
          const loop = new Map(facts);
          havocWith(loop, [s], loop, guarded);
          for (const [id, range] of guarded) set(loop, id, range);
          const header = new Map(loop);
          expr(s.cond, header);
          if (s.kind === "while") {
            refine(s.cond, true, header);
            body(s.body, header);
          } else body(s.body, new Map(loop));
          havocWith(facts, [s], facts, guarded);
          for (const [id, range] of guarded) set(facts, id, range);
          if (assumed) {
            invalidate(facts, [s]);
            for (const id of assumed.keys()) facts.delete(id);
          }
          break;
        }
        case "forOf": {
          expr(s.iterable, facts);
          const loop = new Map(facts);
          havoc(loop, [s], loop);
          body(s.body, loop);
          havoc(facts, [s], facts);
          break;
        }
        case "tryCatch":
          // Catch/finally, fallthrough and nonlocal exits need their own
          // control-flow joins. Analyze each region from invariant facts.
          havoc(facts, [s], facts);
          body(s.tryBody, new Map(facts));
          if (s.catchBody) body(s.catchBody, new Map(facts));
          if (s.finallyBody) body(s.finallyBody, new Map(facts));
          break;
        case "switch":
          havoc(facts, [s], facts);
          expr(s.disc, new Map(facts));
          for (const region of s.cases) {
            if (region.test) expr(region.test, new Map(facts));
            body(region.body, new Map(facts));
          }
          break;
        case "break":
        case "continue":
          // An outer labeled jump can bypass following assignments. Clearing
          // the continuing path is conservative; loop exits discard writes.
          facts.clear();
          break;
        default:
          havoc(facts, [s], facts);
          everyStmtChild(
            s,
            (child) => {
              expr(child, new Map(facts));
              return true;
            },
            (child) => {
              body([child], new Map(facts));
              return true;
            },
          );
          break;
      }
    }
  }
  const entry: Facts = new Map();
  if (slots.params) for (const [id, range] of slots.params) set(entry, id, range);
  body(fn.body, entry);
  return { ranges, loopRanges };
}
