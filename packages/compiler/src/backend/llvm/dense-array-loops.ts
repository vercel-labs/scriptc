/* Dense array loops: a versioned copy of an index loop over an array whose
 * length the loop never changes.
 *
 * `for (let i = 0; i < a.length; i++) b[i] = a[i] * 2` reads its bound from
 * `a`, and every element access at the counter normally tests the index
 * against the array's hole-free prefix bound (`filled`, see
 * dense-array-access.ts) before it touches the slot. When the loop provably
 * never changes `a.length` (ir/array-length-stability.ts) and never moves or
 * cuts the storage of the arrays it indexes, one test before the loop covers
 * every pass: if `a.length` is at most each indexed array's `filled` bound,
 * every counter value the loop can reach (at least 0, below `a.length`)
 * names a present value in dense storage. The fast copy then reads and
 * replaces those slots directly, which leaves LLVM a loop without
 * per-element branches (vectorizable where the body allows it). The same
 * test bounds `a.length` by 2^31 - 1, so the fast copy's counter is an int32.
 * Arrays longer than that are sparse in practice (a dense one would need
 * 16 GB of slots) and take the ordinary copy, as does every array with a
 * hole, present undefined or sparse storage below `a.length`.
 *
 * A counted loop with another invariant limit, such as `j < n` after
 * `const n = a.length` or `j < 5`, is covered the same way: the test bounds
 * the loop's exclusive limit by 2^31 - 1 and by each indexed array's
 * `filled`, and the loop must provably never change any of their lengths.
 *
 * A two-counter loop closing in on itself, such as
 * `for (let i = 1, j = k - 1; i < j; i++, j--)`, indexes only between its
 * low counter's start and its high counter's: the low counter only rises
 * and stays below the high one, which only falls. Its test bounds the low
 * start below by 0 and the high start by 2^31 - 2 and below each indexed
 * array's `filled`, both starts being exact integers. */

import type { IrExpr, IrLocal, IrStmt } from "../../ir/ir.js";
import type { IntegerRange } from "../../ir/integer-ranges.js";
import { preservesArrayLength } from "../../ir/array-length-stability.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import type { IntegerCountedForLoop, IntegerPairedForLoop } from "../../ir/integer-loops.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { loadArrCount, SCR_ARR_FIELD } from "./common.js";
import { emitCountedLoopLimit, emitStartIntegerTest } from "./counted-loops.js";

export const INT32_MAX = 2147483647;

export interface DenseArrayLoop {
  /** The loop's counter binding. */
  counter: string;
  /** The array whose length bounds the counter, or null for a counted loop
   * bounded by `limit`. */
  length: (IrExpr & { kind: "varRef" }) | null;
  /** The ascending counted loop whose invariant limit bounds the counter,
   * when `length` is null. */
  limit: IntegerCountedForLoop | null;
  /** Arrays whose accesses at the counter are proven to be inside the
   * hole-free prefix in the fast copy, with a read of each binding. */
  arrays: ReadonlyMap<string, IrExpr & { kind: "varRef" }>;
  /** The counter's range on every pass of the fast copy. */
  range: IntegerRange;
  /** A two-counter loop's high counter and both starts, when the counter
   * is its low one (`length` and `limit` are then null). */
  pair: DensePair | null;
}

/** The high counter of a two-counter dense loop, and the starts its entry
 * test bounds. */
export interface DensePair {
  high: string;
  lowStart: IrExpr;
  highStart: IrExpr;
}

/** The fast copy duplicates the loop; keep the duplicated code small. */
const MAX_LOOP_NODES = 160;

/** How a matched integer loop bounds its counter below `length.length`. */
export interface DenseLoopShape {
  counter: string;
  /** The array whose length bounds the counter, or null for `limit`. */
  length: (IrExpr & { kind: "varRef" }) | null;
  /** An ascending counted loop bounded by another invariant limit. */
  limit?: IntegerCountedForLoop;
  /** The counter's proven range on every pass of the ordinary loop; the
   * fast copy keeps its minimum, which must be at least 0. */
  range: IntegerRange;
  /** A two-counter loop's high counter and starts. */
  pair?: DensePair;
}

