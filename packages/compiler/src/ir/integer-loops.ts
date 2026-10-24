import type { IrExpr, IrLocal, IrStmt } from "./ir.js";
import type { IntegerRange, IntegerRanges } from "./integer-ranges.js";

import { everyExprChild, everyStmtChild, everyStmtList } from "./traverse.js";
import { byteNumberAccess } from "./byte-numbers.js";
import { preservesArrayLength } from "./array-length-stability.js";

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
   * that it is an exact integer (not -0) of at most `startBound` in
   * magnitude. */
  startGuarded: boolean;
  /** The magnitude the guarded start is tested against: 2^53 - 1, or
   * PRODUCT_COUNTER_BOUND when the body multiplies sums of the counter. */
  startBound: number;
  guardLimit: number;
  range: IntegerRange;
  /** Counters declared and stepped beside this one that the condition does
   * not test, such as `j` in `for (let i = 0, j = 0; i < n; i++, j += 4)`. */
  followers: IntegerLoopFollower[];
}

/** A counter that steps by a constant on every update of a counted loop.
 * After `k` updates it holds `start + step * k`. */
export interface IntegerLoopFollower {
  localId: string;
  start: IrExpr;
  step: number;
  /** As the driver's `startGuarded` (part of the loop's `guarded`). */
  startGuarded: boolean;
  /** The follower's range depends on the run-time trip count: the versioned
   * loop also tests `|start| + |step| * span / |driver step|` against
   * `FOLLOWER_GUARD_LIMIT`, where `span` is the distance from the driver's
   * start to the limit (part of the loop's `guarded`). */
  tripGuarded: boolean;
  /** The follower's values on every body entry. */
  range: IntegerRange;
}

/** The counter magnitude below which a product of two sums of counters and
 * small literals stays exact in a double: `(i + j) * (i + j + 1)` with both
 * counters within 2^25 is below 2^52. A guarded loop whose body multiplies
 * such sums for a bitwise operator tests its counter against this bound, so
 * the product's integer form is proven exact. */
export const PRODUCT_COUNTER_BOUND = 2 ** 25;

/** Whether `e` is a sum or difference of locals and safe integer literals
 * of magnitude at most 2^20, and whether it reads `counter`. */
function localSum(e: IrExpr, counter: string): { sum: boolean; reads: boolean } {
  let reads = false;
  const sum = (x: IrExpr): boolean => {
    if (x.kind === "varRef") {
      if (x.localId === counter) reads = true;
      return true;
    }
    if (x.kind === "numLit") return Number.isSafeInteger(x.value) && Math.abs(x.value) <= 2 ** 20;
    return x.kind === "bin" && (x.op === "+" || x.op === "-") && sum(x.left) && sum(x.right);
  };
  return { sum: sum(e), reads };
}

/** Whether a bitwise operand `e` multiplies two sums of locals and
 * literals, one of which reads `counter` (`((i + j) * (i + j + 1)) >>> 1`). */
function multipliesCounterSums(e: IrExpr, counter: string): boolean {
  if (e.kind !== "bin") return false;
  if (e.op === "*") {
    const left = localSum(e.left, counter),
      right = localSum(e.right, counter);
    return left.sum && right.sum && (left.reads || right.reads);
  }
  return (
    (e.op === "+" || e.op === "-") &&
    (multipliesCounterSums(e.left, counter) || multipliesCounterSums(e.right, counter))
  );
}

const BITWISE = new Set(["&", "|", "^", "<<", ">>", ">>>"]);

/** Whether `body`, nested loops included, takes a bitwise operator of a
 * product that multipliesCounterSums matches. */
function bodyMultipliesCounter(body: IrStmt[], counter: string): boolean {
  let found = false;
  everyStmtList(body, {
    stmt: () => !found,
    expr: (e) => {
      if (
        e.kind === "bin" &&
        BITWISE.has(e.op) &&
        (multipliesCounterSums(e.left, counter) || multipliesCounterSums(e.right, counter))
      )
        found = true;
      return !found;
    },
  });
  return found;
}

/** The bound of the run-time follower test. */
export const FOLLOWER_GUARD_LIMIT = 2 ** 52;
/** The magnitude a follower that passed the test can reach. The test's four
 * f64 operations (the step ratio, the span, its product and the sum) each
 * round down by at most a factor of 1 - 2^-53, so the exact sum is below
 * `2^52 / (1 - 2^-53)^4`, which is less than 2^52 + 3. */
