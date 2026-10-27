import type { IntegerRange } from "./integer-ranges.js";
import type { IrExpr, IrLocal, IrStmt } from "./ir.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";

function increment(id: string, value: IrExpr): number | null {
  if (
    value.kind !== "bin" ||
    value.left.kind !== "varRef" ||
    value.left.localId !== id ||
    value.right.kind !== "numLit" ||
    !Number.isSafeInteger(value.right.value) ||
    Object.is(value.right.value, -0)
  )
    return null;
  return value.op === "+" ? value.right.value : value.op === "-" ? -value.right.value : null;
}

/** The counter step `counter + s` (or `counter - s`) adds on each update
 * when `s` is a binding: its operand and sign. A constant step is
 * `increment`'s. */
function variableIncrement(id: string, value: IrExpr): { localId: string; sign: 1 | -1 } | null {
  if (
    value.kind !== "bin" ||
    value.left.kind !== "varRef" ||
    value.left.localId !== id ||
    value.right.kind !== "varRef" ||
    value.right.localId === id ||
    (value.op !== "+" && value.op !== "-")
  )
    return null;
  return { localId: value.right.localId, sign: value.op === "+" ? 1 : -1 };
}

/** Bound secondary cursors by a finite ascending loop's maximum iteration
 * count. Sum all syntactic updates, including both sides of branches, so
 * filtering, breaks and continues can only reduce the budget. A nested
 * loop or opaque control region invalidates the bindings it writes.
 *
 * A cursor may also be reset to an integer literal (`run = 0`) or set to
 * another bounded binding (`longest = run`): every value it then holds is
 * its entry value, a reset value or a value the source held, plus at most
 * the increments of the whole loop.
 *
 * The counter's step is a positive integer literal or a binding the loop
 * never writes whose entry fact is a positive integer range (the sieve's
 * `j += i`): every update then adds an exact integer in that range, so the
 * counter climbs from its start to at most the limit plus the largest
 * step. */
