import type { IrExpr, IrFunction, IrStmt } from "./ir.js";
import { everyExpr, everyStmt, everyStmtList } from "./traverse.js";
import { byteNumberAccess } from "./byte-numbers.js";
import {
  analyzeIntegerRangeFacts,
  type IntegerRange,
  type IntegerRangeFacts,
  type IntegerSlotFacts,
  type LoopEntryAssumptions,
  NON_NEGATIVE_INT32_RANGE,
} from "./integer-ranges.js";

/** The range a versioned loop requires of each assumed local on entry. A
 * loop's counters stay below a typed array or string length (at most 2^48),
 * so sums of a few such values and assumed locals stay exact integers. */
export const LOOP_ENTRY_RANGE: IntegerRange = { min: -(2 ** 48), max: 2 ** 48 };

/** A copy of a loop that runs when every local in `entry` holds an
 * integer in its range on entry (never -0). `ranges` are the facts that
 * hold for the loop's expressions in that copy and that the function's own
 * analysis does not prove; `loopRanges` are the loop's bounded bindings
 * there. */
export interface LoopEntryVersion {
  entry: ReadonlyMap<string, IntegerRange>;
  ranges: ReadonlyMap<IrExpr, IntegerRange>;
  loopRanges: ReadonlyMap<string, IntegerRange> | undefined;
}

/** Versions of innermost while and for loops whose integer work depends on
 * locals that enter the loop without range facts: copies of module globals,
 * parameters, fields or call results (`const base = offset;` before a loop
 * that computes `(count + base) % 60`), or positions carried from one loop
 * to the next (`out[o++] = f(src[i++])` in a loop of `line` passes).
 *
 * The function is analyzed again with each number local the loop reads
 * without a fact assumed in LOOP_ENTRY_RANGE at the loop's entry. A loop is
 * versioned when that analysis proves what the function's own analysis
 * leaves unproven: both operands of a remainder, or the index of a typed
 * array read or write. Only those qualify: the operands of a product or a
 * sum of such locals are as often fractional, while an index that is not
 * an integer reads undefined, and a loop whose test fails runs the
 * ordinary copy in a larger function. A for loop qualifies only when its
 * initializer writes none of the assumed locals, so that they hold their
 * entry values when the test reads them.
 * The entry test covers only the assumed locals that such an operation reads, directly,
 * through the loop's writes of other locals, or through the loop condition;
 * when that drops any, the function is analyzed once more with the smaller
 * sets, so the facts never rest on a local the test does not check. No
 * fact leaves an assumed loop, so the loops' assumptions are independent. */
export function findLoopEntryVersions(
  fn: IrFunction,
  facts: IntegerRangeFacts,
  slots: IntegerSlotFacts = {},
): Map<IrStmt, LoopEntryVersion> {
  const result = new Map<IrStmt, LoopEntryVersion>();
  if (fn.async || fn.generator) return result;
  const captures = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  const eligible = new Set(
    fn.locals
      .filter((l) => l.type.kind === "f64" && !l.boxed && !l.tdz && !captures.has(l.id))
      .map((l) => l.id),
  );
  const known = (e: IrExpr): boolean => !!facts.ranges.get(e);
  // Keyed by the statement (a while or for loop).
  const candidates = new Map<IrStmt, ReadonlyMap<string, IntegerRange>>();
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (s) => {
      const loop: IrStmt = s;
      if ((s.kind !== "while" && s.kind !== "for") || containsLoop(s.body)) return true;
      const assumed = entryCandidates(loop, eligible, known);
      if (assumed.size > 0) candidates.set(loop, assumed);
      return true;
    },
  });
  if (candidates.size > 0) versionLoops(fn, facts, slots, candidates, result, gainedOperands);
  // A remainder-closed local (remainderClosedRange) whose reads carry no
  // fact, or one wider than its remainder's range, is assumed in that range
  // instead, together with the loop's other candidates: a linear
  // congruential step such as `seed = (seed * 3877 + 29573) % 139968` is
  // then exact in int32 with a non-negative dividend.
  const narrowed = new Map<IrStmt, ReadonlyMap<string, IntegerRange>>();
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (s) => {
      if ((s.kind !== "while" && s.kind !== "for") || containsLoop(s.body) || result.has(s))
        return true;
      const entry = new Map(candidates.get(s) ?? []);
      let changed = false;
      for (const [id, closed] of remainderClosedLocals(s, eligible, facts)) {
        entry.set(id, closed);
        changed = true;
      }
      if (changed) narrowed.set(s, entry);
      return true;
    },
  });
  if (narrowed.size > 0)
    versionLoops(fn, facts, slots, narrowed, result, (loop, known, versioned) => [
      ...gainedOperands(loop, known, versioned),
      ...narrowedDividends(loop, facts, versioned),
    ]);
  return result;
}