/** `length.length - c` (c an integer literal, 0 when absent). */
function lengthOffset(e: IrExpr): { receiver: IrExpr & { kind: "varRef" }; offset: number } | null {
  let offset = 0;
  if (
    e.kind === "bin" &&
    e.op === "-" &&
    e.right.kind === "numLit" &&
    Number.isSafeInteger(e.right.value)
  ) {
    offset = e.right.value;
    e = e.left;
  }
  return e.kind === "arrIntrinsic" &&
    e.method === "length" &&
    e.args.length === 0 &&
    e.receiver.kind === "varRef" &&
    e.receiver.type.kind === "array"
    ? { receiver: e.receiver, offset }
    : null;
}

/** The array bounding a counted loop's counter below its length: an
 * ascending loop compared below `a.length - c`, or a descending one starting
 * at `a.length - c` (c >= 1). Another ascending loop is bounded by its own
 * invariant limit. */
export function countedDenseShape(
  loop: IrStmt & { kind: "for" },
  counted: IntegerCountedForLoop,
): DenseLoopShape | null {
  if (counted.range.min < 0) return null;
  if (counted.step > 0) {
    const bound = lengthOffset(counted.limit);
    if (!bound)
      return { counter: counted.localId, length: null, limit: counted, range: counted.range };
    if (bound.offset < (counted.inclusive ? 1 : 0)) return null;
    return { counter: counted.localId, length: bound.receiver, range: counted.range };
  }
  // The start is evaluated once, before the loop; the counter only falls.
  const start = lengthOffset(counted.start);
  if (!start || start.offset < 1 || loop.init?.kind !== "varDecl") return null;
  return { counter: counted.localId, length: start.receiver, range: counted.range };
}

/** The shape of a two-counter loop whose low counter rises and high
 * counter falls: both stay between the two starts, which the entry test
 * bounds, so the fast copy's counters lie in [0, 2^31 - 2]. */
export function pairedDenseShape(loop: IntegerPairedForLoop): DenseLoopShape {
  return {
    counter: loop.low.localId,
    length: null,
    range: { min: 0, max: INT32_MAX - 1 },
    pair: { high: loop.high.localId, lowStart: loop.low.start, highStart: loop.high.start },
  };
}

interface ElementRead {
  arr: IrExpr;
  index: IrExpr;
}

/** The array and index of a call of an element-reader helper
 * (`%arr.idxOr.*`, ir/int32-arrays.ts isElementReader): `a[i]` as
 * `number | undefined`. */
function elementReaderCall(e: IrExpr): ElementRead | null {
  if (e.kind !== "call" || !e.callee.startsWith("%arr.idxOr.") || e.args.length !== 2) return null;
  return { arr: e.args[0]!, index: e.args[1]! };
}

/** The array and index of an element read as `T | undefined`: an
 * element-reader call, or its body inlined for an int32 array
 * (`arrayState(a, i) === 1 ? wrap(a[i]) : wrap(undefined)`). */
function elementRead(e: IrExpr): ElementRead | null {
  const call = elementReaderCall(e);
  if (call) return call;
  if (e.kind !== "ternary") return null;
  const cond = e.cond;
  if (cond.kind !== "bin" || cond.op !== "===") return null;
  const state = cond.left,
    present = cond.right,
    wrapped = e.then,
    missing = e.else_;
  if (state.kind !== "arrayState" || present.kind !== "numLit" || present.value !== 1) return null;
  if (wrapped.kind !== "unionWrap" || missing.kind !== "unionWrap") return null;
  const value = wrapped.value;
  if (value.kind !== "arrayGet" || missing.value.kind !== "unitLit") return null;
  const same = (x: IrExpr, y: IrExpr): boolean =>
    x.kind === "varRef" && y.kind === "varRef" && x.localId === y.localId;
  return same(state.arr, value.arr) && same(state.index, value.index)
    ? { arr: state.arr, index: state.index }
    : null;
}

