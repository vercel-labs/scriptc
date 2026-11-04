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
 * A store loop is the same skeleton without an accumulator: the guard keeps
 * the toggle and a whole vector and adds the entry tests the stored value
 * needs, the lane loop transcribes the value's tree lane by lane and writes
 * one vector, and the scalar copies write the elements the lanes left over.
 *
 * A dense `number[]` plan carries one more entry test. Its slots hold int32s
 * or doubles, decided per array at run time and never mixed, so the guard
 * also requires the storage kind the plan was made for (`SCR_ELEM_I32` for a
 * sum's or count's exact integer elements, `SCR_ELEM_F64` for a store's
 * doubles) and that every slot below the length holds a value (`filled`) —
 * the scalar element read traps on a hole, and the lanes have nowhere to put
 * that trap. A sum's or count's lanes read the int32 slots and widen them
 * with their sign, which the entry bounds keep in range.
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

import type {
  LaneContainer,
  LaneElemName,
  LanePlan,
  LaneShape,
  LaneStorePlan,
  LaneValueNode,
} from "../../ir/lane-plans.js";
import { laneElem, laneShapesFromEnvironment, planLaneLoops } from "../../ir/lane-plans.js";
import { withinInt32, type IntegerRange } from "../../ir/integer-ranges.js";
import { loadArrCount, SCR_ARR_FIELD } from "./common.js";
import { SCR_ELEM_F64, SCR_ELEM_I32 } from "./dense-array-access.js";
import { emitBytesData, emitBytesHeaderLength } from "./expr-bytes.js";
import type { LlValue } from "./expr-context.js";
import { defineModuleState } from "./emitter-state.js";
import type { LlEmitter } from "./emitter.js";
import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";

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
  if (plan.shape !== "store") {
    if (emitter.int32Locals.has(plan.accumulator)) return null;
    const binding = emitter.binding(plan.accumulator);
    if (binding.kind !== "local" || binding.type.kind !== "f64") return null;
  }
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

/** The parts of a lane loop's entry that every shape shares: the counter's
 * start, the elements left from it, the vector-aligned limit the lane loop
 * stops at, and the guard that turns the whole thing off. */
interface LaneEntry {
  length: string;
  data: string;
  start: string;
  span: string;
  whole: string;
  limit: string;
  /** The guard so far; `tighten` conjoins one more test. */
  ok: string;
  /** The shared guard before any shape-specific test: the toggle, a whole
   * vector left, and the storage. A shape whose tests cost more than a load
   * and a compare branches on this first, so a disabled toggle skips them. */
  base: string;
  tighten: (cond: string) => void;
}

/** The address of one %ScrArr header field. */
function arrayHeaderField(emitter: LlEmitter, array: string, field: number): string {
  const B = emitter.B;
  const ptr = B.tmp();
  B.line(`${ptr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${field}`);
  emitter.markMemoryPointer(ptr, "array:header");
  return ptr;
}

/** A dense number array's length, or the hole-free prefix bound below which
 * every slot holds a present value, in the target's size type. */
function emitArrayHeaderCount(emitter: LlEmitter, array: string, field: "len" | "filled"): string {
  const B = emitter.B;
  const ptr = arrayHeaderField(emitter, array, SCR_ARR_FIELD[field]);
  const count = B.tmp();
  if (field === "len") {
    loadArrCount(emitter, count, ptr, emitter.fieldAliasAttachment(ptr));
    return count;
  }
  const narrow = B.tmp();
  B.line(`${narrow} = load i32, ptr ${ptr}${emitter.fieldAliasAttachment(ptr)}`);
  if (emitter.sizeType === "i32") return narrow;
  B.line(`${count} = zext i32 ${narrow} to i64`);
  return count;
}

/** The dense value storage base of a number array. */
function emitArrayData(emitter: LlEmitter, array: string): string {
  const B = emitter.B;
  const ptr = arrayHeaderField(emitter, array, SCR_ARR_FIELD.data);
  const data = B.tmp();
  B.line(`${data} = load ptr, ptr ${ptr}${emitter.fieldAliasAttachment(ptr)}`);
  return data;
}

