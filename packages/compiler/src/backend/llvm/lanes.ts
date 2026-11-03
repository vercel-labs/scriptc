/* Lane loops: the `elementwise` lane plans of ir/lane-plans.ts, lowered to
 * LLVM vector IR.
 *
 * A planned loop keeps its scalar form. The emitter adds, before the loop's
 * copies, an entry guard and a lane loop:
 *
 *   guard:  SCRIPTC_LANES is on, at least one whole vector is left, and (for
 *           a sum) the element count is below the bound that makes every
 *           partial sum an exact double;
 *   lanes:  load <W x iN> at the element index, widen to <W x i64>, fold;
 *   exit:   add the folded lanes to the accumulator once and leave the
 *           induction at the lane loop's limit.
 *
 * The false edge of the guard, and the induction the lane loop leaves behind,
 * are the loop's own scalar code, unchanged: the loop's copies start at the
 * current induction, so they run the elements the lanes left over. The
 * accumulator is read from its slot after the last lane iteration (the scalar
 * body stores it at the end of every iteration), never from a value the lane
 * loop is about to overwrite.
 *
 * Exactness. Each lane sums a subclass of the elements, and the lanes' i64
 * sums are folded into the accumulator once. Any order gives the same double
 * when every partial sum is an integer below 2^53 in magnitude. The plan
 * requires the accumulator to be exactly +0 at the loop entry, so the loop's
 * own partial sums are the sums of element prefixes, which the entry guard
 * keeps below 2^53 for the sum shape (the count shape's result is at most the
 * length). The scalar remainder then adds the elements the lanes left over:
 * every partial sum of that addition is also a prefix sum of the loop, hence
 * also below the bound. Node's ordered fadd chain over the same integers
 * cannot round either, so both produce the same double. */

import type { LanePlan, LaneShape } from "../../ir/lane-plans.js";
import { laneElem, laneShapesFromEnvironment, planLaneLoops } from "../../ir/lane-plans.js";
import { emitBytesData, emitBytesHeaderLength } from "./expr-bytes.js";
import { defineModuleState } from "./emitter-state.js";
import type { LlEmitter } from "./emitter.js";
import type { IrFunction, IrStmt } from "../../ir/ir.js";

/** The run-time toggle: `SCRIPTC_LANES=0` runs the scalar loops. */
const TOGGLE = "@sc_lanes";

/** The call main makes when the program has lane loops. */
export const LANE_INIT_CALL = `  call void @sc_lanes_init()`;

export interface LaneState {
  /** The shapes this build plans (`SCRIPTC_LANES_PLAN`). */
  shapes: ReadonlySet<LaneShape>;
  /** Integers per vector. */
  width: number;
  /** The function being emitted: its plans, by loop statement. */
  plans: Map<IrStmt, LanePlan>;
}

export const LANES = defineModuleState<LaneState>((emitter) => ({
  shapes: laneShapesFromEnvironment(),
  width: laneWidth(emitter),
  plans: new Map(),
}));

/** Whether this build emits lane loops at all. */
export function lanePlansEnabled(emitter: LlEmitter): boolean {
  return LANES.of(emitter).shapes.size > 0;
}

/** Integers per vector for the target. The width is a property of the
 * target, not of a plan, so one plan lowers to every target's width. A
 * target without vector integers (wasm) gets width 1 and no plans. */
export function laneWidth(emitter: LlEmitter): number {
  if (emitter.wasi) return 1;
  const triple = emitter.targetTriple.toLowerCase();
  const host = triple || `${process.arch}-${process.platform}`;
  if (/^(aarch64|arm64)/.test(host)) return 4;
  if (!/^(x86_64|amd64|x64)/.test(host)) return 1;
  // A dispatching executable carries one body per level; the body is the
  // baseline's width, which every level it runs on can execute.
  if (emitter.cpuDispatch) return 4;
  switch (emitter.targetCpu) {
    case "x86-64-v2":
      return 4;
    case "x86-64-v3":
      return 8;
    case "x86-64-v4":
      return 16;
    default:
      return 4;
  }
}

/** Sets the lane plans of the function emission is starting. The matcher is
 * the loop matcher's: the function with its initializer bindings, which is
 * the one `emitter.emitStmts` walks. */
export function beginFunctionLanes(emitter: LlEmitter, fn: IrFunction): void {
  const state = LANES.of(emitter);
  state.plans =
    state.shapes.size === 0 || emitter.debug !== null
      ? new Map()
      : planLaneLoops(fn, emitter.numericLocals, state.shapes);
}

/** The plan for one loop, when the emitter can lower it here: a synchronous
 * function on a target with vector integers, outside every value-layout copy
 * the lane body does not write. */
