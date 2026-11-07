/* Lane plans.
 *
 * A lane plan is the loop emitter's permission to run several consecutive
 * iterations of one `for` loop in vector registers. This file recognizes
 * the `elementwise` shapes and records the facts the emitter needs; it does
 * not emit anything, and it leaves the IR alone (a plan is a side table
 * keyed by the loop statement, like the contracts).
 *
 * The shapes read a typed array or a dense `number[]` at the induction
 * variable:
 *
 *   for (let i = 0; i < a.length; i++) total += a[i]!;              // sum
 *   for (let i = 0; i < a.length; i++) if (a[i]! >= n) count++;     // count
 *   for (let i = 0; i < a.length; i++) a[i] = a[i]! * 2;            // store
 *
 * Sums and counts are order-free when every partial sum is an integer below
 * 2^53: a sum of integer elements is exact in any order below that bound,
 * and a count is at most the length. The sum's bound is checked at the loop
 * entry by the emitter (`lengthBound`), because it depends on the element
 * type. A store is order-free because it writes element `i` from element `i`
 * of the same iteration, so lanes never move a value across an iteration.
 *
 * A dense array's slots hold either exact int32s (which are never -0) or
 * doubles, decided per array at run time; a plan lanes the int32 storage for
 * a sum or count and the double storage for a store, and the emitter tests
 * the storage kind at the loop entry.
 *
 * A loop qualifies when:
 * - it is the canonical loop the integer matchers recognize (typed arrays:
 *   `matchIntegerBytesForLoop`, dense arrays: `matchIntegerArrayForLoop`),
 *   the receiver is never assigned in the body, and its elements are
 *   integers narrower than f64 or, for a store, doubles;
 * - the body is exactly one of the shapes above, reading `receiver[i]` and
 *   writing the accumulator or the element;
 * - for a sum or count the accumulator is a mutable unboxed `f64` local
 *   declared as the literal 0, and it holds exactly +0 wherever the loop is
 *   entered. Those facts, which `entryIsZero` checks, are what the exactness
 *   argument needs: the loop's partial sums then start from +0 and stay
 *   inside the bound on their own.
 *
 * Everything else keeps its scalar form. */

import {
  type IrBytesElem,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
} from "./ir.js";
import { matchIntegerArrayForLoop, matchIntegerBytesForLoop } from "./integer-loops.js";
import { everyExpr, everyStmt } from "./traverse.js";

/** The shapes this file recognizes. `SCRIPTC_LANES_PLAN` names them. */
export type LaneShape = "sum" | "count" | "store" | "outer";

export const LANE_SHAPES: readonly LaneShape[] = ["sum", "count", "store", "outer"];

/** The operator of the count shape's element test. */
export type LaneCompareOp = "<" | "<=" | ">" | ">=" | "===" | "!==";

/** Where a plan's elements live: a typed array's bytes, or the dense storage
 * of a `number[]`. */
export type LaneContainer = "bytes" | "array";

/** The element a plan reads or writes: a typed array's element kind, or a
 * dense number array's slot (`i32slot` for int32 storage, `f64slot` for
 * doubles). The dense slot kinds are decided per array at run time, so a
 * dense plan checks the storage it was planned for at the loop entry. */
export type LaneElemName = IrBytesElem | "i32slot" | "f64slot";

/** An integer typed-array element a lane loop may read. */
export interface LaneElem {
  /** The LLVM integer the element loads as. */
  type: "i8" | "i16" | "i32";
  bits: number;
  signed: boolean;
  /** The largest `|value|` a lane can hold. */
  max: number;
}

const LANE_ELEMS: ReadonlyMap<LaneElemName, LaneElem> = new Map<LaneElemName, LaneElem>([
  ["u8", { type: "i8", bits: 8, signed: false, max: 255 }],
  // A clamped array reads like a byte array; only its stores clamp.
  ["u8c", { type: "i8", bits: 8, signed: false, max: 255 }],
  ["i8", { type: "i8", bits: 8, signed: true, max: 128 }],
  ["u16", { type: "i16", bits: 16, signed: false, max: 65535 }],
  ["i16", { type: "i16", bits: 16, signed: true, max: 32768 }],
  ["u32", { type: "i32", bits: 32, signed: false, max: 4294967295 }],
  ["i32", { type: "i32", bits: 32, signed: true, max: 2147483648 }],
  // A dense number array's int32 slots hold exact int32s and never -0, so a
  // sum of them is the sum of the integers the scalar loop adds.
  ["i32slot", { type: "i32", bits: 32, signed: true, max: 2147483648 }],
]);

/** The element an integer typed array loads as, or null for a float or an
 * unknown element. */
export function laneElem(elem: LaneElemName): LaneElem | null {
  return LANE_ELEMS.get(elem) ?? null;
}

/** The largest element count whose sum of `elem` elements stays below 2^53
 * in magnitude: 2^21 for u32, 2^22 for i32, 2^45 for u8, and so on. */
function sumLengthBound(elem: LaneElem): number {
  return 2 ** (53 - elem.bits + (elem.signed ? 1 : 0));
}

export interface LaneSumPlan {
  shape: "sum";
  /** The loop's induction local; the receiver is indexed at it. */
  induction: string;
  receiver: string;
  container: LaneContainer;
  elem: LaneElemName;
  accumulator: string;
  /** Exclusive bound on the element count. */
  lengthBound: number;
}

export interface LaneCountPlan {
  shape: "count";
  induction: string;
  receiver: string;
  container: LaneContainer;
  elem: LaneElemName;
  accumulator: string;
  /** The element test. `limit` is loop-invariant, which `invariantLimit`
   * checks against the loop's own statements, so the emitter evaluates it
   * once at the entry and compares lanes against an integer splat. */
  compare: { op: LaneCompareOp; limit: IrExpr };
}

/** One node of a stored value's lane form: a leaf, or an arithmetic node
 * over two nodes. The emitter transcribes the tree lane by lane, so every
 * node records where its operands come from. */