/** The present-undefined stores of `a[i] = b[j]!` as lowering spells it,
 * with the element read each one stores the missing arm of:
 *
 *   const v = %arr.idxOr(b, j);
 *   if (v is undefined) a[i] = undefined; else a[i] = v is number ? v : throw;
 *
 * The read's local is declared once in the same list as the `if`, and only
 * read after it. */
function missingElementStores(body: IrStmt[]): Map<IrStmt, ElementRead> {
  const result = new Map<IrStmt, ElementRead>();
  const writes = new Map<string, number>();
  const count = (id: string): void => void writes.set(id, (writes.get(id) ?? 0) + 1);
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "assignExpr" || e.kind === "incDec") count(e.localId);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if (s.kind === "varDecl" || s.kind === "assign") count(s.localId);
    return everyStmtChild(s, expr, stmt);
  };
  body.every(stmt);
  const list = (stmts: IrStmt[]): void => {
    const reads = new Map<string, ElementRead>();
    for (const s of stmts) {
      if (s.kind === "varDecl" && s.init && writes.get(s.localId) === 1) {
        const read = elementRead(s.init);
        if (read) reads.set(s.localId, read);
      }
      if (s.kind === "if") {
        const store = missingArmStore(s, reads);
        if (store) result.set(store.stmt, store.read);
      }
      // Nested loops keep a loop out of the fast copy (matchDenseArrayLoop),
      // and other statement lists leave their stores unmatched.
      if (s.kind === "block") list(s.body);
      if (s.kind === "if") {
        list(s.then);
        if (s.else_) list(s.else_);
      }
    }
  };
  list(body);
  return result;
}

/** The present-undefined store of `if (v is undefined) a[i] = undefined;
 * else a[i] = v is number ? v : throw;`, with the read `v` holds. */
function missingArmStore(
  s: IrStmt & { kind: "if" },
  reads: ReadonlyMap<string, ElementRead>,
): { stmt: IrStmt; read: ElementRead } | null {
  const cond = s.cond;
  if (cond.kind !== "unionIsTag" || cond.negated || cond.value.kind !== "varRef") return null;
  const local = cond.value.localId;
  const read = reads.get(local);
  if (!read || s.then.length !== 1 || s.else_?.length !== 1) return null;
  const store = s.then[0]!,
    other = s.else_[0]!;
  if (store.kind !== "arraySetUndefined" || other.kind !== "arraySet") return null;
  const value = other.value;
  if (value.kind !== "ternary") return null;
  const test = value.cond,
    narrowed = value.then;
  if (test.kind !== "unionIsTag" || test.negated || test.tag === cond.tag) return null;
  if (test.value.kind !== "varRef" || test.value.localId !== local) return null;
  if (narrowed.kind !== "unionNarrow" || narrowed.tag !== test.tag) return null;
  return narrowed.type.kind === "f64" ? { stmt: store, read } : null;
}

/** Match the fast copy of a loop of the given shape. `initialized` holds the
 * bindings definitely assigned when the loop starts; `unaliased` the local
 * arrays no other binding holds. */
