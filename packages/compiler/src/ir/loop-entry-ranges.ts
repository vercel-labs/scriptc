import type { IrExpr, IrFunction, IrStmt } from "./ir.js";
import { everyExpr, everyStmt, everyStmtList } from "./traverse.js";
import {
  analyzeIntegerRangeFacts,
  type IntegerRange,
  type IntegerRangeFacts,
  type IntegerSlotFacts,
  type LoopEntryAssumptions,
} from "./integer-ranges.js";

type WhileLoop = Extract<IrStmt, { kind: "while" }>;

/** The range a versioned loop requires of each assumed local on entry. A
 * loop's counters stay below a typed array or string length (at most 2^48),
 * so sums of a few such values and assumed locals stay exact integers. */
export const LOOP_ENTRY_RANGE: IntegerRange = { min: -(2 ** 48), max: 2 ** 48 };

/** A copy of a while loop that runs when every local in `entry` holds an
 * integer in its range on entry (never -0). `ranges` are the facts that
 * hold for the loop's expressions in that copy and that the function's own
 * analysis does not prove; `loopRanges` are the loop's bounded bindings
 * there. */
export interface LoopEntryVersion {
  entry: ReadonlyMap<string, IntegerRange>;
  ranges: ReadonlyMap<IrExpr, IntegerRange>;
  loopRanges: ReadonlyMap<string, IntegerRange> | undefined;
}

/** Versions of innermost while loops whose integer work depends on locals
 * that enter the loop without range facts: copies of module globals,
 * parameters, fields or call results (`const base = offset;` before a loop
 * that computes `(count + base) % 60`).
 *
 * The function is analyzed again with each number local the loop reads
 * without a fact assumed in LOOP_ENTRY_RANGE at the loop's entry. A loop is
 * versioned when that analysis proves both operands of a remainder that the
 * function's own analysis leaves unproven. Only remainders qualify: the
 * operands of a product or a sum of such locals are as often fractional,
 * and a loop whose test fails runs the ordinary copy in a larger function.
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
  let candidates = new Map<WhileLoop, ReadonlyMap<string, IntegerRange>>();
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (s) => {
      if (s.kind !== "while" || containsLoop(s.body)) return true;
      const assumed = entryCandidates(s, eligible, known);
      if (assumed.size > 0) candidates.set(s, assumed);
      return true;
    },
  });
  if (candidates.size === 0) return result;
  let versioned = analyzeIntegerRangeFacts(fn, slots, assumptionsOf(candidates));
  const pruned = new Map<WhileLoop, ReadonlyMap<string, IntegerRange>>();
  let dropped = false;
  for (const [loop, entry] of candidates) {
    const roots = gainedOperands(loop, known, versioned);
    if (roots.length === 0) continue;
    const relevant = relevantLocals(loop, roots);
    const kept = new Map<string, IntegerRange>();
    for (const [id, range] of entry) if (relevant.has(id)) kept.set(id, range);
    if (kept.size < entry.size) dropped = true;
    if (kept.size > 0) pruned.set(loop, kept);
  }
  if (dropped) {
    candidates = pruned;
    if (candidates.size === 0) return result;
    versioned = analyzeIntegerRangeFacts(fn, slots, assumptionsOf(candidates));
  }
  for (const [loop, entry] of candidates) {
    if (gainedOperands(loop, known, versioned).length === 0) continue;
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
  return result;
}

function assumptionsOf(
  candidates: ReadonlyMap<WhileLoop, ReadonlyMap<string, IntegerRange>>,
): LoopEntryAssumptions {
  const result = new Map<IrStmt, ReadonlyMap<string, IntegerRange>>();
  for (const [loop, entry] of candidates) result.set(loop, entry);
  return result;
}

/** Number locals the loop reads without a range fact and does not declare,
 * when the loop has a remainder without one. */
function entryCandidates(
  loop: WhileLoop,
  eligible: ReadonlySet<string>,
  known: (e: IrExpr) => boolean,
): Map<string, IntegerRange> {
  const read = new Set<string>();
  const declared = new Set<string>();
  let integerWork = false;
  everyStmt(loop, {
    expr: (e) => {
      if (e.kind === "varRef" && eligible.has(e.localId) && !known(e)) read.add(e.localId);
      else if (e.kind === "bin" && e.op === "%" && !known(e)) integerWork = true;
      return true;
    },
    stmt: (s) => {
      if (s.kind === "varDecl") declared.add(s.localId);
      return true;
    },
  });
  const result = new Map<string, IntegerRange>();
  if (!integerWork) return result;
  for (const id of read) if (!declared.has(id)) result.set(id, LOOP_ENTRY_RANGE);
  return result;
}

/** Operands of the loop's remainders that the versioned analysis proves
 * where the function's own analysis does not prove both. */
function gainedOperands(
  loop: WhileLoop,
  known: (e: IrExpr) => boolean,
  versioned: IntegerRangeFacts,
): IrExpr[] {
  const operands: IrExpr[] = [];
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
      return true;
    },
    stmt: () => true,
  });
  return operands;
}

/** The locals `roots` read, closed over the loop's writes (a local written
 * from others reads them) and over its condition (a local the condition
 * reads makes every local of the condition relevant). */
function relevantLocals(loop: WhileLoop, roots: readonly IrExpr[]): Set<string> {
  const relevant = new Set<string>();
  const readsOf = (e: IrExpr): string[] => {
    const ids: string[] = [];
    everyExpr(e, {
      expr: (x) => {
        if (x.kind === "varRef") ids.push(x.localId);
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
  const condition = readsOf(loop.cond);
  const pending: string[] = [];
  const add = (id: string): void => {
    if (relevant.has(id)) return;
    relevant.add(id);
    pending.push(id);
  };
  for (const root of roots) for (const id of readsOf(root)) add(id);
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