export interface LaneValueNode {
  /** An `invariant` is the same on every iteration; an `induction` is the
   * counter; an `element` is `receiver[induction]`. */
  role: "invariant" | "induction" | "element";
  /** The invariant or element-read expression; null for the induction. */
  expr: IrExpr | null;
  op: "+" | "-" | "*" | null;
  left: LaneValueNode | null;
  right: LaneValueNode | null;
}

export interface LaneStorePlan {
  shape: "store";
  induction: string;
  receiver: string;
  container: LaneContainer;
  elem: LaneElemName;
  /** The stored value. Its leaves are the induction, loop invariants whose
   * cells the loop never writes, and element reads at the induction. */
  value: LaneValueNode;
}

export type LanePlan = LaneSumPlan | LaneCountPlan | LaneStorePlan | LaneOuterPlan;

/* ---- Outer plans ----
 *
 * An `outer` plan lets several consecutive iterations of an outer `for` loop
 * be the lanes of one vector loop, each running its own inner loop to its
 * own exit:
 *
 *   for (let x = 0; x < size; x++) {
 *     const c = new Complex((x / size) * 3 - 2, cy);
 *     let z = new Complex(0, 0);
 *     let n = 0;
 *     while (n < limit && z.norm() <= 4) {   // the masked inner loop
 *       z = z.times(z).plus(c);
 *       n++;
 *     }
 *     if (n === limit) inside++;             // one count per lane
 *   }
 *
 * The lanes hold the outer body's own locals: one vector per carried number,
 * and one per field of a class instance whose fields are all numbers. The
 * instance's methods are inlined into lane arithmetic, so a lane never
 * allocates and never calls. The inner loop becomes a masked loop: a lane
 * whose test is false keeps its state until the group's loop ends, its work
 * is thrown away by the select, and the effect the lane would have had after
 * the loop (`inside++`) is counted once per lane at the end.
 *
 * The shape is refused unless the whole outer body is made of it: pure
 * declarations, one inner `while` over the carried values, and a tail of
 * counted effects. That is what makes the masking argument sound: nothing in
 * the body can observe an extra iteration, and nothing can observe that the
 * three instances the body creates per iteration were never allocated.
 *
 * Only a `for` loop with a unit step whose counter is an ordinary number
 * local is planned; loops the integer matchers took keep their scalar form,
 * because their counter lives in an integer slot the lane body does not
 * write. */

/** A lane-evaluated number: how the emitter builds its `<W x f64>` vector. */
export type LaneNum =
  /** A literal, splatted. */
  | { kind: "const"; value: number }
  /** An expression the outer loop never writes, evaluated once per group
   * and splatted. */
  | { kind: "invariant"; expr: IrExpr }
  /** The outer loop's counter: lane k sees the counter's value plus k. */
  | { kind: "induction" }
  /** One carried value: a number local (`field` null) or one field of a
   * class instance. */
  | { kind: "state"; id: string; field: string | null }
  | { kind: "op"; op: "+" | "-" | "*" | "/"; left: LaneNum; right: LaneNum }
  | { kind: "neg"; operand: LaneNum };

/** A value the outer body carries: a number, or a class instance whose
 * fields are all numbers. */
export type LaneValue =
  | { kind: "num"; num: LaneNum }
  | { kind: "obj"; className: string; fields: ReadonlyMap<string, LaneNum> };

/** The relational operators a lane test may hold. */
export type LaneCompare = "<" | "<=" | ">" | ">=" | "===" | "!==";

/** The test the masked loop and the tail evaluate. */
export type LaneCond =
  | { kind: "const"; value: boolean }
  | { kind: "not"; operand: LaneCond }
  | { kind: "and"; left: LaneCond; right: LaneCond }
  | { kind: "or"; left: LaneCond; right: LaneCond }
  | { kind: "cmp"; op: LaneCompare; left: LaneNum; right: LaneNum };

/** One vector slot of the lane body, and the value it takes. `group` is the
 * statement that produced it: the values of one group are all computed
 * before any of them is stored, which is the statement's own order. */
export interface LaneOuterSlot {
  id: string;
  field: string | null;
  group: number;
  value: LaneNum;
}

export interface LaneOuterPlan {
  shape: "outer";
  /** The outer loop's counter local. */
  induction: string;
  /** The counter's exclusive bound: a value outside the outer body. */
  bound: IrExpr;
  /** The per-lane values the body's declarations start from. */
  initial: LaneOuterSlot[];
  /** The inner loop's continuation test. */
  cond: LaneCond;
  /** The inner loop's assignments, in source order. */
  steps: LaneOuterSlot[];
  /** The statement after the inner loop, when it is a counted effect:
   * `acc++` once per lane whose test holds. */
  tail: { accumulator: string; test: LaneCond } | null;
}

/** The most nodes an inlined method body may add to a plan. */
const OUTER_MAX_NODES = 512;

/** A class the lane body can hold as its fields: no base class, every field
 * a number, and instances that capture nothing. */
function numericClass(cls: IrClassDef | undefined): cls is IrClassDef {
  return (
    cls !== undefined &&
    cls.base === undefined &&
    cls.localCaptures === undefined &&
    cls.baseValueGlobal === undefined &&
    cls.fields.length > 0 &&
    cls.fields.every((field) => field.type.kind === "f64")
  );
}

/** What the outer plan evaluator needs to read one body. */
interface OuterCtx {
  induction: string;
  /** The outer loop, for the write test that makes a read invariant. */
  loop: IrStmt;
  locals: ReadonlyMap<string, IrLocal>;
  classes: ReadonlyMap<string, IrClassDef>;
  functions: ReadonlyMap<string, IrFunction>;
  /** The values bound in the function whose body is being evaluated. */
  frame: Map<string, LaneValue>;
  /** Nodes the inlined bodies may still add. */
  nodes: { left: number; used: number };
}

/** The value of `e` in the lane body, or null when the lane form cannot
 * hold it. */