export function matchDenseArrayLoop(
  loop: IrStmt & { kind: "for" },
  shape: DenseLoopShape,
  locals: ReadonlyMap<string, IrLocal>,
  unaliased: ReadonlySet<string>,
  initialized: ReadonlySet<string>,
): DenseArrayLoop | null {
  const { counter, length } = shape;
  const high = shape.pair?.high ?? null;
  const isCounter = (id: string): boolean => id === counter || id === high;
  if (shape.range.min < 0 || !loop.cond) return null;
  let nodes = 0,
    nested = false;
  const candidates = new Map<string, IrExpr & { kind: "varRef" }>();
  // Arrays written, resized, or indexed other than at the counter by an
  // element write.
  const disturbed = new Set<string>();
  const access = (arr: IrExpr, index: IrExpr): void => {
    if (arr.kind === "varRef" && index.kind === "varRef" && isCounter(index.localId))
      candidates.set(arr.localId, arr);
  };
  const missing = missingElementStores(loop.body);
  // The element reads behind the guarded present-undefined stores.
  const guards: ElementRead[] = [];
  // The arrays of the other present-undefined stores. The fast copy runs
  // them, and the slot each one writes leaves the hole-free prefix.
  const undefinedStores: IrExpr[] = [];
  const expr = (e: IrExpr): boolean => {
    if (++nodes > MAX_LOOP_NODES) return false;
    if (e.kind === "assignExpr" || e.kind === "incDec") disturbed.add(e.localId);
    if (e.kind === "arrayGet") access(e.arr, e.index);
    const reader = elementReaderCall(e);
    if (reader) access(reader.arr, reader.index);
    if (e.kind === "arrIntrinsic") {
      if (e.method === "getNumber" && e.args[0]) access(e.receiver, e.args[0]);
      else if (e.method !== "length" && e.receiver.kind === "varRef")
        disturbed.add(e.receiver.localId);
    }
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if (++nodes > MAX_LOOP_NODES) return false;
    if (s.kind === "for" || s.kind === "while" || s.kind === "doWhile" || s.kind === "forOf")
      nested = true;
    if (s.kind === "assign" || s.kind === "varDecl") disturbed.add(s.localId);
    if (s.kind === "arraySet") {
      access(s.arr, s.index);
      if (s.arr.kind === "varRef" && (s.index.kind !== "varRef" || !isCounter(s.index.localId)))
        disturbed.add(s.arr.localId);
    }
    if (s.kind === "arraySetUndefined") {
      // A present undefined at a counter only where it stores a missing
      // element read (`a[i] = b[j]!`): the fast copy reads a present value
      // there, so the store never runs in it.
      const read = missing.get(s);
      if (read === undefined || s.index.kind !== "varRef" || !isCounter(s.index.localId)) {
        undefinedStores.push(s.arr);
      } else {
        access(s.arr, s.index);
        guards.push(read);
      }
    }
    return everyStmtChild(s, expr, stmt);
  };
  if (!loop.body.every(stmt) || !expr(loop.cond) || nested) return null;
  const nodesOfLoop = [loop.cond, ...loop.body];
  if (
    length !== null &&
    !preservesArrayLength(
      nodesOfLoop,
      { receiver: length.localId, inRange: counter },
      locals,
      unaliased,
    )
  )
    return null;
  // A store through another name, such as `const b = a` or a field, lands
  // in `a` unless one of the two bindings is a local array no other binding
  // holds.
  const mayStoreUndefined = (id: string): boolean =>
    undefinedStores.some((arr) =>
      arr.kind === "varRef"
        ? arr.localId === id || (!unaliased.has(id) && !unaliased.has(arr.localId))
        : !unaliased.has(id),
    );
  const arrays = new Map<string, IrExpr & { kind: "varRef" }>();
  for (const [id, ref] of candidates) {
    const local = locals.get(id);
    if (
      !local ||
      local.type.kind !== "array" ||
      local.boxed ||
      local.tdz ||
      disturbed.has(id) ||
      mayStoreUndefined(id) ||
      (id !== length?.localId && !initialized.has(id))
    )
      continue;
    // Without a bounding array, the entry test reads each array's `filled`
    // once: the loop must not change any of their lengths.
    if (
      length === null &&
      !preservesArrayLength(
        nodesOfLoop,
        { receiver: id, inRange: counter, inRangeHigh: high },
        locals,
        unaliased,
      )
    )
      continue;
    arrays.set(id, ref);
  }
  if (arrays.size === 0) return null;
  // Each guarded store's read must be one the fast copy proves present.
  for (const { arr, index } of guards)
    if (
      arr.kind !== "varRef" ||
      !arrays.has(arr.localId) ||
      index.kind !== "varRef" ||
      !isCounter(index.localId)
    )
      return null;
  return {
    counter,
    length,
    limit: length === null ? (shape.limit ?? null) : null,
    arrays,
    range: { min: shape.range.min, max: Math.min(shape.range.max, INT32_MAX - 1) },
    pair: shape.pair ?? null,
  };
}

/** The fast copy's entry test: the bounding length (or the counted loop's
 * exclusive limit) is at most 2^31 - 1 and at most every indexed array's
 * hole-free prefix bound. */