/** Versions the loops of `initial` whose assumed entry ranges give `roots`
 * (the operands the version gains), into `result`. */
function versionLoops(
  fn: IrFunction,
  facts: IntegerRangeFacts,
  slots: IntegerSlotFacts,
  initial: ReadonlyMap<IrStmt, ReadonlyMap<string, IntegerRange>>,
  result: Map<IrStmt, LoopEntryVersion>,
  roots: (loop: IrStmt, known: (e: IrExpr) => boolean, versioned: IntegerRangeFacts) => IrExpr[],
): void {
  const known = (e: IrExpr): boolean => !!facts.ranges.get(e);
  let candidates = initial;
  let versioned = analyzeIntegerRangeFacts(fn, slots, assumptionsOf(candidates));
  const pruned = new Map<IrStmt, ReadonlyMap<string, IntegerRange>>();
  let dropped = false;
  for (const [loop, entry] of candidates) {
    const gained = roots(loop, known, versioned);
    if (gained.length === 0) continue;
    const relevant = relevantLocals(loop, gained);
    const kept = new Map<string, IntegerRange>();
    for (const [id, range] of entry) if (relevant.has(id)) kept.set(id, range);
    if (kept.size < entry.size) dropped = true;
    if (kept.size > 0) pruned.set(loop, kept);
  }
  if (dropped) {
    candidates = pruned;
    if (candidates.size === 0) return;
    versioned = analyzeIntegerRangeFacts(fn, slots, assumptionsOf(candidates));
  }
  for (const [loop, entry] of candidates) {
    if (roots(loop, known, versioned).length === 0) continue;
    const ranges = new Map<IrExpr, IntegerRange>();
    const visit = (e: IrExpr): boolean => {
      const range = versioned.ranges.get(e);
      const prior = facts.ranges.get(e);
      if (range && !prior) ranges.set(e, range);
      else if (range && prior && (range.min > prior.min || range.max < prior.max))
        ranges.set(e, { min: Math.max(range.min, prior.min), max: Math.min(range.max, prior.max) });
      return true;
    };
    everyStmt(loop, { expr: visit, stmt: () => true });
    result.set(loop, { entry, ranges, loopRanges: versioned.loopRanges.get(loop) });
  }
}

/** The locals `loop` writes only as remainders by positive integer
 * literals (at most 2^31) and reads without a fact within [0, m - 1], m the
 * largest divisor: the values those writes give for non-negative
 * dividends. A local the loop declares, or a for loop's initializer writes,
 * holds no entry value to assume. */