/** Whether every slot below the array's length is a present value held in
 * the storage the plan reads: `length <= filled`, and the array's slots are
 * the kind the plan was made for. A dense array keeps every slot below
 * `filled` a present value, so the lane loop needs no per-element state
 * test; the storage kind decides whether those slots are int32s (sums and
 * counts) or doubles (stores). */
function emitDenseSlotTest(
  emitter: LlEmitter,
  array: string,
  length: string,
  elem: LaneElemName,
): string {
  const B = emitter.B;
  const size = emitter.sizeType;
  const filled = emitArrayHeaderCount(emitter, array, "filled");
  const covered = B.tmp();
  B.line(`${covered} = icmp ule ${size} ${length}, ${filled}`);
  const kindPtr = arrayHeaderField(emitter, array, SCR_ARR_FIELD.elem);
  const kind = B.tmp(),
    same = B.tmp(),
    wanted = elem === "i32slot" ? SCR_ELEM_I32 : SCR_ELEM_F64;
  B.line(`${kind} = load i8, ptr ${kindPtr}${emitter.fieldAliasAttachment(kindPtr)}`);
  B.line(`${same} = icmp eq i8 ${kind}, ${wanted}`);
  const ok = B.tmp();
  B.line(`${ok} = and i1 ${covered}, ${same}`);
  return ok;
}

function emitLaneEntry(
  emitter: LlEmitter,
  plan: { container: LaneContainer; elem: LaneElemName },
  receiver: Parameters<LlEmitter["emitStableReceiver"]>[0],
  inductionSlot: string,
): LaneEntry {
  const B = emitter.B;
  const width = LANES.of(emitter).width;
  const size = emitter.sizeType;
  const view = emitter.emitStableReceiver(receiver, []);
  const length =
    plan.container === "bytes"
      ? emitBytesHeaderLength(emitter, view.name)
      : emitArrayHeaderCount(emitter, view.name, "len");
  const data =
    plan.container === "bytes"
      ? emitBytesData(emitter, view.name)
      : emitArrayData(emitter, view.name);
  const storage =
    plan.container === "bytes" ? null : emitDenseSlotTest(emitter, view.name, length, plan.elem);
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
  const entry: LaneEntry = {
    length,
    data,
    start,
    span,
    whole: "",
    limit: "",
    ok: "",
    base: "",
    tighten: (cond: string): void => {
      const both = B.tmp();
      B.line(`${both} = and i1 ${entry.ok}, ${cond}`);
      entry.ok = both;
    },
  };
  let first = B.tmp();
  B.line(`${first} = and i1 ${enabled}, ${wide}`);
  if (storage !== null) {
    const inStorage = B.tmp();
    B.line(`${inStorage} = and i1 ${first}, ${storage}`);
    first = inStorage;
  }
  entry.ok = first;
  entry.base = first;
  // The lane loop's exclusive end: whole vectors from the entry.
  const whole = B.tmp(),
    limit = B.tmp();
  B.line(`${whole} = and ${size} ${span}, ${-width}`);
  B.line(`${limit} = add nuw ${size} ${start}, ${whole}`);
  entry.whole = whole;
  entry.limit = limit;
  return entry;
}

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
  if (plan.shape === "store") {
    emitLaneStore(emitter, plan, receiver, inductionSlot, cont);
    return;
  }
  const B = emitter.B;
  const width = LANES.of(emitter).width;
  const elem = laneElem(plan.elem);
  if (elem === null) throw new Error(`lane plan on a ${plan.elem} element`);
  const size = emitter.sizeType;
  const entry = emitLaneEntry(emitter, plan, receiver, inductionSlot);
  const { length, data, limit } = entry;
  if (plan.shape === "sum") {
    const bound = B.tmp();
    B.line(`${bound} = icmp ult ${size} ${length}, ${plan.lengthBound}`);
    entry.tighten(bound);
  }
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
    entry.tighten(integer);
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
  B.condBr(entry.ok, init, cont);
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

/* ---- Stores ---- */