const FOLLOWER_GUARD_RANGE = FOLLOWER_GUARD_LIMIT + 2;

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
 * additionally have to remain invariant throughout the loop. An array length
 * is hoisted from a condition only when `stableLength` proves the loop never
 * changes it; otherwise it is allowed only in the initializer. Typed-array
 * lengths are fixed for a given receiver. */
function stableLoopValue(
  value: IrExpr,
  locals: ReadonlyMap<string, IrLocal>,
  body: IrStmt[],
  invariant: boolean,
  counter: string,
  stableLength: (receiver: string) => boolean = () => false,
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
        stableLoopValue(value.left, locals, body, invariant, counter, stableLength) &&
        stableLoopValue(value.right, locals, body, invariant, counter, stableLength)
      );
    case "strIntrinsic":
      // A string's length is fixed: stable while its binding is.
      return (
        value.method === "length" &&
        value.receiver.kind === "varRef" &&
        stableLoopValue(value.receiver, locals, body, invariant, counter)
      );
    case "bytesIntrinsic":
    case "arrIntrinsic": {
      // The receiver may be one arm of a union binding (indexed-unions.ts).
      const receiver =
        value.receiver.kind === "unionNarrow" ? value.receiver.value : value.receiver;
      return (
        (value.method === "length" ||
          (value.kind === "bytesIntrinsic" && value.method === "byteLength")) &&
        receiver.kind === "varRef" &&
        (value.kind === "bytesIntrinsic" || !invariant || stableLength(receiver.localId)) &&
        stableLoopValue(receiver, locals, body, invariant, counter)
      );
    }
    // A union binding dispatched on its tag (indexed-unions.ts): stable
    // when the binding is and every arm is.
    case "ternary":
      return (
        value.cond.kind === "unionIsTag" &&
        stableLoopValue(value.cond.value, locals, body, invariant, counter) &&
        stableLoopValue(value.then, locals, body, invariant, counter, stableLength) &&
        stableLoopValue(value.else_, locals, body, invariant, counter, stableLength)
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
  unaliased: ReadonlySet<string> | null = null,
): IntegerCountedForLoop | null {
  const cond = stmt.cond;
  if (cond?.kind !== "bin") return null;
  const decls = stmt.init?.kind === "block" ? stmt.init.body : stmt.init ? [stmt.init] : [];
  // `i++, j += 2, k--` lowers to nested blocks of steps.
  const flat = (u: IrStmt | null): (IrStmt | null)[] =>
    u?.kind === "block" ? u.body.flatMap(flat) : [u];
  const updates = flat(stmt.update);
  if (decls.length === 0 || updates.length !== decls.length) return null;
  const declared = (e: IrExpr): string | null =>
    e.kind === "varRef" && decls.some((d) => d.kind === "varDecl" && d.localId === e.localId)
      ? e.localId
      : null;
  // The condition tests the driving counter; every other declaration
  // follows it.
  const driver = declared(cond.left) ?? declared(cond.right);
  // A body that multiplies sums of the driver tests it against the bound
  // under which those products are exact. A limit proven past that bound
  // (a literal trip count) keeps the safe-integer bound instead.
  const limitSide = driver !== null && declared(cond.left) === driver ? cond.right : cond.left;
  const knownLimit =
    limitSide.kind === "numLit"
      ? { min: limitSide.value, max: limitSide.value }
      : ranges.get(limitSide);
  const driverBound =
    driver !== null &&
    !(
      knownLimit &&
      Math.max(Math.abs(knownLimit.min), Math.abs(knownLimit.max)) > PRODUCT_COUNTER_BOUND
    ) &&
    bodyMultipliesCounter(stmt.body, driver)
      ? PRODUCT_COUNTER_BOUND
      : Number.MAX_SAFE_INTEGER;
  const counterIds = decls.map((d) => (d.kind === "varDecl" ? d.localId : ""));
  const stepOf = (id: string): number | null => {
    const steps = updates.map((u) => constantStep(u, id)).filter((v) => v !== null);
    return steps.length === 1 ? steps[0]! : null;
  };
  // A counter's start is a stable integer that refers to no counter. An
  // unproven start is tested at run time, on a versioned loop.
  const counterStart = (
    id: string,
  ): { start: IrExpr; range: IntegerRange; guarded: boolean; step: number } | null => {
    const decl = decls.find((d) => d.kind === "varDecl" && d.localId === id);
    if (decl?.kind !== "varDecl" || !decl.init) return null;
    const local = locals.get(id);
    if (local?.type.kind !== "f64" || !local.mutable || local.boxed || local.tdz) return null;
    const start = decl.init;
    const known =
      start.kind === "numLit" && Number.isSafeInteger(start.value) && !Object.is(start.value, -0)
        ? { min: start.value, max: start.value }
        : ranges.get(start);
    const guarded = !known && start.kind !== "numLit" && start.type.kind === "f64";
    const bound = id === driver ? driverBound : Number.MAX_SAFE_INTEGER;
    const range = guarded ? { min: -bound, max: bound } : known;
    const step = stepOf(id);
    if (
      !range ||
      range.min < -Number.MAX_SAFE_INTEGER ||
      range.max > Number.MAX_SAFE_INTEGER ||
      !counterIds.every((counter) => stableLoopValue(start, locals, stmt.body, false, counter)) ||
      step === null ||
      writesLocal(stmt.body, id)
    )
      return null;
    return { start, range, guarded, step };
  };
  const head = driver === null ? null : counterStart(driver);
  if (!head) return null;
  const local = locals.get(driver!)!;
  const { start, step, guarded: startGuarded, range: startRange } = head;
  let limit = cond.right,
    op: string = cond.op;
  if (cond.left.kind !== "varRef" || cond.left.localId !== local.id) {
    limit = cond.left;
    op = ({ "<": ">", "<=": ">=", ">": "<", ">=": "<=" } as Record<string, string>)[op] ?? "";
  }
  if (step > 0 ? op !== "<" && op !== "<=" : op !== ">" && op !== ">=") return null;
  // An ascending counter compared below `a.length - c` holds an index below
  // the length on every pass while that length is unchanged.
  const belowLength = (receiver: string): boolean => {
    let offset = 0,
      length = limit;
    if (
      length.kind === "bin" &&
      length.op === "-" &&
      length.right.kind === "numLit" &&
      Number.isFinite(length.right.value)
    ) {
      offset = length.right.value;
      length = length.left;
    }
    return (
      step > 0 &&
      length.kind === "arrIntrinsic" &&
      length.method === "length" &&
      length.receiver.kind === "varRef" &&
      length.receiver.localId === receiver &&
      (op === "<" ? offset >= 0 : offset >= 1)
    );
  };
  const stableLength = (receiver: string): boolean =>
    unaliased !== null &&
    preservesArrayLength(
      [cond, ...stmt.body],
      { receiver, inRange: belowLength(receiver) ? local.id : null },
      locals,
      unaliased,
    );
  if (!stableLoopValue(limit, locals, stmt.body, true, local.id, stableLength)) return null;
  const inclusive = op === "<=" || op === ">=";
  const limitBound = driverBound === Number.MAX_SAFE_INTEGER ? 2 ** 53 : driverBound;
  const guardLimit =
    step > 0 ? limitBound - (inclusive ? 1 : 0) : -limitBound + (inclusive ? 1 : 0);
  const boundRange =
    limit.kind === "numLit" ? { min: limit.value, max: limit.value } : ranges.get(limit);
  const limitGuarded =
    !boundRange || (step > 0 ? !(boundRange.max <= guardLimit) : !(boundRange.min >= guardLimit));
  if (limitGuarded && limit.kind === "numLit") return null;
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
                : limitGuarded
                  ? Math.ceil(guardLimit) - (inclusive ? 0 : 1)
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
                : limitGuarded
                  ? Math.floor(guardLimit) + (inclusive ? 0 : 1)
                  : -Number.MAX_SAFE_INTEGER,
            ),
          ),
          max: startRange.max,
        };
  // On body entry k the driver holds `start + step * k`, so k is at most the
  // driver's span over |step|, and a follower holds its start plus its own
  // step times k. A span above 2^53 - 1 can round down, so it bounds no
  // trip count. Below it the quotient rounds to at least its floor, and the
  // follower's products and sums below are exact while they stay within
  // ±(2^53 - 1) and round outside it otherwise.
  const span = step > 0 ? range.max - startRange.min : startRange.max - range.min;
  const trips = span <= Number.MAX_SAFE_INTEGER ? Math.floor(span / Math.abs(step)) : Infinity;
  const followers: IntegerLoopFollower[] = [];
  for (const id of counterIds) {
    if (id === local.id) continue;
    const follower = counterStart(id);
    // The limit is evaluated once; a follower changes on every update.
    if (!follower || !stableLoopValue(limit, locals, stmt.body, false, id)) return null;
    const reach = follower.step * trips;
    const min = follower.range.min + Math.min(0, reach),
      max = follower.range.max + Math.max(0, reach);
    const tripGuarded = min < -Number.MAX_SAFE_INTEGER || max > Number.MAX_SAFE_INTEGER;
    // Known starts and a literal limit are not tested at run time.
    if (tripGuarded && !follower.guarded && !startGuarded && limit.kind === "numLit") return null;
    followers.push({
      localId: id,
      start: follower.start,
      step: follower.step,
      startGuarded: follower.guarded,
      tripGuarded,
      range: tripGuarded
        ? { min: Math.max(-FOLLOWER_GUARD_RANGE, min), max: Math.min(FOLLOWER_GUARD_RANGE, max) }
        : { min, max },
    });
  }
  const guarded =
    limitGuarded || startGuarded || followers.some((f) => f.startGuarded || f.tripGuarded);
  let useful = false;
  let cost = 0;
  const counter = (e: IrExpr): boolean =>
    (e.kind === "varRef" &&
      (e.localId === local.id || followers.some((f) => f.localId === e.localId))) ||
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
    // A string read at the counter indexes with the integer directly.
    if (
      e.kind === "strIntrinsic" &&
      (e.method === "charCodeAt" || e.method === "charAt") &&
      e.args[0] &&
      counter(e.args[0])
    )
      useful = true;
    // So does an array element read; only a loop that needs no versioned
    // copy takes the integer counter for it.
    if (
      !guarded &&
      ((e.kind === "arrayGet" && counter(e.index)) ||
        (e.kind === "arrIntrinsic" && e.method === "getNumber" && e.args[0] && counter(e.args[0])))
    )
      useful = true;
    return (!guarded || ++cost <= 80) && everyExprChild(e, expr, bodyStmt);
  };
  const bodyStmt = (s: IrStmt): boolean => {
    if (s.kind === "bytesSet" && counter(s.index)) useful = true;
    if (!guarded && s.kind === "arraySet" && counter(s.index)) useful = true;
    // A guarded loop's copy duplicates nested loops too, so only a body
    // whose counter products the bound proves exact may hold a nested
    // `for` loop; the node budget counts its body.
    if (
      guarded &&
      (s.kind === "forOf" ||
        s.kind === "while" ||
        s.kind === "doWhile" ||
        (s.kind === "for" && driverBound === Number.MAX_SAFE_INTEGER))
    )
      return false;
    return (!guarded || ++cost <= 80) && everyStmtChild(s, expr, bodyStmt);
  };
  if (!stmt.body.every(bodyStmt) || !useful) return null;
  return {
    localId: local.id,
    start,
    limit,
    step,
    inclusive,
    guarded,
    limitGuarded,
    startGuarded,
    startBound: driverBound,
    guardLimit,
    range,
    followers,
  };
}

