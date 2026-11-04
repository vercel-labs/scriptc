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

import { type IrBytesElem, type IrExpr, type IrFunction, type IrLocal, type IrStmt } from "./ir.js";
import { matchIntegerArrayForLoop, matchIntegerBytesForLoop } from "./integer-loops.js";
import { everyExpr, everyStmt } from "./traverse.js";

/** The shapes this file recognizes. `SCRIPTC_LANES_PLAN` names them. */
export type LaneShape = "sum" | "count" | "store";

export const LANE_SHAPES: readonly LaneShape[] = ["sum", "count", "store"];

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

export type LanePlan = LaneSumPlan | LaneCountPlan | LaneStorePlan;

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
): LanePlan | null {
  const stmt = site.stmt;
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