/** The LLVM type one element of a stored array holds. */
interface StoreElem {
  type: "i8" | "i16" | "i32" | "float" | "double";
  /** The largest magnitude the element holds. */
  max: number;
  float: boolean;
  clamped: boolean;
  signed: boolean;
}

function storeElem(elem: LaneElemName): StoreElem | null {
  switch (elem) {
    case "u8c":
      return { type: "i8", max: 255, float: false, clamped: true, signed: false };
    case "u8":
      return { type: "i8", max: 255, float: false, clamped: false, signed: false };
    case "i8":
      return { type: "i8", max: 128, float: false, clamped: false, signed: true };
    case "u16":
      return { type: "i16", max: 65535, float: false, clamped: false, signed: false };
    case "i16":
      return { type: "i16", max: 32768, float: false, clamped: false, signed: true };
    case "u32":
      return { type: "i32", max: 4294967295, float: false, clamped: false, signed: false };
    case "i32":
      return { type: "i32", max: 2147483648, float: false, clamped: false, signed: true };
    case "f32":
      return { type: "float", max: 0, float: true, clamped: false, signed: true };
    case "f64":
      return { type: "double", max: 0, float: true, clamped: false, signed: true };
    // A dense number array's double slots hold the stored double as it is.
    case "f64slot":
      return { type: "double", max: 0, float: true, clamped: false, signed: true };
    default:
      return null;
  }
}

/** A vector holding one constant in every lane, as the constant expression
 * the IR uses (`splat (i64 1)`). */
function vectorSplatLiteral(type: string, literal: string): string {
  return `splat (${type} ${literal})`;
}

/** `<W x i64>` <0, 1, ... W-1>, built once per loop entry: the constant
 * folding pass turns the chain into a vector constant. */
function laneIndices(emitter: LlEmitter, width: number): string {
  const B = emitter.B;
  let vec = B.tmp();
  B.line(`${vec} = insertelement <${width} x i64> poison, i64 0, i32 0`);
  for (let lane = 1; lane < width; lane++) {
    const next = B.tmp();
    B.line(`${next} = insertelement <${width} x i64> ${vec}, i64 ${lane}, i32 ${lane}`);
    vec = next;
  }
  return vec;
}

function splatValue(emitter: LlEmitter, type: string, value: string, width: number): string {
  const B = emitter.B;
  const first = B.tmp(),
    vec = B.tmp();
  B.line(`${first} = insertelement <${width} x ${type}> poison, ${type} ${value}, i32 0`);
  B.line(
    `${vec} = shufflevector <${width} x ${type}> ${first}, <${width} x ${type}> poison, <${width} x i32> zeroinitializer`,
  );
  return vec;
}

/** An exact integer a stored value's invariant contributes, when it has one:
 * the integer the invariant was emitted with, or an integer literal within
 * int32. The literal's bound is what keeps the integer route's i64 arithmetic
 * from overflowing: an induction below 2^31 times such a literal is below
 * 2^62. A larger or fractional literal takes the double route instead. */
function invariantInteger(
  expr: IrExpr,
  value: LlValue,
): { type: "i32" | "i64"; name: string; range: IntegerRange } | null {
  if (value.integer !== undefined) return value.integer;
  if (expr.kind !== "numLit") return null;
  const literal = expr.value;
  if (!Number.isInteger(literal) || Object.is(literal, -0)) return null;
  if (!withinInt32({ min: literal, max: literal })) return null;
  return { type: "i64", name: String(literal), range: { min: literal, max: literal } };
}

/** The value's low 32 bits as lanes: ToUint32, exactly as expr-bytes.ts
 * `emitToUint32` computes it. `emitValueBound` keeps every lane below 2^63 in
 * magnitude at the loop entry, where one `fptosi` and one `trunc` are the
 * integer the scalar body's own fast path stores. */
function emitVectorToUint32(emitter: LlEmitter, value: string, width: number): string {
  const B = emitter.B;
  const integer = B.tmp(),
    low = B.tmp();
  B.line(`${integer} = fptosi <${width} x double> ${value} to <${width} x i64>`);
  B.line(`${low} = trunc <${width} x i64> ${integer} to <${width} x i32>`);
  return low;
}