/** A for loop whose two counters close in on each other:
 *
 *   for (let lo = a, hi = b; lo < hi; lo++, hi--) { ... }
 *
 * The first counter only grows and the second only shrinks, by positive
 * literal steps, the body writes neither, and the loop runs while the first
 * is below (or at most) the second, written either way round (`hi > lo`).
 * Every body entry therefore holds both between the first start and the
 * second start: exact integers when the starts are. A start without a proven integer range is tested at run time
 * on a versioned loop, as a counted loop's is. */
export interface IntegerPairedCounter {
  localId: string;
  start: IrExpr;
  /** The signed step of each update. */
  step: number;
  startGuarded: boolean;
}
export interface IntegerPairedForLoop {
  low: IntegerPairedCounter;
  high: IntegerPairedCounter;
  inclusive: boolean;
  guarded: boolean;
  /** Both counters' values on every body entry. */
  range: IntegerRange;
}

export function matchIntegerPairedForLoop(
  stmt: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
  ranges: IntegerRanges = new Map(),
): IntegerPairedForLoop | null {
  const init = stmt.init,
    update = stmt.update,
    cond = stmt.cond;
  if (init?.kind !== "block" || init.body.length !== 2) return null;
  if (update?.kind !== "block" || update.body.length !== 2) return null;
  if (cond?.kind !== "bin" || cond.left.kind !== "varRef" || cond.right.kind !== "varRef")
    return null;
  const below = cond.op === "<" || cond.op === "<=";
  if (!below && cond.op !== ">" && cond.op !== ">=") return null;
  // `hi > lo` is `lo < hi`.
  const lowId = below ? cond.left.localId : cond.right.localId,
    highId = below ? cond.right.localId : cond.left.localId;
  if (lowId === highId) return null;
  const counter = (id: string): IntegerPairedCounter | null => {
    const decl = init.body.find((d) => d.kind === "varDecl" && d.localId === id);
    if (decl?.kind !== "varDecl" || !decl.init) return null;
    const local = locals.get(id);
    if (local?.type.kind !== "f64" || !local.mutable || local.boxed || local.tdz) return null;
    const start = decl.init;
    // Each start is evaluated once in the head and again on a fallback path.
    if (
      !stableLoopValue(start, locals, stmt.body, false, lowId) ||
      !stableLoopValue(start, locals, stmt.body, false, highId)
    )
      return null;
    const steps = update.body.map((u) => constantStep(u, id)).filter((v) => v !== null);
    if (steps.length !== 1 || writesLocal(stmt.body, id)) return null;
    const known =
      start.kind === "numLit" && Number.isSafeInteger(start.value) && !Object.is(start.value, -0)
        ? { min: start.value, max: start.value }
        : ranges.get(start);
    const startGuarded = !known && start.kind !== "numLit" && start.type.kind === "f64";
    if (!known && !startGuarded) return null;
    if (known && (known.min < -Number.MAX_SAFE_INTEGER || known.max > Number.MAX_SAFE_INTEGER))
      return null;
    return { localId: id, start, step: steps[0]!, startGuarded };
  };
  const low = counter(lowId),
    high = counter(highId);
  if (!low || !high || low.step <= 0 || high.step >= 0) return null;
  const startRange = (c: IntegerPairedCounter): IntegerRange =>
    c.startGuarded
      ? { min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }
      : c.start.kind === "numLit"
        ? { min: c.start.value, max: c.start.value }
        : ranges.get(c.start)!;
  const guarded = low.startGuarded || high.startGuarded;
  // Only a loop whose counters index something gains from integer storage.
  let useful = false,
    cost = 0;
  const isCounter = (e: IrExpr): boolean =>
    (e.kind === "varRef" && (e.localId === lowId || e.localId === highId)) ||
    (e.kind === "bin" &&
      (e.op === "+" || e.op === "-") &&
      (isCounter(e.left) || isCounter(e.right)));
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "arrayGet" && isCounter(e.index)) useful = true;
    if (
      e.kind === "strIntrinsic" &&
      (e.method === "charCodeAt" || e.method === "charAt") &&
      e.args[0] &&
      isCounter(e.args[0])
    )
      useful = true;
    if (e.kind === "bytesIntrinsic" && e.method === "get" && e.args[0] && isCounter(e.args[0]))
      useful = true;
    return (!guarded || ++cost <= 80) && everyExprChild(e, expr, bodyStmt);
  };
  const bodyStmt = (s: IrStmt): boolean => {
    if ((s.kind === "arraySet" || s.kind === "bytesSet") && isCounter(s.index)) useful = true;
    if (
      guarded &&
      (s.kind === "for" || s.kind === "forOf" || s.kind === "while" || s.kind === "doWhile")
    )
      return false;
    return (!guarded || ++cost <= 80) && everyStmtChild(s, expr, bodyStmt);
  };
  if (!stmt.body.every(bodyStmt) || !useful) return null;
  return {
    low,
    high,
    inclusive: cond.op === "<=" || cond.op === ">=",
    guarded,
    // A loop whose starts already fail the condition never enters the body.
    range: {
      min: startRange(low).min,
      max: Math.max(startRange(low).min, startRange(high).max),
    },
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