function outerValue(e: IrExpr, ctx: OuterCtx): LaneValue | null {
  if (e.kind === "new") return outerNew(e.className, e.args, ctx);
  if (e.kind === "call") return outerCall(e.callee, e.args, ctx);
  // A carried value is the value the frame holds, number or instance.
  if (e.kind === "varRef") {
    const held = ctx.frame.get(e.localId);
    if (held !== undefined) return held;
  }
  if (e.kind === "fieldGet") {
    const obj = outerValue(e.obj, ctx);
    if (obj === null || obj.kind !== "obj") return null;
    const field = obj.fields.get(e.field);
    return field === undefined ? null : { kind: "num", num: field };
  }
  const num = outerNum(e, ctx);
  return num === null ? null : { kind: "num", num };
}

/** The number a lane evaluation of `e` holds, or null. */
function outerNum(e: IrExpr, ctx: OuterCtx): LaneNum | null {
  // A field read, an instance or a call is a number when the lane form of
  // the value they build is one: `z.norm()` is arithmetic over `z`'s fields.
  if (e.kind === "fieldGet" || e.kind === "new" || e.kind === "call") {
    const held = outerValue(e, ctx);
    return held !== null && held.kind === "num" ? held.num : null;
  }
  switch (e.kind) {
    case "numLit":
      return Number.isFinite(e.value) && !Object.is(e.value, -0)
        ? { kind: "const", value: e.value }
        : null;
    case "varRef": {
      const held = ctx.frame.get(e.localId);
      if (held !== undefined) return held.kind === "num" ? held.num : null;
      if (e.localId === ctx.induction) return { kind: "induction" };
      if (e.type.kind !== "f64") return null;
      // An invariant: the outer loop's own body never writes it, so its
      // value at the group's entry is its value on every lane.
      if (writesLocal(ctx.loop, e.localId)) return null;
      if (!ctx.locals.has(e.localId) && !e.localId.startsWith("%g.")) return null;
      return { kind: "invariant", expr: e };
    }
    case "bin": {
      if (e.op !== "+" && e.op !== "-" && e.op !== "*" && e.op !== "/") return null;
      const left = outerNum(e.left, ctx);
      const right = left === null ? null : outerNum(e.right, ctx);
      return left === null || right === null ? null : { kind: "op", op: e.op, left, right };
    }
    case "unary": {
      if (e.op !== "-") return null;
      const operand = outerNum(e.operand, ctx);
      return operand === null ? null : { kind: "neg", operand };
    }
    default:
      return null;
  }
}

/** The lane form of `new C(args)`: the class's fields after its constructor
 * ran, which the constructor's own field writes give. */
function outerNew(className: string, args: readonly IrExpr[], ctx: OuterCtx): LaneValue | null {
  const cls = ctx.classes.get(className);
  if (!numericClass(cls)) return null;
  const fields = new Map<string, LaneNum>();
  for (const field of cls.fields) fields.set(field.name, { kind: "const", value: 0 });
  const ctor = ctx.functions.get(`%${className}.constructor`);
  if (ctor === undefined) return args.length === 0 ? { kind: "obj", className, fields } : null;
  if (ctor.params.length !== args.length + 1) return null;
  if (!inlinable(ctor)) return null;
  const frame = new Map<string, LaneValue>();
  for (let i = 0; i < args.length; i++) {
    const value = outerValue(args[i]!, ctx);
    if (value === null) return null;
    frame.set(ctor.params[i + 1]!.localId, value);
  }
  const self = ctor.params[0]!.localId;
  for (const s of ctor.body) {
    if (s.kind !== "fieldSet" || s.className !== className) return null;
    if (s.obj.kind !== "varRef" || s.obj.localId !== self) return null;
    if (!fields.has(s.field)) return null;
    const value = outerNum(s.value, { ...ctx, frame });
    if (value === null) return null;
    fields.set(s.field, value);
  }
  return { kind: "obj", className, fields };
}

/** Whether a callee may be read into a plan: a plain synchronous function
 * that captures nothing. */
function inlinable(fn: IrFunction): boolean {
  return (
    !fn.async &&
    !fn.generator &&
    (fn.captures === undefined || fn.captures.length === 0) &&
    (fn.classCaptures === undefined || fn.classCaptures.length === 0)
  );
}

/** The lane form of a call: the callee's single `return` evaluated with the
 * arguments bound to its parameters. A method's receiver is its first
 * argument, so an instance's fields arrive as the `this` value. */
function outerCall(callee: string, args: readonly IrExpr[], ctx: OuterCtx): LaneValue | null {
  const fn = ctx.functions.get(callee);
  if (fn === undefined || !inlinable(fn) || fn.params.length !== args.length) return null;
  // A single `return`: anything else could write, call or throw, none of
  // which a lane body does.
  if (fn.body.length !== 1) return null;
  const only = fn.body[0]!;
  if (only.kind !== "return" || only.value === null) return null;
  if (++ctx.nodes.used > ctx.nodes.left) return null;
  const frame = new Map<string, LaneValue>();
  for (let i = 0; i < args.length; i++) {
    const value = outerValue(args[i]!, ctx);
    if (value === null) return null;
    frame.set(fn.params[i]!.localId, value);
  }
  return outerValue(only.value, { ...ctx, frame });
}

/** The lane test of a condition, or null. Both operands are pure, so the
 * lanes may evaluate the whole tree where the scalar code stops at the first
 * false one. */
function outerCond(e: IrExpr, ctx: OuterCtx): LaneCond | null {
  switch (e.kind) {
    case "boolLit":
      return { kind: "const", value: e.value };
    case "logical": {
      const left = outerCond(e.left, ctx);
      const right = left === null ? null : outerCond(e.right, ctx);
      if (left === null || right === null) return null;
      return { kind: e.op === "&&" ? "and" : "or", left, right };
    }
    case "unary": {
      if (e.op !== "!") return null;
      const operand = outerCond(e.operand, ctx);
      return operand === null ? null : { kind: "not", operand };
    }
    case "bin": {
      if (!RELATIONAL.has(e.op)) return null;
      const left = outerNum(e.left, ctx);
      const right = left === null ? null : outerNum(e.right, ctx);
      return left === null || right === null
        ? null
        : { kind: "cmp", op: e.op as LaneCompare, left, right };
    }
    default:
      return null;
  }
}