export function boundedIntegerLoopFacts(
  loop: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
  initial: ReadonlyMap<string, IntegerRange>,
): ReadonlyMap<string, IntegerRange> {
  const result = new Map<string, IntegerRange>();
  if (loop.init?.kind !== "varDecl" || loop.update?.kind !== "assign" || loop.cond?.kind !== "bin")
    return result;
  const counter = loop.init.localId,
    start = initial.get(counter);
  const constant = loop.update.localId === counter ? increment(counter, loop.update.value) : null;
  const variable =
    loop.update.localId === counter ? variableIncrement(counter, loop.update.value) : null;
  if (
    !start ||
    start.min < 0 ||
    (constant === null && variable === null) ||
    (constant !== null && (constant <= 0 || constant > 2147483647)) ||
    loop.cond.left.kind !== "varRef" ||
    loop.cond.left.localId !== counter ||
    (loop.cond.op !== "<" && loop.cond.op !== "<=")
  )
    return result;
  const written = new Set<string>(),
    refused = new Set<string>();
  const lower = new Map<string, number>(),
    upper = new Map<string, number>();
  const resets = new Map<string, IntegerRange>(),
    copies = new Map<string, Set<string>>();
  let opaque = 0;
  const write = (id: string, delta: number | null): void => {
    written.add(id);
    if (opaque || delta === null) {
      refused.add(id);
      return;
    }
    const lo = (lower.get(id) ?? 0) + Math.min(0, delta);
    const hi = (upper.get(id) ?? 0) + Math.max(0, delta);
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) refused.add(id);
    lower.set(id, lo);
    upper.set(id, hi);
  };
  const assignment = (id: string, value: IrExpr): void => {
    const delta = increment(id, value);
    if (opaque || delta !== null) write(id, delta);
    else if (
      value.kind === "numLit" &&
      Number.isSafeInteger(value.value) &&
      !Object.is(value.value, -0)
    ) {
      written.add(id);
      const range = resets.get(id);
      resets.set(id, {
        min: Math.min(range?.min ?? value.value, value.value),
        max: Math.max(range?.max ?? value.value, value.value),
      });
    } else if (value.kind === "varRef" && value.localId !== id) {
      written.add(id);
      const sources = copies.get(id) ?? new Set<string>();
      sources.add(value.localId);
      copies.set(id, sources);
    } else write(id, null);
  };
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "assignExpr") assignment(e.localId, e.value);
    if (e.kind === "incDec") write(e.localId, e.op === "+" ? 1 : -1);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    const region =
      s.kind === "for" ||
      s.kind === "while" ||
      s.kind === "doWhile" ||
      s.kind === "forOf" ||
      s.kind === "tryCatch" ||
      s.kind === "switch";
    if (region) opaque++;
    if (s.kind === "assign") assignment(s.localId, s.value);
    if (s.kind === "varDecl" || s.kind === "forOf") write(s.localId, null);
    const completed = everyStmtChild(s, expr, stmt);
    if (region) opaque--;
    return completed;
  };
  // The condition and the update run on every pass too. A binding either
  // one writes (`i < (src = next(), n)`) changes in ways the budget does
  // not count, so it is neither a stable bound nor a copy source.
  opaque++;
  expr(loop.cond);
  expr(loop.update.value);
  opaque--;
  loop.body.every(stmt);
  if (written.has(counter)) return result;
  const stable = (id: string): boolean => {
    const local = locals.get(id);
    return local !== undefined && !local.boxed && !local.tdz && !written.has(id) && id !== counter;
  };
  function bound(e: IrExpr): IntegerRange | null {
    if (e.kind === "numLit" && Number.isSafeInteger(e.value) && !Object.is(e.value, -0))
      return { min: e.value, max: e.value };
    if (e.kind === "varRef" && stable(e.localId)) return initial.get(e.localId) ?? null;
    if (
      e.kind === "bytesIntrinsic" &&
      (e.method === "length" || e.method === "byteLength") &&
      e.receiver.kind === "varRef" &&
      stable(e.receiver.localId)
    )
      return BYTES_LENGTH_RANGE;
    // Every evaluation of an array length lies in its range, so the
    // condition bounds each pass even when the body resizes the array.
    if (isArrayLength(e)) return ARRAY_LENGTH_RANGE;
    return null;
  }
  let step: IntegerRange;
  if (constant !== null) step = { min: constant, max: constant };
  else {
    // The step binding is read on every update; it must keep one value.
    const operand = variable!.localId;
    const range = stable(operand) ? initial.get(operand) : undefined;
    if (!range) return result;
    step =
      variable!.sign > 0
        ? { min: range.min, max: range.max }
        : { min: -range.max, max: -range.min };
    if (step.min <= 0 || step.max > 2147483647) return result;
  }
  const limit = bound(loop.cond.right);
  // The counter is an integer, so a strict bound admits passes up to one
  // below the limit.
  const last = limit && (loop.cond.op === "<" ? limit.max - 1 : limit.max);
  if (!limit || last === null || last < start.min) return result;
  const distance = last - start.min;
  const iterations = Math.floor(distance / step.min) + 1;
  if (!Number.isSafeInteger(distance) || !Number.isSafeInteger(iterations)) return result;
  // Header facts also cover the failing final condition and zero iterations.
  const maximum = Math.max(start.max, last + step.max);
  if (Number.isSafeInteger(maximum)) result.set(counter, { min: start.min, max: maximum });
  // Every value a copy reads lies in its source's range: a cursor bounded
  // here, or a binding the loop never writes.
  const source = (id: string): IntegerRange | undefined =>
    result.get(id) ?? (stable(id) ? initial.get(id) : undefined);
  // Copies wait for their sources; a cycle of copies stays unbounded.
  for (let changed = true; changed;) {
    changed = false;
    for (const id of written) {
      const range = initial.get(id);
      if (!range || refused.has(id) || id === counter || result.has(id)) continue;
      let min = range.min,
        max = range.max;
      const reset = resets.get(id);
      if (reset) {
        min = Math.min(min, reset.min);
        max = Math.max(max, reset.max);
      }
      let bounded = true;
      const sources = copies.get(id);
      if (sources)
        for (const from of sources) {
          const copied = source(from);
          if (!copied) bounded = false;
          else {
            min = Math.min(min, copied.min);
            max = Math.max(max, copied.max);
          }
        }
      if (!bounded) continue;
      const decrement = iterations * (lower.get(id) ?? 0);
      const increment = iterations * (upper.get(id) ?? 0);
      if (!Number.isSafeInteger(decrement) || !Number.isSafeInteger(increment)) continue;
      min += decrement;
      max += increment;
      if (Number.isSafeInteger(min) && Number.isSafeInteger(max)) {
        result.set(id, { min, max });
        changed = true;
      }
    }
  }
  return result;
}