export function laneLoopPlan(emitter: LlEmitter, loop: IrStmt): LanePlan | null {
  const state = LANES.of(emitter);
  if (state.width < 2 || emitter.debug !== null) return null;
  if (emitter.mod.workers === true || emitter.mod.bytesHeadersMutable === true) return null;
  if (emitter.speculation !== null || emitter.speculationResume !== null) return null;
  if (emitter.int32Kinds !== null) return null;
  const plan = state.plans.get(loop);
  if (plan === undefined) return null;
  // The lane body stores the accumulator's double slot directly; an int32
  // local keeps an integer in that slot, and its copies handle those loops.
  if (emitter.int32Locals.has(plan.accumulator)) return null;
  const binding = emitter.binding(plan.accumulator);
  if (binding.kind !== "local" || binding.type.kind !== "f64") return null;
  return plan;
}

/** The LLVM integer comparison for a count's element test. */
const ICMP: ReadonlyMap<string, [signed: string, unsigned: string]> = new Map([
  ["<", ["slt", "ult"]],
  ["<=", ["sle", "ule"]],
  [">", ["sgt", "ugt"]],
  [">=", ["sge", "uge"]],
  ["===", ["eq", "eq"]],
  ["!==", ["ne", "ne"]],
]);

/** Emits the entry guard and the lane loop for `plan`, then starts `cont`.
 * `receiver` is the loop's limit expression (the typed array read at the
 * induction variable); `inductionSlot` is the loop's counter. Every path out
 * of the lane code reaches `cont` with the scalar loop's inputs in place: the
 * counter at the lane loop's limit when the lanes ran, untouched when they
 * did not. */
export function emitLaneLoop(
  emitter: LlEmitter,
  plan: LanePlan,
  receiver: Parameters<LlEmitter["emitStableReceiver"]>[0],
  inductionSlot: string,
  cont: string,
): void {
  const B = emitter.B;
  const width = LANES.of(emitter).width;
  const elem = laneElem(plan.elem);
  if (elem === null) throw new Error(`lane plan on a ${plan.elem} element`);
  const size = emitter.sizeType;
  const view = emitter.emitStableReceiver(receiver, []);
  const length = emitBytesHeaderLength(emitter, view.name);
  const data = emitBytesData(emitter, view.name);
  // The counter at the entry, and the elements left from it: the lane loop
  // covers the whole vectors of that span and leaves the rest to the loop.
  const start = B.tmp(),
    span = B.tmp();
  B.line(`${start} = load ${size}, ptr ${inductionSlot}`);
  B.line(`${span} = sub nuw ${size} ${length}, ${start}`);
  // The toggle: a predictable load every entry, as the design's guard says.
  const toggle = B.tmp(),
    enabled = B.tmp(),
    wide = B.tmp();
  B.line(`${toggle} = load i32, ptr ${TOGGLE}`);
  B.line(`${enabled} = icmp ne i32 ${toggle}, 0`);
  B.line(`${wide} = icmp uge ${size} ${span}, ${width}`);
  let ok = B.tmp();
  B.line(`${ok} = and i1 ${enabled}, ${wide}`);
  const tighten = (cond: string): void => {
    const both = B.tmp();
    B.line(`${both} = and i1 ${ok}, ${cond}`);
    ok = both;
  };
  if (plan.shape === "sum") {
    const bound = B.tmp();
    B.line(`${bound} = icmp ult ${size} ${length}, ${plan.lengthBound}`);
    tighten(bound);
  }
  // The lane loop's exclusive end: whole vectors from the entry.
  const whole = B.tmp(),
    limit = B.tmp();
  B.line(`${whole} = and ${size} ${span}, ${-width}`);
  B.line(`${limit} = add nuw ${size} ${start}, ${whole}`);
  const init = B.newLabel("lane.init"),
    header = B.newLabel("lane.c"),
    body = B.newLabel("lane.b"),
    exit = B.newLabel("lane.x");
  const accSlot = B.slot();
  B.entryAllocas.push(`${accSlot} = alloca <${width} x i64> ; lane sums`);
  let record = `<${width} x i64> zeroinitializer`;
  if (plan.shape === "count") {
    // `element <op> limit` in integers: the limit must be an exact integer
    // in the element's range, which the entry checks once. Otherwise the
    // scalar loop answers with the same doubles it would have compared.
    const value = emitter.emitExpr(plan.compare.limit);
    const lowest = elem.signed ? -(2 ** (elem.bits - 1)) : 0;
    const highest = elem.signed ? 2 ** (elem.bits - 1) : 2 ** elem.bits;
    const lowOk = B.tmp(),
      highOk = B.tmp(),
      inRange = B.tmp(),
      safe = B.tmp();
    B.line(`${lowOk} = fcmp oge double ${value.name}, ${lowest}.0`);
    B.line(`${highOk} = fcmp olt double ${value.name}, ${highest}.0`);
    B.line(`${inRange} = and i1 ${lowOk}, ${highOk}`);
    B.line(`${safe} = select i1 ${inRange}, double ${value.name}, double 0.0`);
    const narrow64 = B.tmp(),
      back = B.tmp(),
      exact = B.tmp();
    B.line(`${narrow64} = fptosi double ${safe} to i64`);
    B.line(`${back} = sitofp i64 ${narrow64} to double`);
    B.line(`${exact} = fcmp oeq double ${back}, ${value.name}`);
    const integer = B.tmp();
    B.line(`${integer} = and i1 ${inRange}, ${exact}`);
    tighten(integer);
    const narrow = B.tmp(),
      first = B.tmp(),
      splat = B.tmp();
    B.line(`${narrow} = trunc i64 ${narrow64} to ${elem.type}`);
    B.line(
      `${first} = insertelement <${width} x ${elem.type}> poison, ${elem.type} ${narrow}, i32 0`,
    );
    B.line(
      `${splat} = shufflevector <${width} x ${elem.type}> ${first}, <${width} x ${elem.type}> poison, <${width} x i32> zeroinitializer`,
    );
    record = splat;
  }
  B.condBr(ok, init, cont);
  B.startBlock(init);
  B.line(`store <${width} x i64> zeroinitializer, ptr ${accSlot}`);
  B.br(header);
  B.startBlock(header);
  const index = B.tmp(),
    more = B.tmp();
  B.line(`${index} = load ${size}, ptr ${inductionSlot}`);
  B.line(`${more} = icmp ult ${size} ${index}, ${limit}`);
  B.condBr(more, body, exit);
  B.startBlock(body);
  const at = B.tmp(),
    elements = B.tmp(),
    terms = B.tmp(),
    before = B.tmp(),
    after = B.tmp(),
    next = B.tmp();
  B.line(`${at} = getelementptr inbounds ${elem.type}, ptr ${data}, ${size} ${index}`);
  // align 1: a view's backing may be any alignment; the load still lowers to
  // one unaligned vector move on every target this emits for.
  B.line(`${elements} = load <${width} x ${elem.type}>, ptr ${at}, align 1`);
  if (plan.shape === "sum") {
    B.line(
      `${terms} = ${elem.signed ? "sext" : "zext"} <${width} x ${elem.type}> ${elements} to <${width} x i64>`,
    );
  } else {
    const [signed, unsigned] = ICMP.get(plan.compare.op) ?? ["sge", "uge"];
    const mask = B.tmp();
    B.line(
      `${mask} = icmp ${elem.signed ? signed : unsigned} <${width} x ${elem.type}> ${elements}, ${record}`,
    );
    B.line(`${terms} = zext <${width} x i1> ${mask} to <${width} x i64>`);
  }
  B.line(`${before} = load <${width} x i64>, ptr ${accSlot}`);
  B.line(`${after} = add <${width} x i64> ${before}, ${terms}`);
  B.line(`store <${width} x i64> ${after}, ptr ${accSlot}`);
  B.line(`${next} = add nuw ${size} ${index}, ${width}`);
  B.line(`store ${size} ${next}, ptr ${inductionSlot}`);
  B.br(header);
  B.startBlock(exit);
  const lanes = B.tmp();
  B.line(`${lanes} = load <${width} x i64>, ptr ${accSlot}`);
  let reduced: string | null = null;
  for (let lane = 0; lane < width; lane++) {
    const value = B.tmp();
    B.line(`${value} = extractelement <${width} x i64> ${lanes}, i32 ${lane}`);
    if (reduced === null) reduced = value;
    else {
      const sum = B.tmp();
      B.line(`${sum} = add i64 ${reduced}, ${value}`);
      reduced = sum;
    }
  }
  const exact = B.tmp(),
    current = B.tmp(),
    total = B.tmp();
  B.line(`${exact} = sitofp i64 ${reduced} to double`);
  B.line(`${current} = load double, ptr ${emitter.binding(plan.accumulator).slot}`);
  B.line(`${total} = fadd double ${current}, ${exact}`);
  B.line(`store double ${total}, ptr ${emitter.binding(plan.accumulator).slot}`);
  B.br(cont);
  B.startBlock(cont);
}