/** The slots one statement's value takes: a number local is one, a class
 * instance is one per field. All of them carry the statement's group. */
function flattenValue(value: LaneValue, id: string, group: number): LaneOuterSlot[] | null {
  if (value.kind === "num") return [{ id, field: null, group, value: value.num }];
  const slots: LaneOuterSlot[] = [];
  for (const [field, num] of value.fields) slots.push({ id, field, group, value: num });
  return slots.length === 0 ? null : slots;
}

/** The frame value that reads a local back from its slots instead of carrying
 * the expression that computed it. */
function slotState(id: string, value: LaneValue): LaneValue {
  if (value.kind === "num") return { kind: "num", num: { kind: "state", id, field: null } };
  const fields = new Map<string, LaneNum>();
  for (const field of value.fields.keys()) fields.set(field, { kind: "state", id, field });
  return { kind: "obj", className: value.className, fields };
}

/** The counter and bound of a `for` loop whose counter is an ordinary
 * number local stepped by one, or null. */
function outerCounter(stmt: IrStmt & { kind: "for" }): { id: string; bound: IrExpr } | null {
  const init = stmt.init;
  if (init === null || init.kind !== "varDecl" || init.init === null) return null;
  const id = init.localId;
  const cond = stmt.cond;
  if (
    cond === null ||
    cond.kind !== "bin" ||
    cond.op !== "<" ||
    cond.left.kind !== "varRef" ||
    cond.left.localId !== id
  )
    return null;
  const update = stmt.update;
  if (update === null || update.kind !== "assign" || update.localId !== id) return null;
  const value = update.value;
  const step = value.kind === "bin" ? value.right : null;
  if (
    value.kind !== "bin" ||
    value.op !== "+" ||
    value.left.kind !== "varRef" ||
    value.left.localId !== id ||
    step === null ||
    step.kind !== "numLit" ||
    step.value !== 1 ||
    Object.is(step.value, -0)
  )
    return null;
  // The bound is read once for a whole group, before the lanes run, so it
  // must be a value the body cannot change and whose evaluation has no
  // effect of its own.
  const bound = cond.right;
  const pure =
    bound.kind === "numLit" ||
    (bound.kind === "varRef" && bound.type.kind === "f64" && !writesLocal(stmt, bound.localId));
  return pure ? { id, bound } : null;
}

/** `acc = acc + 1`, with `acc` a number local. */
function incrementOf(stmt: IrStmt): string | null {
  if (stmt.kind !== "assign" || stmt.value.kind !== "bin" || stmt.value.op !== "+") return null;
  const { left, right } = stmt.value;
  const isSelf = (e: IrExpr): boolean => e.kind === "varRef" && e.localId === stmt.localId;
  const isOne = (e: IrExpr): boolean =>
    e.kind === "numLit" && e.value === 1 && !Object.is(e.value, -0);
  if (!((isSelf(left) && isOne(right)) || (isSelf(right) && isOne(left)))) return null;
  return stmt.localId;
}

/** Whether any statement in `list` writes `id`. */
function listWrites(list: readonly IrStmt[], id: string): boolean {
  return list.some((s) => writesLocal(s, id));
}

/** The outer plan for one loop, or null. */
function outerPlan(
  stmt: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
  classes: ReadonlyMap<string, IrClassDef>,
  functions: ReadonlyMap<string, IrFunction>,
): LaneOuterPlan | null {
  const counter = outerCounter(stmt);
  if (counter === null) return null;
  const body = flatBody(stmt.body);
  let innerAt = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind !== "while") continue;
    if (innerAt >= 0) return null;
    innerAt = i;
  }
  if (innerAt < 0) return null;
  const inner = body[innerAt]!;
  if (inner.kind !== "while") return null;
  const ctx: OuterCtx = {
    induction: counter.id,
    loop: stmt,
    locals,
    classes,
    functions,
    frame: new Map(),
    nodes: { left: OUTER_MAX_NODES, used: 0 },
  };
  const initial: LaneOuterSlot[] = [];
  let decl = 0;
  for (const s of body.slice(0, innerAt)) {
    if (s.kind !== "varDecl" || s.init === null) return null;
    const local = locals.get(s.localId);
    if (local === undefined || local.boxed === true || local.tdz === true) return null;
    const value = outerValue(s.init, ctx);
    if (value === null) return null;
    const slots = flattenValue(value, s.localId, decl);
    if (slots === null) return null;
    initial.push(...slots);
    // The declaration's slots are stored before the next statement's values
    // are computed, so a later initializer reads this one's slot. Keeping its
    // tree in the frame instead would inline it again at every use, and a
    // chain of declarations that reuse the previous one would then carry a
    // copy of the whole chain into the last one: exponential LLVM output from
    // a handful of rows.
    ctx.frame.set(s.localId, slotState(s.localId, value));
    decl++;
  }
  if (initial.length === 0) return null;
  // From here on a read of a carried local is a read of its slot: the
  // declarations above gave the slots their per-lane values, and the inner
  // loop's tests and assignments read what the last iteration left there.
  const state = new Map(ctx.frame);
  const cond = outerCond(inner.cond, ctx);
  if (cond === null) return null;
  const steps: LaneOuterSlot[] = [];
  let group = 0;
  for (const s of inner.body) {
    if (s.kind !== "assign") return null;
    const held = ctx.frame.get(s.localId);
    if (held === undefined) return null;
    const value = outerValue(s.value, ctx);
    if (value === null) return null;
    if (held.kind === "num") {
      if (value.kind !== "num") return null;
      steps.push({ id: s.localId, field: null, group, value: value.num });
    } else {
      if (value.kind !== "obj" || value.className !== held.className) return null;
      for (const field of held.fields.keys()) {
        const num = value.fields.get(field);
        if (num === undefined) return null;
        steps.push({ id: s.localId, field, group, value: num });
      }
    }
    // The groups store their slots in order, so a later statement reads the
    // slots the earlier groups wrote, not the trees they were built from.
    ctx.frame = new Map(state);
    group++;
  }
  if (steps.length === 0) return null;
  let tail: LaneOuterPlan["tail"] = null;
  const after = body.slice(innerAt + 1);
  if (after.length > 0) {
    if (after.length !== 1) return null;
    const s = after[0]!;
    if (s.kind !== "if" || s.else_ !== null || s.then.length !== 1) return null;
    const accumulator = incrementOf(s.then[0]!);
    if (accumulator === null) return null;
    const local = locals.get(accumulator);
    if (
      local === undefined ||
      local.type.kind !== "f64" ||
      local.boxed === true ||
      local.tdz === true ||
      ctx.frame.has(accumulator)
    )
      return null;
    // The increment is the accumulator's only writer in the body: anything
    // else would have to run before or after the lanes' own count.
    if (listWrites(body.slice(0, innerAt), accumulator) || listWrites(inner.body, accumulator))
      return null;
    // The test reads the state the inner loop left in the slots.
    ctx.frame = new Map(state);
    const test = outerCond(s.cond, ctx);
    if (test === null) return null;
    tail = { accumulator, test };
  }
  return {
    shape: "outer",
    induction: counter.id,
    bound: counter.bound,
    initial,
    cond,
    steps,
    tail,
  };
}