/** ToUint8Clamp as one lane of a vector, the same branch-free form the
 * scalar store uses: NaN and values at most 0 store 0, values at least 255
 * store 255, and the others round to nearest with ties to even. */
function emitVectorClamp(emitter: LlEmitter, value: string, width: number): string {
  const B = emitter.B;
  const v = `<${width} x double>`;
  const positive = B.tmp(),
    high = B.tmp(),
    shifted = B.tmp(),
    rounded = B.tmp(),
    upper = B.tmp(),
    clamped = B.tmp();
  B.line(`${positive} = fcmp ogt ${v} ${value}, ${vectorSplatLiteral("double", "0.0")}`);
  B.line(`${high} = fcmp oge ${v} ${value}, ${vectorSplatLiteral("double", "255.0")}`);
  B.line(`${shifted} = fadd ${v} ${value}, ${vectorSplatLiteral("double", "4503599627370496.0")}`);
  B.line(
    `${rounded} = fsub ${v} ${shifted}, ${vectorSplatLiteral("double", "4503599627370496.0")}`,
  );
  B.line(
    `${upper} = select <${width} x i1> ${high}, ${v} ${vectorSplatLiteral("double", "255.0")}, ${v} ${rounded}`,
  );
  B.line(`${clamped} = select <${width} x i1> ${positive}, ${v} ${upper}, ${v} zeroinitializer`);
  const out = B.tmp();
  B.line(`${out} = fptoui ${v} ${clamped} to <${width} x i32>`);
  return out;
}

/** What the lane body needs to evaluate one stored value. */
interface StoreContext {
  width: number;
  data: string;
  elem: LaneElemName;
  /** The iteration's scalar index: the pointer of a vector access. */
  scalar: string;
  /** `<W x i64>` of the iteration's indices. */
  index: string;
  /** The same indices as doubles, made on demand. */
  indexDouble: () => string;
  /** The loop invariants, evaluated once before the loop. */
  invariants: ReadonlyMap<IrExpr, LlValue>;
  /** Whether the element is stored from exact integers. A float element is
   * stored from the scalar body's own doubles, so the lane body skips the
   * integer form of every node. */
  integers: boolean;
}

interface LaneValue {
  /** `<W x i64>`: the exact integer the node computes, when every operand
   * is an exact integer. */
  int: string | null;
  /** `<W x double>`: the same node as the scalar loop computes it. */
  dbl: () => string;
}

function once(emit: () => string): () => string {
  let value: string | null = null;
  return () => (value ??= emit());
}

/** An exact integer as `<W x i64>` lanes. An i32 integer widens with its sign,
 * which the element store never sees past the low bits and the entry bounds
 * keep in range; i64 integers are already lanes. */
function integerLanes(
  emitter: LlEmitter,
  integer: { type: "i32" | "i64"; name: string },
  width: number,
): string {
  const lanes = splatValue(emitter, integer.type, integer.name, width);
  if (integer.type === "i64") return lanes;
  const wide = emitter.B.tmp();
  emitter.B.line(`${wide} = sext <${width} x i32> ${lanes} to <${width} x i64>`);
  return wide;
}

/** One node of the stored value as lanes: the scalar loop's operations,
 * applied to `<W x double>` or `<W x i64>` instead of doubles and integers. */