/** Every length, byteLength and byteOffset of a typed array, DataView or
 * Buffer: each counts elements or bytes of one allocation, and every
 * supported target addresses less than 2^48 bytes. Counters and offsets
 * derived from them then stay exact integers far below 2^53. */
export const BYTES_LENGTH_RANGE: IntegerRange = { min: 0, max: 2 ** 48 };

/** Every length an array can have: SCR_ARR_MAX_LENGTH (scr_array.c). */
export const ARRAY_LENGTH_RANGE: IntegerRange = { min: 0, max: 4294967295 };

/** `a.length` of a typed array value (an ordinary JS array). */
function isArrayLength(e: IrExpr): boolean {
  return (
    e.kind === "arrIntrinsic" &&
    e.method === "length" &&
    e.args.length === 0 &&
    e.type.kind === "f64" &&
    e.receiver.type.kind === "array"
  );
}

/** The most UTF-16 code units a runtime string holds: SCR_STR_MAX_CAP
 * (scr_runtime.h) caps a string's UTF-8 bytes, and a UTF-16 length never
 * exceeds the UTF-8 byte length. */
export const STRING_MAX_UNITS = 0x7fffffff;

/** Bound counters of a while loop by its condition. A counter qualifies when
 * the loop (condition and body) changes it only by increments of positive
 * integer literals outside switch and exception regions and loops other
 * than nested while loops, and a conjunct of the condition compares it below
 * a literal, a binding the loop never writes, or the length of a string
 * binding the loop never writes (`while (x * x + y * y <= 4 && it < MAX)
 * it++`, `while (pos < text.length)`). A nested while loop may advance the
 * counter only when its own condition bounds it the same way and does not
 * write it (a scanner's `while (pos < end && isDigit(...)) pos++`): its
 * passes start at most at that bound, so it leaves the counter at its entry
 * value or at the highest value one of its passes reaches.
 * The body runs only after that conjunct held, and the condition never
 * writes the counter, so every pass starts at most at the conjunct's bound.
 * The pass then climbs by the increments on its path; an increment inside an
 * `if` whose condition compares the counter below such a bound starts from
 * at most that bound (`if (pos < text.length && ...) pos++`). The counter
 * starts at its entry fact and only grows, so the range holds at every read
 * inside and after the loop. */