/** One step of the statements that enclose a loop: the list, the statement in
 * it that holds the loop, and that statement's condition when it is an `if`. */
interface PathStep {
  list: IrStmt[];
  index: number;
  cond: IrExpr | null;
}

/** A loop, with the path of statements that enclose it and the loops among
 * them. */
interface LoopSite {
  stmt: IrStmt & { kind: "for" };
  path: PathStep[];
  /** The enclosing loops, outermost first. */
  loops: IrStmt[];
}

/** The declaration of a local. */
interface DeclSite {
  stmt: IrStmt & { kind: "varDecl" };
  /** The statement list the declaration sits in. */
  list: IrStmt[];
  index: number;
  /** The loops enclosing the declaration, outermost first. */
  loops: IrStmt[];
}

function isLoop(s: IrStmt): boolean {
  return s.kind === "for" || s.kind === "forOf" || s.kind === "while" || s.kind === "doWhile";
}

/** The statement lists a statement holds. */
function heldLists(s: IrStmt): IrStmt[][] {
  switch (s.kind) {
    case "if":
      return s.else_ === null ? [s.then] : [s.then, s.else_];
    case "block":
    case "while":
    case "doWhile":
    case "for":
    case "forOf":
      return [s.body];
    case "switch":
      return s.cases.map((c) => c.body);
    case "tryCatch":
      return [
        s.tryBody,
        ...(s.catchBody === null ? [] : [s.catchBody]),
        ...(s.finallyBody === null ? [] : [s.finallyBody]),
      ];
    default:
      return [];
  }
}

/** What the whole function says about its locals and loops. */
interface FunctionFacts {
  /** The first declaration of each local. */
  decls: Map<string, DeclSite>;
  loops: LoopSite[];
}

function functionFacts(fn: IrFunction): FunctionFacts {
  const decls = new Map<string, DeclSite>();
  const loops: LoopSite[] = [];
  const walk = (list: IrStmt[], path: PathStep[], enclosing: IrStmt[]): void => {
    for (let index = 0; index < list.length; index++) {
      const s = list[index]!;
      const step: PathStep = { list, index, cond: s.kind === "if" ? s.cond : null };
      if (s.kind === "varDecl") {
        if (!decls.has(s.localId)) decls.set(s.localId, { stmt: s, list, index, loops: enclosing });
      } else if (s.kind === "for") {
        loops.push({ stmt: s, path: [...path, step], loops: enclosing });
      }
      const inner = isLoop(s) ? [...enclosing, s] : enclosing;
      for (const held of heldLists(s)) walk(held, [...path, step], inner);
    }
  };
  walk(fn.body, [], []);
  return { decls, loops };
}

/** Whether `stmt` writes `id` anywhere in its subtree: an assignment, a
 * compound assignment, an increment, a `for`-`of` binding, or a declaring
 * initializer. */
function writesLocal(stmt: IrStmt, id: string): boolean {
  let found = false;
  everyStmt(stmt, {
    expr: (e) => {
      if ((e.kind === "assignExpr" || e.kind === "incDec") && e.localId === id) found = true;
      return !found;
    },
    stmt: (s) => {
      if ((s.kind === "assign" || s.kind === "forOf") && s.localId === id) found = true;
      else if (s.kind === "varDecl" && s.init !== null && s.localId === id) found = true;
      return !found;
    },
  });
  return found;
}

const RELATIONAL: ReadonlySet<string> = new Set(["<", "<=", ">", ">=", "===", "!=="]);

/** `e` is the induction, as the index of an element access. */
function atInduction(e: IrExpr, induction: string): boolean {
  return e.kind === "varRef" && e.localId === induction;
}

/** `e` is `receiver[induction]` in a typed array. */
function bytesElementRead(e: IrExpr, receiver: string, induction: string): boolean {
  return (
    e.kind === "bytesIntrinsic" &&
    e.method === "get" &&
    e.receiver.kind === "varRef" &&
    e.receiver.localId === receiver &&
    e.args.length === 1 &&
    atInduction(e.args[0]!, induction)
  );
}

/** `e` is `receiver[induction]` in a dense `number[]`: the strict element
 * read, or the numeric read a plain `a[i]` compiles to. */
function arrayElementRead(e: IrExpr, receiver: string, induction: string): boolean {
  if (e.kind === "arrayGet")
    return e.arr.kind === "varRef" && e.arr.localId === receiver && atInduction(e.index, induction);
  return (
    e.kind === "arrIntrinsic" &&
    e.method === "getNumber" &&
    e.receiver.kind === "varRef" &&
    e.receiver.localId === receiver &&
    e.args.length === 1 &&
    atInduction(e.args[0]!, induction)
  );
}