/** @sc_lanes and @sc_lanes_init, which main calls first: `SCRIPTC_LANES=0`
 * turns every lane loop off, and any other value leaves them on. */
export function laneToggleDefs(declare: (line: string) => void): string[] {
  declare(`declare ptr @getenv(ptr)`);
  declare(`declare i32 @strcmp(ptr, ptr)`);
  return [
    `${TOGGLE} = internal global i32 1`,
    `@sc_lanes_env = private unnamed_addr constant [14 x i8] c"SCRIPTC_LANES\\00"`,
    `@sc_lanes_off = private unnamed_addr constant [2 x i8] c"0\\00"`,
    `define internal void @sc_lanes_init() #0 {`,
    `entry:`,
    `  %env = call ptr @getenv(ptr @sc_lanes_env)`,
    `  %has = icmp ne ptr %env, null`,
    `  br i1 %has, label %check, label %done`,
    `check:`,
    `  %same = call i32 @strcmp(ptr %env, ptr @sc_lanes_off)`,
    `  %off = icmp eq i32 %same, 0`,
    `  br i1 %off, label %disable, label %done`,
    `disable:`,
    `  store i32 0, ptr ${TOGGLE}`,
    `  br label %done`,
    `done:`,
    `  ret void`,
    `}`,
    ``,
  ];
}