function laneNodeValue(emitter: LlEmitter, node: LaneValueNode, ctx: StoreContext): LaneValue {
  const B = emitter.B;
  const { width } = ctx;
  if (node.op === null) {
    if (node.role === "induction")
      return { int: ctx.integers ? ctx.index : null, dbl: ctx.indexDouble };
    if (node.role === "element")
      return { int: null, dbl: once(() => emitElementLanes(emitter, ctx)) };
    const value = ctx.invariants.get(node.expr!)!;
    const integer = ctx.integers ? invariantInteger(node.expr!, value) : null;
    return {
      int: integer === null ? null : integerLanes(emitter, integer, width),
      dbl: once(() => splatValue(emitter, "double", value.name, width)),
    };
  }
  const left = laneNodeValue(emitter, node.left!, ctx);
  const right = laneNodeValue(emitter, node.right!, ctx);
  if (node.op === "*") {
    // The double form is what a float element stores. An integer element
    // stores the exact product when both operands are exact integers: the
    // entry bound keeps it below 2^62, inside i64.
    let product: string | null = null;
    if (left.int !== null && right.int !== null) {
      product = B.tmp();
      B.line(`${product} = mul nsw <${width} x i64> ${left.int}, ${right.int}`);
    }
    return {
      int: product,
      dbl: once(() => {
        const value = B.tmp();
        B.line(`${value} = fmul <${width} x double> ${left.dbl()}, ${right.dbl()}`);
        return value;
      }),
    };
  }
  if (left.int !== null && right.int !== null) {
    const result = B.tmp();
    B.line(
      `${result} = ${node.op === "+" ? "add" : "sub"} nsw <${width} x i64> ${left.int}, ${right.int}`,
    );
    return {
      int: result,
      dbl: once(() => {
        const exact = B.tmp();
        B.line(`${exact} = sitofp <${width} x i64> ${result} to <${width} x double>`);
        return exact;
      }),
    };
  }
  const result = B.tmp();
  B.line(
    `${result} = ${node.op === "+" ? "fadd" : "fsub"} <${width} x double> ${left.dbl()}, ${right.dbl()}`,
  );
  return { int: null, dbl: () => result };
}

/** `receiver[induction]` as `<W x double>`, through the element conversion
 * the scalar read uses (widen to i32, then convert to double). */
function emitElementLanes(emitter: LlEmitter, ctx: StoreContext): string {
  const B = emitter.B;
  const { width, data } = ctx;
  const info = storeElem(ctx.elem)!;
  const at = B.tmp(),
    raw = B.tmp();
  B.line(
    `${at} = getelementptr inbounds ${info.type}, ptr ${data}, ${emitter.sizeType} ${ctx.scalar}`,
  );
  B.line(`${raw} = load <${width} x ${info.type}>, ptr ${at}, align 1`);
  if (info.type === "double") return raw;
  if (info.type === "float") {
    const wide = B.tmp();
    B.line(`${wide} = fpext <${width} x float> ${raw} to <${width} x double>`);
    return wide;
  }
  const wide = info.type === "i32" ? raw : B.tmp();
  if (info.type !== "i32")
    B.line(
      `${wide} = ${info.signed ? "sext" : "zext"} <${width} x ${info.type}> ${raw} to <${width} x i32>`,
    );
  const out = B.tmp();
  B.line(
    `${out} = ${info.signed ? "sitofp" : "uitofp"} <${width} x i32> ${wide} to <${width} x double>`,
  );
  return out;
}

/** Every invariant expression in a stored value. */
function storeInvariants(node: LaneValueNode, out: IrExpr[]): void {
  if (node.left !== null) storeInvariants(node.left, out);
  if (node.right !== null) storeInvariants(node.right, out);
  if (node.role === "invariant" && node.expr !== null) out.push(node.expr);
}

/** Whether a stored value reads the element or the induction. */
function storeReads(node: LaneValueNode, role: LaneValueNode["role"]): boolean {
  if (node.role === role) return true;
  return (
    (node.left !== null && storeReads(node.left, role)) ||
    (node.right !== null && storeReads(node.right, role))
  );
}

/** A scalar double that no lane of the stored value exceeds in magnitude,
 * computed with each operand at its own largest: the element at the widest
 * value its type holds, an invariant at its magnitude, the counter at the
 * array's length. Every operation is monotone and the lanes apply the same
 * operations to smaller operands, so rounding the bound can only overstate
 * the lanes. A NaN anywhere leaves the bound a NaN, which fails the test. */