/** `e` is `receiver[induction]` in a receiver of the plan's container. */
function elementRead(
  e: IrExpr,
  receiver: string,
  induction: string,
  container: LaneContainer,
): boolean {
  return container === "bytes"
    ? bytesElementRead(e, receiver, induction)
    : arrayElementRead(e, receiver, induction);
}

/** `acc = acc + receiver[induction]`, in either operand order. */
function matchSumBody(
  only: IrStmt,
  receiver: string,
  induction: string,
  container: LaneContainer,
): string | null {
  if (only.kind !== "assign" || only.value.kind !== "bin" || only.value.op !== "+") return null;
  const { left, right } = only.value;
  const isAcc = (e: IrExpr): boolean => e.kind === "varRef" && e.localId === only.localId;
  if (isAcc(left) && elementRead(right, receiver, induction, container)) return only.localId;
  if (isAcc(right) && elementRead(left, receiver, induction, container)) return only.localId;
  return null;
}

/** The same test with the element on the right. */
function flip(op: LaneCompareOp): LaneCompareOp {
  switch (op) {
    case "<":
      return ">";
    case "<=":
      return ">=";
    case ">":
      return "<";
    case ">=":
      return "<=";
    default:
      return op;
  }
}

/** `if (receiver[induction] <op> limit) acc++;`, with no else branch and an
 * accumulator written as `acc + 1`. */
function matchCountBody(
  only: IrStmt,
  receiver: string,
  induction: string,
  container: LaneContainer,
): { accumulator: string; compare: { op: LaneCompareOp; limit: IrExpr } } | null {
  if (only.kind !== "if" || only.else_ !== null || only.then.length !== 1) return null;
  const inc = only.then[0]!;
  if (inc.kind !== "assign" || inc.value.kind !== "bin" || inc.value.op !== "+") return null;
  const { left, right } = inc.value;
  const isSelf = (e: IrExpr): boolean => e.kind === "varRef" && e.localId === inc.localId;
  const isOne = (e: IrExpr): boolean => e.kind === "numLit" && e.value === 1;
  if (!((isSelf(left) && isOne(right)) || (isSelf(right) && isOne(left)))) return null;
  const cond = only.cond;
  if (cond.kind !== "bin" || !RELATIONAL.has(cond.op)) return null;
  const op = cond.op as LaneCompareOp;
  if (elementRead(cond.left, receiver, induction, container))
    return { accumulator: inc.localId, compare: { op, limit: cond.right } };
  if (elementRead(cond.right, receiver, induction, container))
    return { accumulator: inc.localId, compare: { op: flip(op), limit: cond.left } };
  return null;
}

/** The limit test's operand: a value the lane entry can evaluate once. The
 * entry evaluates it before the loop, so it must be the same on every
 * iteration: a literal, or a number local the loop itself never writes. That
 * rules out the counter and the accumulator, which the entry would freeze at
 * their starting values. */
function invariantLimit(e: IrExpr, loop: IrStmt, induction: string): boolean {
  if (e.kind === "numLit") return true;
  return (
    e.kind === "varRef" &&
    e.type.kind === "f64" &&
    e.localId !== induction &&
    !writesLocal(loop, e.localId)
  );
}

/** The stored value of one elementwise store loop. */
interface StoreBody {
  receiver: string;
  value: IrExpr;
}

/** The statements of a body without the blocks that only group them. A
 * versioned union arm loop folds its tag test into a block, and the store
 * arrives inside one, so the shape is read through them. */
function flatBody(body: IrStmt[]): IrStmt[] {
  const out: IrStmt[] = [];
  for (const s of body) {
    if (s.kind === "block") out.push(...flatBody(s.body));
    else out.push(s);
  }
  return out;
}

/** `receiver[induction] = value`, with the value maybe bound to one temp
 * first, which is how an elementwise store reaches the IR. The loop body
 * holds nothing else, so the store is its only effect. */
function matchStoreBody(body: IrStmt[], induction: string): StoreBody | null {
  const list = flatBody(body);
  let set: IrStmt | undefined;
  let temp: string | null = null;
  if (list.length === 1) set = list[0];
  else if (list.length === 2 && list[0]!.kind === "varDecl" && list[0]!.init !== null) {
    temp = list[0]!.localId;
    set = list[1];
  }
  if (set === undefined) return null;
  if (set.kind !== "bytesSet" && set.kind !== "arraySet") return null;
  if (!atInduction(set.index, induction)) return null;
  if (set.kind === "bytesSet") {
    if (set.arr.kind !== "varRef" || set.arr.type.kind !== "bytes") return null;
  } else if (set.arr.kind !== "varRef" || set.arr.type.kind !== "array") return null;
  let value = set.value;
  if (temp !== null) {
    if (value.kind !== "varRef" || value.localId !== temp) return null;
    const decl = list[0]!;
    if (decl.kind !== "varDecl" || decl.init === null) return null;
    value = decl.init;
  }
  return { receiver: set.arr.localId, value };
}

/** The lane form of a stored value, or null when the form needs work the
 * lane body does not do. The forms are a leaf (an invariant, the induction,
 * or an element read at the induction) and a sum, difference or product of
 * two of them with at least one invariant operand. Anything else — a call,
 * a bitwise operator, `Math.sqrt`, a second store — keeps the loop scalar. */
