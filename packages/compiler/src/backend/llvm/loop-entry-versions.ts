/* Loop-entry range versions (ir/loop-entry-ranges.ts): a while or for loop whose
 * integer work depends on locals entering it without range facts runs as
 * two copies. A test on entry checks that each such local holds an integer
 * in its assumed range; the fast copy is emitted under the facts that hold
 * then, and the other copy is the loop as it would be emitted otherwise. */
import type { IrFunction, IrModule, IrStmt } from "../../ir/ir.js";
import { everyStmt, everyStmtList } from "../../ir/traverse.js";
import { exprFunctionReference, moduleFunctionReferences } from "../../ir/function-references.js";
import type { IntegerRangeFacts, IntegerSlotFacts } from "../../ir/integer-ranges.js";
import { findLoopEntryVersions, type LoopEntryVersion } from "../../ir/loop-entry-ranges.js";
import { f64Lit } from "./common.js";
import type { LlEmitter } from "./emitter.js";
import { defineModuleState } from "./emitter-state.js";

interface LoopEntryState {
  fn: IrFunction | null;
  facts: IntegerRangeFacts | null;
  slots: IntegerSlotFacts;
  /** Found on the first while or for loop the function emits. */
  versions: Map<IrStmt, LoopEntryVersion> | null;
  /** Loops whose copies are being emitted: a loop is versioned once. */
  readonly versioning: Set<IrStmt>;
  /** Direct calls per module function, or -1 for a function some value or
   * the module's metadata references. */
  calls: Map<string, number> | null;
  /** The callees whose calls the fast copy being emitted inlines. */
  inlined: ReadonlySet<string> | null;
}

const ENTRY_VERSIONS = defineModuleState<LoopEntryState>(() => ({
  fn: null,
  facts: null,
  slots: {},
  versions: null,
  versioning: new Set<IrStmt>(),
  calls: null,
  inlined: null,
}));

/** The most IR nodes a callee may have for its call in a fast copy to be
 * inlined (singleCallees). */
const MAX_INLINED_NODES = 400;

/** Sets the state for the function about to be emitted: `numericFn` and the
 * facts emitFunction computed for it. Debug builds keep every loop as is. */
export function beginLoopEntryVersions(
  emitter: LlEmitter,
  numericFn: IrFunction,
  slots: IntegerSlotFacts,
  facts: IntegerRangeFacts,
): void {
  const state = ENTRY_VERSIONS.of(emitter);
  state.fn = emitter.debug === null ? numericFn : null;
  state.slots = slots;
  state.facts = facts;
  state.versions = null;
  state.versioning.clear();
}

/** The entry version of `loop`, when it has one and the emitter can test
 * its locals: plain double slots of the current function, outside a
 * speculative copy and a coroutine. */
export function loopEntryVersion(emitter: LlEmitter, loop: IrStmt): LoopEntryVersion | null {
  if (loop.kind !== "while" && loop.kind !== "for") return null;
  const state = ENTRY_VERSIONS.of(emitter);
  if (state.fn === null || state.facts === null || state.versioning.has(loop)) return null;
  if (
    !emitter.speculativeLoopsEnabled ||
    emitter.speculation !== null ||
    emitter.speculationResume !== null ||
    emitter.currentCoro !== null
  )
    return null;
  state.versions ??= findLoopEntryVersions(state.fn, state.facts, state.slots);
  const version = state.versions.get(loop);
  if (!version) return null;
  for (const id of version.entry.keys())
    if (!emitter.currentLocals.has(id) || !emitter.speculativeLocal(id)) return null;
  return version;
}

/** Emit the entry test and both copies of `loop`. `emitCopies` emits the
 * loop as it would be emitted without the version; it runs once under the
 * version's facts and once as is. */