function emitValueBound(
  emitter: LlEmitter,
  node: LaneValueNode,
  invariants: Map<IrExpr, LlValue>,
  elementMax: number,
  length: string,
): string {
  const B = emitter.B;
  if (node.op === null) {
    if (node.role === "induction") {
      const count = B.tmp();
      B.line(`${count} = uitofp ${emitter.sizeType} ${length} to double`);
      return count;
    }
    if (node.role === "element") return `${elementMax}.0`;
    const value = invariants.get(node.expr!)!;
    const positive = B.tmp(),
      negative = B.tmp(),
      magnitude = B.tmp();
    B.line(`${positive} = fcmp oge double ${value.name}, 0.0`);
    B.line(`${negative} = fneg double ${value.name}`);
    B.line(`${magnitude} = select i1 ${positive}, double ${value.name}, double ${negative}`);
    return magnitude;
  }
  const left = emitValueBound(emitter, node.left!, invariants, elementMax, length);
  const right = emitValueBound(emitter, node.right!, invariants, elementMax, length);
  const combined = B.tmp();
  B.line(`${combined} = ${node.op === "*" ? "fmul" : "fadd"} double ${left}, ${right}`);
  return combined;
}

/** Emits a store loop for `plan`: whole vectors of the array are written
 * from lane values, and the loop's own copies write what the lanes left.
 *
 * Every lane computes the value with the operations the scalar body uses,
 * on the same operands, so the stored bits are the scalar loop's. Entry
 * tests keep that true where the lanes take a different route than the
 * scalar body: the exact integer the integer lanes compute must stay below
 * 2^53 in magnitude, an element times an exact integer must keep every
 * product it meets exact, and a value converted straight to ToUint32 must
 * stay below 2^63. All are loop-invariant, so the scalar remainder still
 * answers with its own bytes whenever they fail. */