function remainderClosedLocals(
  loop: IrStmt,
  eligible: ReadonlySet<string>,
  facts: IntegerRangeFacts,
): Map<string, IntegerRange> {
  const divisors = new Map<string, number>();
  const open = new Set<string>();
  const reads = new Map<string, IrExpr[]>();
  everyStmt(loop, {
    expr: (e) => {
      if (e.kind === "assignExpr" || e.kind === "incDec") open.add(e.localId);
      if (e.kind === "varRef") reads.set(e.localId, [...(reads.get(e.localId) ?? []), e]);
      return true;
    },
    stmt: (s) => {
      if (s.kind === "varDecl") open.add(s.localId);
      else if (s.kind === "assign") {
        const value = s.value;
        const m =
          value.kind === "bin" && value.op === "%" && value.right.kind === "numLit"
            ? value.right.value
            : NaN;
        if (Number.isInteger(m) && m > 0 && m <= 2 ** 31)
          divisors.set(s.localId, Math.max(divisors.get(s.localId) ?? 0, m));
        else open.add(s.localId);
      }
      return true;
    },
  });
  if (loop.kind === "for" && loop.init) for (const id of writtenIn(loop.init)) open.add(id);
  const result = new Map<string, IntegerRange>();
  for (const [id, m] of divisors) {
    if (open.has(id) || !eligible.has(id)) continue;
    const closed = { min: 0, max: m - 1 };
    const narrower = (reads.get(id) ?? []).some((e) => {
      const fact = facts.ranges.get(e);
      return !fact || fact.min < closed.min || fact.max > closed.max;
    });
    if (narrower) result.set(id, closed);
  }
  return result;
}

/** Dividends of the loop's remainders that the versioned analysis places
 * in the non-negative int32 range where the function's own analysis does
 * not: the remainder then runs as a 32-bit unsigned operation. */
function narrowedDividends(
  loop: IrStmt,
  facts: IntegerRangeFacts,
  versioned: IntegerRangeFacts,
): IrExpr[] {
  const operands: IrExpr[] = [];
  const nonNegativeInt32 = (range: IntegerRange | null | undefined): boolean =>
    !!range && range.min >= 0 && range.max <= NON_NEGATIVE_INT32_RANGE.max;
  everyStmt(loop, {
    expr: (e) => {
      if (
        e.kind === "bin" &&
        e.op === "%" &&
        !nonNegativeInt32(facts.ranges.get(e.left)) &&
        nonNegativeInt32(versioned.ranges.get(e.left)) &&
        !!versioned.ranges.get(e.right)
      )
        operands.push(e.left, e.right);
      return true;
    },
    stmt: () => true,
  });
  return operands;
}

function assumptionsOf(
  candidates: ReadonlyMap<IrStmt, ReadonlyMap<string, IntegerRange>>,
): LoopEntryAssumptions {
  const result = new Map<IrStmt, ReadonlyMap<string, IntegerRange>>();
  for (const [loop, entry] of candidates) result.set(loop, entry);
  return result;
}

/** Number locals the loop reads without a range fact and does not declare,
 * when the loop has a remainder or a typed array index without one. A for
 * loop whose initializer writes such a local has none. */
function entryCandidates(
  loop: IrStmt,
  eligible: ReadonlySet<string>,
  known: (e: IrExpr) => boolean,
): Map<string, IntegerRange> {
  const read = new Set<string>();
  const declared = new Set<string>();
  let integerWork = false;
  everyStmt(loop, {
    expr: (e) => {
      if ((e.kind === "varRef" || e.kind === "incDec") && eligible.has(e.localId) && !known(e))
        read.add(e.localId);
      else if (e.kind === "bin" && e.op === "%" && !known(e)) integerWork = true;
      const index = bytesIndex(e);
      if (index && !known(index)) integerWork = true;
      return true;
    },
    stmt: (s) => {
      if (s.kind === "varDecl") declared.add(s.localId);
      if (s.kind === "bytesSet" && !known(s.index)) integerWork = true;
      return true;
    },
  });
  const result = new Map<string, IntegerRange>();
  if (!integerWork) return result;
  const initialized = loop.kind === "for" && loop.init ? writtenIn(loop.init) : new Set<string>();
  for (const id of read) {
    if (initialized.has(id)) return new Map();
    if (!declared.has(id)) result.set(id, LOOP_ENTRY_RANGE);
  }
  return result;
}

/** The index of a typed array element read (`a[i]`, `buf.readInt16LE(i)`). */
function bytesIndex(e: IrExpr): IrExpr | undefined {
  if (e.kind !== "bytesIntrinsic") return undefined;
  const numeric = byteNumberAccess(e);
  if (numeric) return e.args[numeric.offsetArg];
  return e.method === "get" ? e.args[0] : undefined;
}