export function emitLoopEntryVersion(
  emitter: LlEmitter,
  loop: IrStmt,
  version: LoopEntryVersion,
  emitCopies: () => void,
): void {
  const B = emitter.B;
  let ok: string | null = null;
  for (const [id, range] of version.entry) {
    // An integer in [min, max] other than -0: the ordered comparisons
    // reject NaN, and the bits of the value and its round trip agree only
    // for integers that are not -0. A local the loop writes before it reads
    // may be unset on entry, and a conversion out of range is poison:
    // `freeze` makes both an arbitrary fixed value.
    const raw = B.tmp(),
      value = B.tmp(),
      low = B.tmp(),
      high = B.tmp(),
      converted = B.tmp(),
      integer = B.tmp(),
      back = B.tmp(),
      bits = B.tmp(),
      backBits = B.tmp(),
      exact = B.tmp(),
      inRange = B.tmp(),
      passed = B.tmp();
    B.line(`${raw} = load double, ptr ${emitter.binding(id).slot}`);
    B.line(`${value} = freeze double ${raw}`);
    B.line(`${low} = fcmp oge double ${value}, ${f64Lit(range.min)}`);
    B.line(`${high} = fcmp ole double ${value}, ${f64Lit(range.max)}`);
    B.line(`${converted} = fptosi double ${value} to i64`);
    B.line(`${integer} = freeze i64 ${converted}`);
    B.line(`${back} = sitofp i64 ${integer} to double`);
    B.line(`${bits} = bitcast double ${value} to i64`);
    B.line(`${backBits} = bitcast double ${back} to i64`);
    B.line(`${exact} = icmp eq i64 ${bits}, ${backBits}`);
    B.line(`${inRange} = and i1 ${low}, ${high}`);
    B.line(`${passed} = and i1 ${inRange}, ${exact}`);
    if (ok === null) ok = passed;
    else {
      const both = B.tmp();
      B.line(`${both} = and i1 ${ok}, ${passed}`);
      ok = both;
    }
  }
  const fast = B.newLabel("entry.fast"),
    slow = B.newLabel("entry.slow");
  // The test is expected to pass, which keeps the ordinary copy's calls
  // cold for the inliner.
  let likely = "true";
  if (ok !== null) {
    emitter.declare("declare i1 @llvm.expect.i1(i1, i1)");
    likely = B.tmp();
    B.line(`${likely} = call i1 @llvm.expect.i1(i1 ${ok}, i1 true)`);
  }
  B.condBr(likely, fast, slow);
  const state = ENTRY_VERSIONS.of(emitter);
  const originalRanges = emitter.integerRanges;
  const originalLoopRanges = emitter.integerLoopRanges;
  state.versioning.add(loop);
  try {
    B.startBlock(fast);
    // An enclosing version may have narrowed a range already.
    const ranges = new Map(originalRanges);
    for (const [node, range] of version.ranges) {
      const known = originalRanges.get(node);
      ranges.set(
        node,
        known
          ? { min: Math.max(known.min, range.min), max: Math.min(known.max, range.max) }
          : range,
      );
    }
    emitter.integerRanges = ranges;
    state.inlined = singleCallees(emitter, state, loop);
    if (version.loopRanges) {
      const loopRanges = new Map(originalLoopRanges);
      loopRanges.set(loop, version.loopRanges);
      emitter.integerLoopRanges = loopRanges;
    }
    emitCopies();
    state.inlined = null;
    emitter.integerRanges = originalRanges;
    emitter.integerLoopRanges = originalLoopRanges;
    B.startBlock(slow);
    emitCopies();
  } finally {
    emitter.integerRanges = originalRanges;
    emitter.integerLoopRanges = originalLoopRanges;
    state.versioning.delete(loop);
    state.inlined = null;
  }
}

/** Whether the fast copy being emitted inlines its calls of `callee`. */
export function loopEntryInlines(emitter: LlEmitter, callee: string): boolean {
  return ENTRY_VERSIONS.of(emitter).inlined?.has(callee) === true;
}

/** The functions the loop calls that have no other call or reference in
 * the module and at most MAX_INLINED_NODES nodes. LLVM inlines a function's
 * only call at almost any size; the two copies give each such function a
 * second call, so the fast copy's call is marked to keep that inlining. */
function singleCallees(emitter: LlEmitter, state: LoopEntryState, loop: IrStmt): Set<string> {
  const callees = new Set<string>();
  everyStmt(loop, {
    expr: (e) => {
      if (e.kind === "call") callees.add(e.callee);
      return true;
    },
    stmt: () => true,
  });
  const result = new Set<string>();
  if (callees.size === 0) return result;
  state.calls ??= countCalls(emitter.mod);
  for (const name of callees) {
    if (state.calls.get(name) !== 1 || name === state.fn?.name) continue;
    const fn = emitter.mod.functions.find((f) => f.name === name);
    if (fn && !fn.async && !fn.generator && nodeCount(fn.body) <= MAX_INLINED_NODES)
      result.add(name);
  }
  return result;
}

function countCalls(mod: IrModule): Map<string, number> {
  const calls = new Map<string, number>();
  const referenced = new Set(moduleFunctionReferences(mod));
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      expr: (e) => {
        if (e.kind === "call") calls.set(e.callee, (calls.get(e.callee) ?? 0) + 1);
        const name = exprFunctionReference(e);
        if (name !== undefined) referenced.add(name);
        return true;
      },
      stmt: () => true,
    });
  for (const name of referenced) calls.set(name, -1);
  return calls;
}

function nodeCount(body: IrStmt[]): number {
  let count = 0;
  const visit = (): boolean => ++count <= MAX_INLINED_NODES;
  everyStmtList(body, { expr: visit, stmt: visit });
  return count;
}