export function guardedLoopCounterFacts(
  loop: IrStmt & { kind: "while" },
  locals: ReadonlyMap<string, IrLocal>,
  initial: ReadonlyMap<string, IntegerRange>,
): ReadonlyMap<string, IntegerRange> {
  const result = new Map<string, IntegerRange>();
  const budget = new Map<string, number>(),
    refused = new Set<string>();
  let opaque = 0;
  const write = (id: string, delta: number | null): void => {
    if (opaque || delta === null || delta <= 0 || delta > 2147483647) refused.add(id);
    else budget.set(id, (budget.get(id) ?? 0) + delta);
  };
  // Nested while loops outside opaque regions, checked against their own
  // conditions once the stable bounds are known. Only loops that highestCount
  // walks pass by pass qualify: statements of the body, its blocks and its
  // branches. One in a labeled block or among an expression's statements
  // (`indirect`) is an ordinary loop region.
  const nested: (IrStmt & { kind: "while" })[] = [];
  let indirect = 0;
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "assignExpr") write(e.localId, increment(e.localId, e.value));
    if (e.kind === "incDec") write(e.localId, e.op === "+" ? 1 : null);
    return everyExprChild(e, expr, (x) => {
      indirect++;
      const completed = stmt(x);
      indirect--;
      return completed;
    });
  };
  const condition = new Set<string>();
  const stmt = (s: IrStmt): boolean => {
    const bounded = s.kind === "while" && opaque === 0 && indirect === 0 && !s.labels?.length;
    const labeled = s.kind === "block" && !!s.labels?.length;
    const region =
      !bounded &&
      (s.kind === "for" ||
        s.kind === "while" ||
        s.kind === "doWhile" ||
        s.kind === "forOf" ||
        s.kind === "tryCatch" ||
        s.kind === "switch");
    if (bounded) {
      nested.push(s);
      conditionWrites(s.cond);
    }
    if (region) opaque++;
    if (labeled) indirect++;
    if (s.kind === "assign") write(s.localId, increment(s.localId, s.value));
    if (s.kind === "varDecl" || s.kind === "forOf") write(s.localId, null);
    if (s.kind === "tryCatch" && s.catchLocalId) write(s.catchLocalId, null);
    const completed = everyStmtChild(s, expr, stmt);
    if (labeled) indirect--;
    if (region) opaque--;
    return completed;
  };
  // The condition is evaluated before every pass; a write there would
  // separate the compared value from the one the body sees.
  const conditionWrites = (e: IrExpr): boolean => {
    if (e.kind === "assignExpr" || e.kind === "incDec") condition.add(e.localId);
    return everyExprChild(e, conditionWrites, (s) => {
      opaque++;
      stmt(s);
      opaque--;
      return true;
    });
  };
  conditionWrites(loop.cond);
  loop.body.every(stmt);
  // Nested loops' conditions are collected during the walk.
  for (const id of condition) refused.add(id);
  const stable = (id: string): boolean => {
    const local = locals.get(id);
    return local !== undefined && !local.boxed && !local.tdz && !budget.has(id) && !refused.has(id);
  };
  const limit = (e: IrExpr): IntegerRange | null => {
    if (e.kind === "numLit" && Number.isSafeInteger(e.value) && !Object.is(e.value, -0))
      return { min: e.value, max: e.value };
    if (e.kind === "varRef" && stable(e.localId)) return initial.get(e.localId) ?? null;
    // Strings are immutable: the length of a binding the loop never writes
    // is the same on every pass.
    if (
      e.kind === "strIntrinsic" &&
      e.method === "length" &&
      e.args.length === 0 &&
      e.type.kind === "f64" &&
      e.receiver.kind === "varRef" &&
      e.receiver.type.kind === "string" &&
      stable(e.receiver.localId)
    )
      return { min: 0, max: STRING_MAX_UNITS };
    if (
      e.kind === "bytesIntrinsic" &&
      (e.method === "length" || e.method === "byteLength") &&
      e.receiver.kind === "varRef" &&
      stable(e.receiver.localId)
    )
      return BYTES_LENGTH_RANGE;
    // An array length can change on any pass, but never leaves its range,
    // which is all a ceiling needs.
    if (isArrayLength(e)) return ARRAY_LENGTH_RANGE;
    return null;
  };
  // The bounds a condition's conjuncts put on counters while it holds.
  const ceilings = (cond: IrExpr): Map<string, number> => {
    const conjuncts: IrExpr[] = [];
    const collect = (e: IrExpr): void => {
      if (e.kind === "toBool") collect(e.operand);
      else if (e.kind === "logical" && e.op === "&&") {
        collect(e.left);
        collect(e.right);
      } else conjuncts.push(e);
    };
    collect(cond);
    const ceiling = new Map<string, number>();
    for (const c of conjuncts) {
      if (c.kind !== "bin") continue;
      // `counter < bound` or `bound > counter` (and the inclusive forms).
      const below = c.op === "<" || c.op === "<=",
        above = c.op === ">" || c.op === ">=";
      const counter = below ? c.left : above ? c.right : null,
        other = below ? c.right : c.left;
      if (counter?.kind !== "varRef") continue;
      const bound = limit(other);
      if (!bound) continue;
      const hi = c.op === "<" || c.op === ">" ? bound.max - 1 : bound.max;
      const previous = ceiling.get(counter.localId);
      ceiling.set(counter.localId, previous === undefined ? hi : Math.min(previous, hi));
    }
    return ceiling;
  };
  // A nested while loop advances only the counters its condition bounds.
  for (const inner of nested) {
    const caps = ceilings(inner.cond);
    for (const id of writtenLocals(inner.body)) if (!caps.has(id)) refused.add(id);
  }
  const ceiling = ceilings(loop.cond);
  for (const id of budget.keys()) {
    const local = locals.get(id),
      start = initial.get(id),
      hi = ceiling.get(id);
    if (refused.has(id) || !local || local.boxed || local.tdz || !start || hi === undefined)
      continue;
    const max = Math.max(start.max, highestCount(loop.body, id, hi, ceilings));
    if (Number.isSafeInteger(start.min) && Number.isSafeInteger(max))
      result.set(id, { min: start.min, max });
  }
  // Companion counters: a binding the loop changes only by positive literal
  // increments that no condition bounds (`out[k++] = ...` beside
  // `while (i < n)`). A bounded counter that every pass advances before it
  // can continue limits the number of passes, and each pass adds at most
  // the companion's increments in the body. Increments inside nested loops
  // can repeat within a pass, so those companions are not bounded.
  let passes = Infinity;
  for (const [id, range] of result) {
    const hi = ceiling.get(id)!;
    const step = guaranteedStep(loop.body, id);
    if (step <= 0) continue;
    passes = Math.min(passes, Math.floor((hi - range.min) / step) + 1);
  }
  if (!Number.isSafeInteger(passes) || passes < 0) return result;
  const repeated = new Set<string>();
  for (const inner of nested) for (const id of writtenLocals(inner.body)) repeated.add(id);
  for (const [id, total] of budget) {
    const local = locals.get(id),
      start = initial.get(id);
    if (result.has(id) || refused.has(id) || repeated.has(id) || ceiling.has(id)) continue;
    if (!local || local.boxed || local.tdz || !start) continue;
    const max = start.max + passes * total;
    if (Number.isSafeInteger(start.min) && Number.isSafeInteger(max))
      result.set(id, { min: start.min, max });
  }
  return result;
}