function storeValueNode(
  e: IrExpr,
  receiver: string,
  induction: string,
  container: LaneContainer,
): LaneValueNode | null {
  const leaf = (
    role: LaneValueNode["role"],
    expr: IrExpr | null,
    lhs: LaneValueNode | null = null,
    rhs: LaneValueNode | null = null,
    op: LaneValueNode["op"] = null,
  ): LaneValueNode => ({ role, expr, op, left: lhs, right: rhs });
  if (e.kind === "numLit") return leaf("invariant", e);
  if (e.kind === "varRef")
    return e.localId === induction && e.type.kind === "f64"
      ? leaf("induction", null)
      : e.type.kind === "f64"
        ? leaf("invariant", e)
        : null;
  if (elementRead(e, receiver, induction, container)) return leaf("element", e);
  if (e.kind !== "bin" || (e.op !== "+" && e.op !== "-" && e.op !== "*")) return null;
  const left = storeValueNode(e.left, receiver, induction, container);
  const right = left === null ? null : storeValueNode(e.right, receiver, induction, container);
  if (left === null || right === null) return null;
  // One operand must be loop-invariant: an element read or the induction
  // cannot stand alone beside another element-dependent node here, because
  // the lane body evaluates the tree once per vector, not per element.
  const isInvariant = (n: LaneValueNode): boolean => n.role === "invariant" && n.op === null;
  if (!isInvariant(left) && !isInvariant(right)) return null;
  return leaf("invariant", null, left, right, e.op);
}

/** Every local a node's invariants name. */
function nodeInvariants(node: LaneValueNode, out: Set<string>): void {
  if (node.left !== null) nodeInvariants(node.left, out);
  if (node.right !== null) nodeInvariants(node.right, out);
  if (node.role === "invariant" && node.expr?.kind === "varRef") out.add(node.expr.localId);
}

/** Whether the accumulator holds exactly +0 wherever this loop is entered.
 *
 * The value is +0 when the declaration runs before the loop on every way in:
 * it must be declared as the literal 0, it must be declared inside the same
 * loops as the loop (so no back edge swings past it between two entries of
 * the loop), and it must be on the loop's path with nothing in front of it
 * writing it, in the list that holds it or in a region that reaches the loop
 * without being listed there. Loop versioning rewrites one source loop into
 * several copies,
 * each in its own branch, so the declaration usually belongs to an enclosing
 * list rather than the loop's own. */
function entryIsZero(
  id: string,
  site: LoopSite,
  locals: ReadonlyMap<string, IrLocal>,
  facts: FunctionFacts,
): boolean {
  const local = locals.get(id);
  if (
    local === undefined ||
    local.type.kind !== "f64" ||
    !local.mutable ||
    local.boxed === true ||
    local.tdz === true
  )
    return false;
  const decl = facts.decls.get(id);
  if (decl === undefined) return false;
  const init = decl.stmt.init;
  if (init === null || init.kind !== "numLit" || init.value !== 0 || Object.is(init.value, -0))
    return false;
  if (decl.loops.length !== site.loops.length) return false;
  for (let i = 0; i < site.loops.length; i++) if (decl.loops[i] !== site.loops[i]) return false;
  let declared = false;
  for (const step of site.path) {
    for (let i = 0; i < step.index; i++) {
      const s = step.list[i]!;
      if (s === decl.stmt) declared = true;
      else if (writesLocal(s, id)) return false;
    }
    if (step.cond !== null && exprWrites(step.cond, id)) return false;
  }
  return declared && !earlierRegionWrites(site, id);
}

/** Whether region code that runs before the loop, but that no path step
 * lists, writes `id`. A switch case falls into the next one, so the cases
 * ahead of the loop's own run before it; a catch body runs after the try
 * body, and a finally body after both. Refusing the plan is always sound,
 * so a case that ends in `break` counts like one that falls through. */
function earlierRegionWrites(site: LoopSite, id: string): boolean {
  for (let i = 0; i < site.path.length; i++) {
    const step = site.path[i]!;
    const holder = step.list[step.index]!;
    const next = site.path[i + 1];
    const inner = next === undefined ? site.stmt.body : next.list;
    if (holder.kind === "switch") {
      if (exprWrites(holder.disc, id)) return true;
      for (const branch of holder.cases) {
        if (branch.body === inner) break;
        if (branch.body.some((s) => writesLocal(s, id))) return true;
      }
    } else if (holder.kind === "tryCatch") {
      if (holder.tryBody === inner) continue;
      if (holder.catchBody !== inner && holder.finallyBody !== inner) continue;
      if (holder.tryBody.some((s) => writesLocal(s, id))) return true;
      if (
        holder.finallyBody === inner &&
        holder.catchBody !== null &&
        holder.catchBody.some((s) => writesLocal(s, id))
      )
        return true;
    }
  }
  return false;
}

/** Whether an expression writes `id`. */
function exprWrites(e: IrExpr, id: string): boolean {
  return !everyExpr(e, {
    expr: (node) =>
      !((node.kind === "assignExpr" || node.kind === "incDec") && node.localId === id),
    stmt: () => true,
  });
}

/** The element kinds a lane store writes. A half float goes through a
 * runtime call per element, which lanes cannot make. */
const STORE_ELEMS: ReadonlySet<LaneElemName> = new Set<LaneElemName>([
  "u8",
  "u8c",
  "i8",
  "u16",
  "i16",
  "u32",
  "i32",
  "f32",
  "f64",
  // A dense number array's double slots.
  "f64slot",
]);

/** The store plan for one loop, or null. The written array is the loop's
 * limit receiver, so the counter's bound is the array's length and every
 * lane's index is in range on every iteration of the lane loop. */
function storePlan(
  site: LoopSite,
  loop: { localId: string },
  limit: { receiver: string; container: LaneContainer; elem: LaneElemName },
  locals: ReadonlyMap<string, IrLocal>,
): LaneStorePlan | null {
  if (!STORE_ELEMS.has(limit.elem)) return null;
  const stmt = site.stmt;
  const body = matchStoreBody(stmt.body, loop.localId);
  if (body === null || body.receiver !== limit.receiver) return null;
  const view = locals.get(body.receiver);
  if (view === undefined || view.boxed === true) return null;
  if (limit.container === "bytes") {
    if (view.type.kind !== "bytes") return null;
  } else if (view.type.kind !== "array" || view.type.elem.kind !== "f64") return null;
  const value = storeValueNode(body.value, body.receiver, loop.localId, limit.container);
  if (value === null) return null;
  // The lane body evaluates each invariant once, before the loop, so the
  // loop must leave it alone.
  const invariants = new Set<string>();
  nodeInvariants(value, invariants);
  for (const id of invariants) if (writesLocal(stmt, id)) return null;
  return {
    shape: "store",
    induction: loop.localId,
    receiver: body.receiver,
    container: limit.container,
    elem: limit.elem,
    value,
  };
}

