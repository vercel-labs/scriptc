/* Lane plans.
 *
 * A lane plan is the loop emitter's permission to run several consecutive
 * iterations of one `for` loop in vector registers. This file recognizes
 * the `elementwise` shapes and records the facts the emitter needs; it does
 * not emit anything, and it leaves the IR alone (a plan is a side table
 * keyed by the loop statement, like the contracts).
 *
 * The shapes read a typed array at the induction variable and fold each
 * element into one accumulator:
 *
 *   for (let i = 0; i < a.length; i++) total += a[i]!;
 *   for (let i = 0; i < a.length; i++) if (a[i]! >= limit) count++;
 *
 * Both are order-free when every partial sum is an integer below 2^53: a
 * sum of integer elements is exact in any order below that bound, and a
 * count is at most the length. The sum's bound is checked at the loop entry
 * by the emitter (`lengthBound`), because it depends on the element type.
 *
 * A loop qualifies when:
 * - it is the canonical typed-array loop (`matchIntegerBytesForLoop`), the
 *   receiver is never assigned in the body, and the element type is an
 *   integer narrower than f64;
 * - the body is exactly the shape above, reading `receiver[i]` and writing
 *   the accumulator;
 * - the accumulator is a mutable unboxed `f64` local declared as the literal
 *   0, and it holds exactly +0 wherever the loop is entered. Those facts,
 *   which `entryIsZero` checks, are what the exactness argument needs: the
 *   loop's partial sums then start from +0 and stay inside the bound on
 *   their own.
 *
 * Everything else keeps its scalar form. */

import { type IrBytesElem, type IrExpr, type IrFunction, type IrLocal, type IrStmt } from "./ir.js";
import { matchIntegerBytesForLoop } from "./integer-loops.js";
import { everyExpr, everyStmt } from "./traverse.js";

/** The shapes this file recognizes. `SCRIPTC_LANES_PLAN` names them. */
export type LaneShape = "sum" | "count";

export const LANE_SHAPES: readonly LaneShape[] = ["sum", "count"];

/** The operator of the count shape's element test. */
export type LaneCompareOp = "<" | "<=" | ">" | ">=" | "===" | "!==";

/** An integer typed-array element a lane loop may read. */
export interface LaneElem {
  /** The LLVM integer the element loads as. */
  type: "i8" | "i16" | "i32";
  bits: number;
  signed: boolean;
  /** The largest `|value|` a lane can hold. */
  max: number;
}

const LANE_ELEMS: ReadonlyMap<IrBytesElem, LaneElem> = new Map<IrBytesElem, LaneElem>([
  ["u8", { type: "i8", bits: 8, signed: false, max: 255 }],
  // A clamped array reads like a byte array; only its stores clamp.
  ["u8c", { type: "i8", bits: 8, signed: false, max: 255 }],
  ["i8", { type: "i8", bits: 8, signed: true, max: 128 }],
  ["u16", { type: "i16", bits: 16, signed: false, max: 65535 }],
  ["i16", { type: "i16", bits: 16, signed: true, max: 32768 }],
  ["u32", { type: "i32", bits: 32, signed: false, max: 4294967295 }],
  ["i32", { type: "i32", bits: 32, signed: true, max: 2147483648 }],
]);

/** The element an integer typed array loads as, or null for a float or an
 * unknown element. */
export function laneElem(elem: IrBytesElem): LaneElem | null {
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
  elem: IrBytesElem;
  accumulator: string;
  /** Exclusive bound on the element count. */
  lengthBound: number;
}

export interface LaneCountPlan {
  shape: "count";
  induction: string;
  receiver: string;
  elem: IrBytesElem;
  accumulator: string;
  /** The element test. `limit` is loop-invariant (the body's shape leaves
   * it no way to write it), so the emitter evaluates it once at the entry
   * and compares lanes against an integer splat. */
  compare: { op: LaneCompareOp; limit: IrExpr };
}

export type LanePlan = LaneSumPlan | LaneCountPlan;

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