function emitLaneStore(
  emitter: LlEmitter,
  plan: LaneStorePlan,
  receiver: Parameters<LlEmitter["emitStableReceiver"]>[0],
  inductionSlot: string,
  cont: string,
): void {
  const B = emitter.B;
  const width = LANES.of(emitter).width;
  const info = storeElem(plan.elem);
  if (info === null) throw new Error(`lane store on a ${plan.elem} element`);
  const invariants = new Map<IrExpr, LlValue>();
  const exprs: IrExpr[] = [];
  storeInvariants(plan.value, exprs);
  for (const expr of exprs) if (!invariants.has(expr)) invariants.set(expr, emitter.emitExpr(expr));
  const exact = [...invariants.entries()].flatMap(([expr, value]) => {
    const integer = invariantInteger(expr, value);
    return integer === null ? [] : [{ name: value.name, integer }];
  });
  const usesElement = storeReads(plan.value, "element");
  const size = emitter.sizeType;
  // Entry tests beyond the shared guard, each a loop-invariant condition on
  // the values the scalar body is about to read.
  const tests: ((entry: LaneEntry) => void)[] = [];
  const magnitude = (name: string, range: IntegerRange, limit: number): void => {
    if (range.min > -limit && range.max < limit) return;
    tests.push((entry) => {
      const low = B.tmp(),
        high = B.tmp();
      B.line(`${low} = fcmp ogt double ${name}, ${-limit}.0`);
      B.line(`${high} = fcmp olt double ${name}, ${limit}.0`);
      entry.tighten(low);
      entry.tighten(high);
    });
  };
  // An integer element is stored from the exact integer the scalar body
  // computes when every operand is an exact integer; the value is then
  // ToUint32's low bits, which the integer route truncates directly. A
  // float element is always stored from the scalar body's own doubles: the
  // lane body applies the same operations to the same operands, so its
  // result is bit-identical and needs no test.
  let int = false;
  if (!info.float) {
    if (!usesElement && exact.length === invariants.size) {
      // The integer route stores the low bits of the exact integer its lane
      // arithmetic produces. Those are the scalar body's bytes only while
      // the value stays below 2^53 in magnitude: below it every integer is
      // its own double, so the scalar body's double form stores the same
      // bits, and above it the double rounds and its low bits differ. A
      // clamped element rounds and clamps the double, so it needs no test.
      int = true;
      if (!info.clamped)
        tests.push((entry) => {
          const limit = emitValueBound(emitter, plan.value, invariants, info.max, entry.length);
          const within = B.tmp();
          B.line(`${within} = fcmp olt double ${limit}, 9007199254740992.0`);
          entry.tighten(within);
        });
    } else if (exact.length > 0 && usesElement) {
      // An element operand and an exact integer in one operation: the scalar
      // body may have done the operation on the integers. Below 2^53 the
      // double form stores the same bits.
      const limit = Math.floor(plan.value.op === "*" ? 2 ** 53 / info.max : 2 ** 53 - info.max);
      for (const value of exact) magnitude(value.name, value.integer.range, limit);
    }
    if (!int && !info.clamped) {
      // The lanes that are not exact integers take ToUint32's direct
      // conversion, which is exact below 2^63. The entry test asks whether
      // the value's own magnitude, with every operand at its largest, stays
      // there; loops that can leave it keep their scalar form.
      tests.push((entry) => {
        const limit = emitValueBound(emitter, plan.value, invariants, info.max, entry.length);
        const inside = B.tmp();
        B.line(`${inside} = fcmp olt double ${limit}, 9223372036854775808.0`);
        entry.tighten(inside);
      });
    }
  }
  const entry = emitLaneEntry(emitter, plan, receiver, inductionSlot);
  const steps = laneIndices(emitter, width);
  const header = B.newLabel("lane.c"),
    body = B.newLabel("lane.b"),
    exit = B.newLabel("lane.x");
  // The shape's own tests are computed only where the shared guard holds, so
  // a build with the toggle off pays the toggle load and the guard's branch,
  // not the bounds, for every loop it keeps scalar.
  if (tests.length === 0) B.condBr(entry.ok, header, cont);
  else {
    const test = B.newLabel("lane.t");
    B.condBr(entry.base, test, cont);
    B.startBlock(test);
    for (const run of tests) run(entry);
    B.condBr(entry.ok, header, cont);
  }
  B.startBlock(header);
  const index = B.tmp(),
    more = B.tmp();
  B.line(`${index} = load ${size}, ptr ${inductionSlot}`);
  B.line(`${more} = icmp ult ${size} ${index}, ${entry.limit}`);
  B.condBr(more, body, exit);
  B.startBlock(body);
  const indices = B.tmp();
  B.line(`${indices} = add <${width} x i64> ${steps}, ${splatValue(emitter, "i64", index, width)}`);
  const ctx: StoreContext = {
    width,
    data: entry.data,
    elem: plan.elem,
    scalar: index,
    index: indices,
    indexDouble: once(() => {
      const doubles = B.tmp();
      B.line(`${doubles} = sitofp <${width} x i64> ${indices} to <${width} x double>`);
      return doubles;
    }),
    invariants,
    integers: !info.float,
  };
  const value = laneNodeValue(emitter, plan.value, ctx);
  const at = B.tmp();
  B.line(`${at} = getelementptr inbounds ${info.type}, ptr ${entry.data}, ${size} ${index}`);
  const type = info.type;
  const exactInteger = int ? value.int : null;
  let stored: string;
  if (info.float) {
    const doubles = value.dbl();
    if (type === "float") {
      stored = B.tmp();
      B.line(`${stored} = fptrunc <${width} x double> ${doubles} to <${width} x float>`);
    } else stored = doubles;
  } else if (info.clamped) {
    // Rounding and clamping are the scalar body's own double operations.
    const bits = emitVectorClamp(emitter, value.dbl(), width);
    stored = B.tmp();
    B.line(`${stored} = trunc <${width} x i32> ${bits} to <${width} x i8>`);
  } else {
    // Every element type is at most 32 bits wide, so the value is ToUint32
    // of the scalar body's number, as emitBytesSet stores it.
    const from = exactInteger === null ? "i32" : "i64";
    const bits =
      exactInteger === null ? emitVectorToUint32(emitter, value.dbl(), width) : exactInteger;
    if (type === from) stored = bits;
    else {
      stored = B.tmp();
      B.line(`${stored} = trunc <${width} x ${from}> ${bits} to <${width} x ${type}>`);
    }
  }
  B.line(`store <${width} x ${type}> ${stored}, ptr ${at}, align 1`);
  const next = B.tmp();
  B.line(`${next} = add nuw ${size} ${index}, ${width}`);
  B.line(`store ${size} ${next}, ptr ${inductionSlot}`);
  B.br(header);
  B.startBlock(exit);
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