/** The increments of counter `id` that every pass of `body` makes before it
 * can start another pass: those of the leading statements up to the first
 * one that can continue the loop or holds a nested region (0 when there is
 * none). A pass that leaves the loop earlier starts no further pass, so the
 * count bounds the passes that continue. */
function guaranteedStep(body: readonly IrStmt[], id: string): number {
  let step = 0;
  for (const s of body) {
    if (s.kind === "assign" && s.localId === id) {
      const delta = increment(id, s.value);
      if (delta === null || delta <= 0) return 0;
      step += delta;
      continue;
    }
    if (s.kind === "exprStmt" && s.expr.kind === "incDec" && s.expr.localId === id) {
      if (s.expr.op !== "+") return 0;
      step += 1;
      continue;
    }
    if (mayContinue(s)) break;
  }
  return step;
}

/** Whether `s` can start another pass of the enclosing loop before its
 * following statements run: it holds a `continue`, a loop or another
 * region whose control flow is not walked here. */
function mayContinue(s: IrStmt): boolean {
  let found = false;
  const stmt = (x: IrStmt): boolean => {
    if (
      x.kind === "continue" ||
      x.kind === "for" ||
      x.kind === "while" ||
      x.kind === "doWhile" ||
      x.kind === "forOf" ||
      x.kind === "tryCatch" ||
      x.kind === "switch" ||
      (x.kind === "block" && !!x.labels?.length)
    ) {
      found = true;
      return false;
    }
    return everyStmtChild(x, expr, stmt);
  };
  const expr = (e: IrExpr): boolean => everyExprChild(e, expr, stmt);
  stmt(s);
  return found;
}

/** The largest value counter `id` takes in one pass of `body`, which starts
 * at most at `entry`. The caller has checked that the body changes the
 * counter only by positive literal increments outside switch, exception and
 * labeled loop regions and loops other than nested while loops whose
 * conditions bound it, and every exit from a straight-line path leaves the
 * body. An `if` whose condition does not write the counter caps it in the
 * then branch by the condition's bounds. A nested while loop that is a
 * statement of the body, or of its blocks and branches, is walked from its
 * bound; any other statement adds the increments it holds, and one that
 * holds a loop writing the counter (in an expression or a labeled block)
 * leaves it unbounded. */