/** The locals `node` assigns, declares or increments. */
function writtenIn(node: IrStmt): Set<string> {
  const ids = new Set<string>();
  everyStmt(node, {
    expr: (e) => {
      if (e.kind === "assignExpr" || e.kind === "incDec") ids.add(e.localId);
      return true;
    },
    stmt: (s) => {
      if (s.kind === "assign" || s.kind === "varDecl") ids.add(s.localId);
      return true;
    },
  });
  return ids;
}

/** Operands of the loop's remainders and typed array indexes that the
 * versioned analysis proves where the function's own analysis does not
 * prove them. */
function gainedOperands(
  loop: IrStmt,
  known: (e: IrExpr) => boolean,
  versioned: IntegerRangeFacts,
): IrExpr[] {
  const operands: IrExpr[] = [];
  const gained = (e: IrExpr | undefined): boolean =>
    e !== undefined && !known(e) && !!versioned.ranges.get(e);
  everyStmt(loop, {
    expr: (e) => {
      if (
        e.kind === "bin" &&
        e.op === "%" &&
        !(known(e.left) && known(e.right)) &&
        !!versioned.ranges.get(e.left) &&
        !!versioned.ranges.get(e.right)
      )
        operands.push(e.left, e.right);
      const index = bytesIndex(e);
      if (gained(index)) operands.push(index!);
      return true;
    },
    stmt: (s) => {
      if (s.kind === "bytesSet" && gained(s.index)) operands.push(s.index);
      return true;
    },
  });
  return operands;
}

/** The locals `roots` read, closed over the loop's writes (a local written
 * from others reads them) and over its condition (a local the condition
 * reads makes every local of the condition relevant). A for loop's
 * condition bounds its passes, and with them the positions its body
 * advances (`o++` in a loop of `line` passes), so its locals are always
 * relevant. An increment or assignment reads its own local. */
function relevantLocals(loop: IrStmt, roots: readonly IrExpr[]): Set<string> {
  const relevant = new Set<string>();
  const readsOf = (e: IrExpr | null | undefined): string[] => {
    const ids: string[] = [];
    if (!e) return ids;
    everyExpr(e, {
      expr: (x) => {
        if (x.kind === "varRef" || x.kind === "incDec") ids.push(x.localId);
        return true;
      },
      stmt: () => true,
    });
    return ids;
  };
  const written = new Map<string, IrExpr[]>();
  everyStmt(loop, {
    expr: (e) => {
      if (e.kind === "assignExpr")
        written.set(e.localId, [...(written.get(e.localId) ?? []), e.value]);
      return true;
    },
    stmt: (s) => {
      const value = s.kind === "assign" ? s.value : s.kind === "varDecl" ? s.init : undefined;
      if (value && (s.kind === "assign" || s.kind === "varDecl"))
        written.set(s.localId, [...(written.get(s.localId) ?? []), value]);
      return true;
    },
  });
  const condition = readsOf(loop.kind === "while" || loop.kind === "for" ? loop.cond : null);
  const pending: string[] = [];
  const add = (id: string): void => {
    if (relevant.has(id)) return;
    relevant.add(id);
    pending.push(id);
  };
  for (const root of roots) for (const id of readsOf(root)) add(id);
  if (loop.kind === "for") for (const id of condition) add(id);
  while (pending.length > 0) {
    const id = pending.pop()!;
    for (const value of written.get(id) ?? []) for (const other of readsOf(value)) add(other);
    if (condition.includes(id)) for (const other of condition) add(other);
  }
  return relevant;
}

function containsLoop(body: IrStmt[]): boolean {
  return !everyStmtList(body, {
    expr: () => true,
    stmt: (s) =>
      s.kind !== "while" && s.kind !== "doWhile" && s.kind !== "for" && s.kind !== "forOf",
  });
}