/** The container, element and receiver of a loop the integer loop matchers
 * accept, or null. A dense array loop is recognized with no enclosing array
 * binding, which is every loop that starts at zero; a loop that starts from
 * an outer counter keeps its scalar form. */
function loopSource(
  stmt: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
): {
  induction: string;
  container: LaneContainer;
  receiver: string;
  elem: LaneElemName;
} | null {
  const bytes = matchIntegerBytesForLoop(stmt, locals);
  const loop = bytes ?? matchIntegerArrayForLoop(stmt, locals, new Set<string>());
  if (loop === null || !loop.stableReceiver) return null;
  const receiver = loop.limitReceiver;
  if (receiver.kind !== "varRef") return null;
  const view = locals.get(receiver.localId);
  if (view === undefined || view.boxed === true) return null;
  if (bytes !== null) {
    if (view.type.kind !== "bytes") return null;
    return {
      induction: loop.localId,
      container: "bytes",
      receiver: receiver.localId,
      elem: view.type.elem,
    };
  }
  // A dense number array: its double storage takes elementwise stores, and
  // int32 storage (exact int32 elements, never -0) takes sums and counts.
  if (view.type.kind !== "array" || view.type.elem.kind !== "f64") return null;
  return {
    induction: loop.localId,
    container: "array",
    receiver: receiver.localId,
    elem: "i32slot",
  };
}

/** The lane plan for one loop, or null when it has none. */
function planLoop(
  site: LoopSite,
  locals: ReadonlyMap<string, IrLocal>,
  facts: FunctionFacts,
  shapes: ReadonlySet<LaneShape>,
  classes: ReadonlyMap<string, IrClassDef>,
  functions: ReadonlyMap<string, IrFunction>,
): LanePlan | null {
  const stmt = site.stmt;
  // An outer loop reads no array, so it is tried before the array matcher.
  if (shapes.has("outer")) {
    const outer = outerPlan(stmt, locals, classes, functions);
    if (outer !== null) return outer;
  }
  const source = loopSource(stmt, locals);
  if (source === null) return null;
  const { induction, container, receiver, elem } = source;
  const loop = { localId: induction };
  if (shapes.has("store")) {
    // A dense number array's stores are double-slot stores: a plan for the
    // int32 storage a sum reads would need the element's own conversion.
    const storeElem: LaneElemName = container === "array" ? "f64slot" : elem;
    const store = storePlan(site, loop, { receiver, container, elem: storeElem }, locals);
    if (store !== null) return store;
  }
  const lanes = laneElem(elem);
  if (lanes === null) return null;
  if (stmt.body.length !== 1) return null;
  const only = stmt.body[0]!;
  if (shapes.has("sum")) {
    const accumulator = matchSumBody(only, receiver, loop.localId, container);
    if (accumulator !== null && entryIsZero(accumulator, site, locals, facts))
      return {
        shape: "sum",
        induction: loop.localId,
        receiver,
        container,
        elem,
        accumulator,
        lengthBound: sumLengthBound(lanes),
      };
  }
  if (shapes.has("count")) {
    const matched = matchCountBody(only, receiver, loop.localId, container);
    if (
      matched !== null &&
      invariantLimit(matched.compare.limit, stmt, loop.localId) &&
      entryIsZero(matched.accumulator, site, locals, facts)
    )
      return {
        shape: "count",
        induction: loop.localId,
        receiver,
        container,
        elem,
        accumulator: matched.accumulator,
        compare: matched.compare,
      };
  }
  return null;
}

/** The lane plans of one function, keyed by the loop statement. `locals` is
 * the map the emitter matches loops with (initializer bindings included). */
export function planLaneLoops(
  fn: IrFunction,
  locals: ReadonlyMap<string, IrLocal>,
  shapes: ReadonlySet<LaneShape>,
  classes: readonly IrClassDef[] = [],
  functions: readonly IrFunction[] = [],
): Map<IrStmt, LanePlan> {
  const plans = new Map<IrStmt, LanePlan>();
  if (shapes.size === 0) return plans;
  const facts = functionFacts(fn);
  const classMap = new Map(classes.map((cls) => [cls.name, cls] as const));
  const functionMap = new Map(functions.map((f) => [f.name, f] as const));
  for (const site of facts.loops) {
    const plan = planLoop(site, locals, facts, shapes, classMap, functionMap);
    if (plan !== null) plans.set(site.stmt, plan);
  }
  return plans;
}

/** The shapes `SCRIPTC_LANES_PLAN` names, or none. `all` names every shape. */
export function parseLaneShapes(text: string | undefined): Set<LaneShape> {
  const shapes = new Set<LaneShape>();
  if (text === undefined) return shapes;
  for (const name of text.split(",")) {
    const trimmed = name.trim();
    if (trimmed === "all") return new Set(LANE_SHAPES);
    if ((LANE_SHAPES as readonly string[]).includes(trimmed)) shapes.add(trimmed as LaneShape);
  }
  return shapes;
}

/** The lane plans this build emits: `SCRIPTC_LANES_PLAN=<kinds>`. */
export function laneShapesFromEnvironment(): Set<LaneShape> {
  return parseLaneShapes(process.env["SCRIPTC_LANES_PLAN"]);
}

/** Cache-key parts for a build's lane plans; empty when none is enabled, so
 * existing keys are unchanged. */
export function laneShapesKeyParts(shapes: ReadonlySet<LaneShape>): string[] {
  if (shapes.size === 0) return [];
  return [`lane-plans-${LANE_SHAPES.filter((s) => shapes.has(s)).join("+")}`];
}