export function emitDenseLoopGuard(host: LlvmEmitterContext, loop: DenseArrayLoop): string {
  const B = host.B;
  const size = host.sizeType;
  const header = (array: string, field: number): string => {
    const ptr = B.tmp();
    B.line(`${ptr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${field}`);
    host.markMemoryPointer(ptr, "array:header");
    return ptr;
  };
  if (loop.pair !== null) return emitPairedDenseGuard(host, loop, loop.pair, header);
  if (loop.length === null) {
    // A limit at or below the start runs no pass, and passes the test.
    const limit = emitCountedLoopLimit(host, loop.limit!);
    const small = B.tmp();
    B.line(`${small} = icmp sle i64 ${limit}, ${INT32_MAX}`);
    let valid = small;
    for (const ref of loop.arrays.values()) {
      const array = host.emitStableReceiver(ref, []);
      const filledPtr = header(array.name, SCR_ARR_FIELD.filled),
        filled = B.tmp(),
        wide = B.tmp(),
        covered = B.tmp(),
        both = B.tmp();
      B.line(`${filled} = load i32, ptr ${filledPtr}${host.fieldAliasAttachment(filledPtr)}`);
      B.line(`${wide} = zext i32 ${filled} to i64`);
      B.line(`${covered} = icmp sle i64 ${limit}, ${wide}`);
      B.line(`${both} = and i1 ${valid}, ${covered}`);
      valid = both;
    }
    return valid;
  }
  const length = loop.length;
  const receiver = host.emitStableReceiver(length, []);
  const lenPtr = header(receiver.name, SCR_ARR_FIELD.len),
    len = B.tmp(),
    small = B.tmp();
  loadArrCount(host, len, lenPtr, host.fieldAliasAttachment(lenPtr));
  B.line(`${small} = icmp ule ${size} ${len}, ${INT32_MAX}`);
  let valid = small;
  for (const [id, ref] of loop.arrays) {
    const array = id === length.localId ? receiver : host.emitStableReceiver(ref, []);
    const filledPtr = header(array.name, SCR_ARR_FIELD.filled),
      filled = B.tmp(),
      covered = B.tmp(),
      both = B.tmp();
    B.line(`${filled} = load i32, ptr ${filledPtr}${host.fieldAliasAttachment(filledPtr)}`);
    let bound = filled;
    if (size === "i64") {
      bound = B.tmp();
      B.line(`${bound} = zext i32 ${filled} to i64`);
    }
    B.line(`${covered} = icmp ule ${size} ${len}, ${bound}`);
    B.line(`${both} = and i1 ${valid}, ${covered}`);
    valid = both;
  }
  return valid;
}

/** A two-counter loop's entry test: both starts are exact integers, the
 * low one at least 0 and the high one at most 2^31 - 2 and below every
 * indexed array's hole-free prefix bound. The starts are stable values
 * (matchIntegerPairedForLoop), so evaluating them here again is unobservable. */
function emitPairedDenseGuard(
  host: LlvmEmitterContext,
  loop: DenseArrayLoop,
  pair: DensePair,
  header: (array: string, field: number) => string,
): string {
  const B = host.B;
  const start = (expr: IrExpr, min: number, max: number) =>
    emitStartIntegerTest(host, expr, min, max);
  const low = start(pair.lowStart, 0, INT32_MAX - 1);
  const high = start(pair.highStart, -1, INT32_MAX - 1);
  let valid = B.tmp();
  B.line(`${valid} = and i1 ${low.ok}, ${high.ok}`);
  for (const ref of loop.arrays.values()) {
    const array = host.emitStableReceiver(ref, []);
    const filledPtr = header(array.name, SCR_ARR_FIELD.filled),
      filled = B.tmp(),
      wide = B.tmp(),
      covered = B.tmp(),
      both = B.tmp();
    B.line(`${filled} = load i32, ptr ${filledPtr}${host.fieldAliasAttachment(filledPtr)}`);
    B.line(`${wide} = zext i32 ${filled} to i64`);
    B.line(`${covered} = icmp slt i64 ${high.integer}, ${wide}`);
    B.line(`${both} = and i1 ${valid}, ${covered}`);
    valid = both;
  }
  return valid;
}