function highestCount(
  body: readonly IrStmt[],
  id: string,
  entry: number,
  ceilings: (cond: IrExpr) => ReadonlyMap<string, number>,
): number {
  let highest = entry;
  const increments = (e: IrExpr | IrStmt, expression: boolean): number => {
    let total = 0;
    const expr = (x: IrExpr): boolean => {
      if (x.kind === "assignExpr" && x.localId === id) total += increment(id, x.value) ?? 0;
      if (x.kind === "incDec" && x.localId === id) total += 1;
      return everyExprChild(x, expr, stmt);
    };
    const stmt = (x: IrStmt): boolean => {
      if (x.kind === "assign" && x.localId === id) total += increment(id, x.value) ?? 0;
      // A loop reached here, inside an expression or a labeled region rather
      // than through `walk`, can repeat its increments: no bound.
      if (
        (x.kind === "while" || x.kind === "doWhile" || x.kind === "for" || x.kind === "forOf") &&
        writtenLocals([x]).has(id)
      )
        total = Infinity;
      return everyStmtChild(x, expr, stmt);
    };
    if (expression) expr(e as IrExpr);
    else stmt(e as IrStmt);
    return total;
  };
  const walk = (stmts: readonly IrStmt[], start: number): number => {
    let count = start;
    for (const s of stmts) {
      if (count === -Infinity) return count;
      if (s.kind === "if") {
        const added = increments(s.cond, true);
        count += added;
        highest = Math.max(highest, count);
        const cap = added === 0 ? ceilings(s.cond).get(id) : undefined;
        const then = walk(s.then, cap === undefined ? count : Math.min(count, cap));
        const else_ = s.else_ ? walk(s.else_, count) : count;
        count = Math.max(then, else_);
      } else if (s.kind === "block" && !s.labels?.length) {
        count = walk(s.body, count);
      } else if (
        s.kind === "while" &&
        !s.labels?.length &&
        increments(s.cond, true) === 0 &&
        ceilings(s.cond).has(id)
      ) {
        // Every pass starts at most at the bound; the loop ends at its entry
        // value or where a pass left the counter.
        const cap = ceilings(s.cond).get(id)!;
        const outer = highest;
        highest = cap;
        walk(s.body, cap);
        const inner = highest;
        highest = Math.max(outer, inner);
        count = Math.max(count, inner);
      } else {
        count += increments(s, false);
        highest = Math.max(highest, count);
        if (
          s.kind === "return" ||
          s.kind === "throw" ||
          s.kind === "rethrow" ||
          s.kind === "break" ||
          s.kind === "continue"
        )
          count = -Infinity;
      }
    }
    return count;
  };
  walk(body, entry);
  return highest;
}

/** The bindings `body` assigns or increments anywhere. */
function writtenLocals(body: readonly IrStmt[]): Set<string> {
  const ids = new Set<string>();
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "assignExpr" || e.kind === "incDec") ids.add(e.localId);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if (s.kind === "assign") ids.add(s.localId);
    return everyStmtChild(s, expr, stmt);
  };
  body.every(stmt);
  return ids;
}

/** Recognize only exits whose target cannot be inside this statement list.
 * Labeled blocks, loops, switch and exception regions retain the join. */
export function integerPathFallsThrough(body: readonly IrStmt[]): boolean {
  for (const stmt of body) {
    if (
      stmt.kind === "return" ||
      stmt.kind === "throw" ||
      stmt.kind === "rethrow" ||
      stmt.kind === "break" ||
      stmt.kind === "continue"
    )
      return false;
    if (stmt.kind === "block" && !stmt.labels?.length && !integerPathFallsThrough(stmt.body))
      return false;
    if (
      stmt.kind === "if" &&
      stmt.else_ &&
      !integerPathFallsThrough(stmt.then) &&
      !integerPathFallsThrough(stmt.else_)
    )
      return false;
  }
  return true;
}