/** `e` is `receiver[induction]`. */
function elementRead(e: IrExpr, receiver: string, induction: string): boolean {
  return (
    e.kind === "bytesIntrinsic" &&
    e.method === "get" &&
    e.receiver.kind === "varRef" &&
    e.receiver.localId === receiver &&
    e.args.length === 1 &&
    e.args[0]!.kind === "varRef" &&
    e.args[0]!.localId === induction
  );
}

/** `acc = acc + receiver[induction]`, in either operand order. */
function matchSumBody(only: IrStmt, receiver: string, induction: string): string | null {
  if (only.kind !== "assign" || only.value.kind !== "bin" || only.value.op !== "+") return null;
  const { left, right } = only.value;
  const isAcc = (e: IrExpr): boolean => e.kind === "varRef" && e.localId === only.localId;
  if (isAcc(left) && elementRead(right, receiver, induction)) return only.localId;
  if (isAcc(right) && elementRead(left, receiver, induction)) return only.localId;
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
  if (elementRead(cond.left, receiver, induction))
    return { accumulator: inc.localId, compare: { op, limit: cond.right } };
  if (elementRead(cond.right, receiver, induction))
    return { accumulator: inc.localId, compare: { op: flip(op), limit: cond.left } };
  return null;
}

/** The limit test's operand: a value the lane entry can evaluate once. */
function invariantLimit(e: IrExpr): boolean {
  return e.kind === "numLit" || (e.kind === "varRef" && e.type.kind === "f64");
}

/** Whether the accumulator holds exactly +0 wherever this loop is entered.
 *
 * The value is +0 when the declaration runs before the loop on every way in:
 * it must be declared as the literal 0, it must be declared inside the same
 * loops as the loop (so no back edge swings past it between two entries of
 * the loop), and it must be on the loop's path with nothing in front of it
 * writing it. Loop versioning rewrites one source loop into several copies,
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
  return declared;
}

/** Whether an expression writes `id`. */
function exprWrites(e: IrExpr, id: string): boolean {
  return !everyExpr(e, {
    expr: (node) =>
      !((node.kind === "assignExpr" || node.kind === "incDec") && node.localId === id),
    stmt: () => true,
  });
}

/** The lane plan for one loop, or null when it has none. */
function planLoop(
  site: LoopSite,
  locals: ReadonlyMap<string, IrLocal>,
  facts: FunctionFacts,
  shapes: ReadonlySet<LaneShape>,
): LanePlan | null {
  const stmt = site.stmt;
  const loop = matchIntegerBytesForLoop(stmt, locals);
  if (loop === null || !loop.stableReceiver) return null;
  const receiver = loop.limitReceiver;
  if (receiver.kind !== "varRef") return null;
  const view = locals.get(receiver.localId);
  if (view === undefined || view.type.kind !== "bytes" || view.boxed === true) return null;
  const elem = laneElem(view.type.elem);
  if (elem === null) return null;
  if (stmt.body.length !== 1) return null;
  const only = stmt.body[0]!;
  if (shapes.has("sum")) {
    const accumulator = matchSumBody(only, receiver.localId, loop.localId);
    if (accumulator !== null && entryIsZero(accumulator, site, locals, facts))
      return {
        shape: "sum",
        induction: loop.localId,
        receiver: receiver.localId,
        elem: view.type.elem,
        accumulator,
        lengthBound: sumLengthBound(elem),
      };
  }
  if (shapes.has("count")) {
    const matched = matchCountBody(only, receiver.localId, loop.localId);
    if (
      matched !== null &&
      invariantLimit(matched.compare.limit) &&
      entryIsZero(matched.accumulator, site, locals, facts)
    )
      return {
        shape: "count",
        induction: loop.localId,
        receiver: receiver.localId,
        elem: view.type.elem,
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
): Map<IrStmt, LanePlan> {
  const plans = new Map<IrStmt, LanePlan>();
  if (shapes.size === 0) return plans;
  const facts = functionFacts(fn);
  for (const site of facts.loops) {
    const plan = planLoop(site, locals, facts, shapes);
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
