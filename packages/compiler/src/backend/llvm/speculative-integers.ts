import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import { everyExpr, everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { InternalCompilerError } from "../../errors.js";
import { f64Lit } from "./common.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { exactInteger, widenInteger } from "./integer-values.js";
import { type IntegerRange, withinInt32 } from "../../ir/integer-ranges.js";

/** Speculative integer loops.
 *
 * An innermost loop whose number locals are only written by statement-level
 * integer arithmetic (`x = x * 31 + n`, `x += y % m`, `x++`) runs as two
 * copies. The fast copy keeps those locals in i64 shadow slots holding safe
 * integers and computes the writes with checked integer arithmetic; every
 * write also stores the exact double, so the ordinary slot is always current
 * and loop exits, calls and jumps need no write-back. A check that fails
 * (overflow past 2^53 - 1, a result of -0, a fractional or non-finite leaf, a
 * zero divisor) branches to the same statement in the ordinary double copy,
 * which re-executes it and finishes the loop there. Re-execution is exact
 * because a speculated statement evaluates nothing but locals, literals and
 * arithmetic before it writes.
 *
 * The loop is entered through the fast copy only when every speculated local
 * that is live on entry already holds a safe integer other than -0. */
export interface SpeculativeLoopPlan {
  /** Speculated locals; `true` when the entry value is live and checked. */
  locals: Map<string, boolean>;
  /** Statement-level writes computed as integers in the fast copy. */
  writes: Set<IrStmt>;
  /** Nothing in the loop can observe a module global or leave it other
   * than through its condition, `break` or a failed check: no calls, no
   * throwing operations, no labeled jumps and no `return`. */
  observerFree: boolean;
  /** The writes that speculate a rewritten value (rewriteSpeculable). */
  values: Map<IrStmt, SpeculativeValue>;
}

/** A write's value as speculation evaluates it: calls of small pure number
 * functions expanded in place, and other number leaves (`leaves`) replaced
 * by references to fresh locals. The fast copy evaluates each leaf once,
 * stores it to its local and checks it as an integer; a failed check
 * resumes at a copy of the write that reads the locals, so a leaf is never
 * evaluated twice. */
export interface SpeculativeValue {
  value: IrExpr;
  leaves: { localId: string; expr: IrExpr; ref: IrExpr }[];
}

/** What the planner may assume about the code around a loop. */
export interface SpeculationContext {
  /** The parameters and the returned expression of `callee` when it is a
   * small pure number function (inlinableNumberFunction). */
  inlinable?: (callee: string) => InlinableFunction | undefined;
  /** A local that no call can write: not captured, boxed or global. */
  unaliased?: (localId: string) => boolean;
  /** A fresh local id for a hoisted leaf. */
  leafId?: () => string;
}

export interface InlinableFunction {
  params: readonly string[];
  body: IrExpr;
}

/** `s` (a speculated write) writing `value` instead. */
export function withSpeculativeValue(s: IrStmt, value: IrExpr): IrStmt {
  switch (s.kind) {
    case "assign":
      return { ...s, value };
    case "varDecl":
      return { ...s, init: value };
    case "exprStmt":
      if (s.expr.kind === "assignExpr") return { ...s, expr: { ...s.expr, value } };
      break;
    default:
      break;
  }
  throw new InternalCompilerError(`llvm emitter bug: speculated ${s.kind} with a rewritten value`);
}

/** Calls nest at most this deep in one expansion. */
const MAX_INLINE_DEPTH = 4;
/** An expansion larger than this stays a call. */
const MAX_INLINE_NODES = 64;

/** A function that only returns arithmetic over its number parameters:
 * `function trim(v, n) { return v - Math.floor(v / Math.pow(2, n)) * Math.pow(2, n); }`.
 * Its call evaluates nothing but its arguments, so a speculated write may
 * expand it in place. A call in its body must be of another such function
 * (`resolve`): any other call could change what the expansion reads. */
export function inlinableNumberFunction(
  fn: IrFunction,
  resolve?: (callee: string) => InlinableFunction | undefined,
): InlinableFunction | undefined {
  if (
    fn.async ||
    fn.generator ||
    (fn.captures?.length ?? 0) > 0 ||
    (fn.classCaptures?.length ?? 0) > 0 ||
    fn.returnType.kind !== "f64" ||
    fn.params.some((p) => p.type.kind !== "f64" && p.type.kind !== "union") ||
    fn.body.length !== 1 ||
    fn.body[0]!.kind !== "return" ||
    fn.body[0]!.value === undefined
  )
    return undefined;
  const params = fn.params.map((p) => p.localId);
  const known = new Set(params);
  let nodes = 0;
  // A parameter of a union type (`number | undefined`) is read only
  // through its tag test and narrowing, which a wrapped argument folds.
  const union = (e: IrExpr): boolean => e.kind === "varRef" && known.has(e.localId);
  const pure = (e: IrExpr): boolean => {
    if (++nodes > MAX_INLINE_NODES) return false;
    if (e.kind === "boolLit") return true;
    if (e.kind === "unionIsTag") return union(e.value);
    if (e.kind === "unionNarrow") return e.type.kind === "f64" && union(e.value);
    if (e.type.kind !== "f64") return false;
    switch (e.kind) {
      case "numLit":
        return true;
      case "varRef":
        return known.has(e.localId);
      case "ternary":
        return pure(e.cond) && pure(e.then) && pure(e.else_);
      case "bin":
        return (INTEGER_OPS.has(e.op) || e.op === "/") && pure(e.left) && pure(e.right);
      case "unary":
        return e.op === "-" && pure(e.operand);
      case "libCall":
        return (e.fn === "math.floor" || e.fn === "math.pow") && e.args.every(pure);
      case "call":
        return resolve?.(e.callee) !== undefined && e.args.every(pure);
      default:
        return false;
    }
  };
  const body = fn.body[0]!.value!;
  return pure(body) ? { params, body } : undefined;
}

/** `e` with each parameter reference replaced by its argument. A tag test
 * or narrowing of a wrapped argument folds, and so does a ternary over a
 * folded test. */
function substitute(e: IrExpr, args: ReadonlyMap<string, IrExpr>): IrExpr {
  switch (e.kind) {
    case "varRef":
      return args.get(e.localId) ?? e;
    case "unionIsTag": {
      const value = substitute(e.value, args);
      if (value.kind !== "unionWrap" || value.unionId !== e.unionId) return { ...e, value };
      return {
        kind: "boolLit",
        value: (value.tag === e.tag) !== (e.negated === true),
        type: e.type,
        loc: e.loc,
      };
    }
    case "unionNarrow": {
      const value = substitute(e.value, args);
      return value.kind === "unionWrap" && value.unionId === e.unionId && value.tag === e.tag
        ? value.value
        : { ...e, value };
    }
    case "ternary": {
      const cond = substitute(e.cond, args);
      if (cond.kind === "boolLit") return substitute(cond.value ? e.then : e.else_, args);
      return { ...e, cond, then: substitute(e.then, args), else_: substitute(e.else_, args) };
    }
    case "bin":
      return { ...e, left: substitute(e.left, args), right: substitute(e.right, args) };
    case "unary":
      return { ...e, operand: substitute(e.operand, args) };
    case "libCall":
    case "call":
      return { ...e, args: e.args.map((a) => substitute(a, args)) };
    default:
      return e;
  }
}

/** k when `value` is exactly 2^k with k in [0, 52], else null.
 * Math.log2 rounds: 2^52 + 1 gives 52, so the power is compared back. */
function exactPowerOfTwo(value: number): number | null {
  if (!(value >= 1)) return null;
  const k = Math.round(Math.log2(value));
  return k >= 0 && k <= 52 && 2 ** k === value ? k : null;
}

/** The same speculated operand written twice: a local, a literal, or a
 * power of two of the same exponent. */
function sameOperand(a: IrExpr, b: IrExpr): boolean {
  if (a.kind === "varRef") return b.kind === "varRef" && a.localId === b.localId;
  if (a.kind === "numLit") return b.kind === "numLit" && Object.is(a.value, b.value);
  return (
    a.kind === "libCall" &&
    b.kind === "libCall" &&
    a.fn === "math.pow" &&
    b.fn === "math.pow" &&
    powerOfTwo(a) &&
    powerOfTwo(b) &&
    sameOperand(a.args[1]!, b.args[1]!)
  );
}

/** `a - Math.floor(a / p) * p` (either factor order) with p a power of two
 * and `a` a local or literal: the floor-mod of `a` by p. */
function floorModPowerOfTwo(e: IrExpr): { value: IrExpr; power: IrExpr } | null {
  if (e.kind !== "bin" || e.op !== "-" || e.right.kind !== "bin" || e.right.op !== "*") return null;
  const { left, right } = e.right;
  const [floor, power] =
    left.kind === "libCall" && left.fn === "math.floor" ? [left, right] : [right, left];
  if (floor.kind !== "libCall" || floor.fn !== "math.floor" || floor.args.length !== 1) return null;
  const quotient = floor.args[0]!;
  if (quotient.kind !== "bin" || quotient.op !== "/") return null;
  if (!powerOfTwo(power) || !sameOperand(quotient.right, power)) return null;
  if (e.left.kind !== "varRef" && e.left.kind !== "numLit") return null;
  return sameOperand(quotient.left, e.left) ? { value: e.left, power } : null;
}

/** Whether `e` is a power of two speculation can shift by:
 * `Math.pow(2, n)` or a literal 2^k with k in [0, 52]. */
function powerOfTwo(e: IrExpr): boolean {
  if (e.kind === "numLit") return exactPowerOfTwo(e.value) !== null;
  return (
    e.kind === "libCall" &&
    e.fn === "math.pow" &&
    e.args.length === 2 &&
    e.args[0]!.kind === "numLit" &&
    e.args[0]!.value === 2
  );
}

/** Typed-array element kinds whose elements are integers. */
const INTEGER_ELEMENTS = new Set(["u8", "u8c", "i8", "u16", "i16", "u32", "i32"]);

/** A typed-array element read of an integer kind with no effect: an
 * out-of-range read gives NaN, which fails its check. Float elements would
 * only bail. */
function isSpeculativeByteRead(e: IrExpr): boolean {
  return (
    e.kind === "bytesIntrinsic" &&
    e.method === "get" &&
    e.type.kind === "f64" &&
    e.receiver.type.kind === "bytes" &&
    INTEGER_ELEMENTS.has(e.receiver.type.elem) &&
    e.args.length === 1 &&
    isEffectFree(e.receiver) &&
    isEffectFree(e.args[0]!)
  );
}

/** Whether evaluating `e` assigns no binding: no `++`/`--`, no assignment
 * expression, and no statement inside it. */
function writesNoLocal(e: IrExpr): boolean {
  return everyExpr(e, {
    expr: (node) => node.kind !== "incDec" && node.kind !== "assignExpr",
    stmt: () => false,
  });
}

/** Rewrite a write's value that isSpeculableValue refuses into one it can
 * speculate (SpeculativeValue), or null. Expansion and the new operations
 * (`Math.pow(2, n)`, `Math.floor(a / 2^n)`, byte reads) evaluate nothing
 * but numbers, so the fast copy may evaluate them in any order. Hoisted
 * leaves run in the write's evaluation order before the arithmetic; that
 * reorders nothing only when the write reads no heap and every local it
 * reads is one no call can write. */
export function rewriteSpeculable(
  value: IrExpr,
  context: SpeculationContext,
): SpeculativeValue | null {
  const leaves: SpeculativeValue["leaves"] = [];
  let reads = false;
  const locals: string[] = [];
  const rewrite = (e: IrExpr, depth: number): IrExpr | null => {
    if (e.type.kind !== "f64") return null;
    switch (e.kind) {
      case "numLit":
        return Number.isSafeInteger(e.value) && !Object.is(e.value, -0) ? e : null;
      case "varRef":
        locals.push(e.localId);
        return e;
      case "bin": {
        if (!ARITHMETIC_OPS.has(e.op)) break;
        const left = rewrite(e.left, depth);
        const right = left && rewrite(e.right, depth);
        return left && right ? { ...e, left, right } : null;
      }
      case "unary": {
        if (e.op !== "-") break;
        const operand = rewrite(e.operand, depth);
        return operand ? { ...e, operand } : null;
      }
      case "libCall": {
        if (powerOfTwo(e) && e.kind === "libCall") {
          const exponent = rewrite(e.args[1]!, depth);
          return exponent ? { ...e, args: [e.args[0]!, exponent] } : null;
        }
        const quotient = e.args[0];
        if (
          e.fn === "math.floor" &&
          e.args.length === 1 &&
          quotient?.kind === "bin" &&
          quotient.op === "/" &&
          powerOfTwo(quotient.right)
        ) {
          const left = rewrite(quotient.left, depth);
          const right = left && rewrite(quotient.right, depth);
          return left && right ? { ...e, args: [{ ...quotient, left, right }] } : null;
        }
        break;
      }
      case "call": {
        const fn = depth < MAX_INLINE_DEPTH ? context.inlinable?.(e.callee) : undefined;
        // Arguments are evaluated before the body: an expansion may read
        // them in another order, or twice, only when they are pure.
        const plain = (a: IrExpr): boolean =>
          isSpeculableValue(a, false) ||
          (a.kind === "unionWrap" && isSpeculableValue(a.value, false));
        if (fn !== undefined && fn.params.length === e.args.length && e.args.every(plain)) {
          const args = new Map(fn.params.map((id, i) => [id, e.args[i]!]));
          return rewrite(substitute(fn.body, args), depth + 1);
        }
        break;
      }
      default:
        if (isSpeculativeRead(e) || isSpeculativeByteRead(e)) {
          reads = true;
          return e;
        }
        break;
    }
    // Only calls of program functions are hoisted: other leaves (a string's
    // length, a Map read) are cheap where they stand, and would turn every
    // loop that adds one into a second copy.
    if (context.leafId === undefined || e.kind !== "call") return null;
    // Hoisting runs the arguments before the rest of the write: one that
    // assigns a local would move that write ahead of the write's earlier
    // reads of it.
    if (!e.args.every(writesNoLocal)) return null;
    const ref: IrExpr = { kind: "varRef", localId: context.leafId(), type: e.type, loc: e.loc };
    leaves.push({ localId: (ref as { localId: string }).localId, expr: e, ref });
    return ref;
  };
  const rewritten = rewrite(value, 0);
  if (rewritten === null) return null;
  if (leaves.length > 0) {
    const leafIds = new Set(leaves.map((leaf) => leaf.localId));
    if (reads || !locals.every((id) => leafIds.has(id) || context.unaliased?.(id) === true))
      return null;
  }
  return { value: rewritten, leaves };
}

type SpeculativeLoop = Extract<IrStmt, { kind: "for" | "while" | "doWhile" }>;

/** The fast copy duplicates the loop; keep the duplicated code small. */
export const MAX_LOOP_NODES = 400;

/** Statements whose emission is plain control flow or a single write.
 * Nested loops, switches and try statements keep the loop on the ordinary
 * path (their emission keeps state that the two copies would not share). */
export const SIMPLE_STATEMENTS: ReadonlySet<string> = new Set<string>([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "block",
  "arraySet",
  "bytesSet",
  "fieldSet",
  "recordSet",
  "break",
  "continue",
  "return",
]);

/** Statements and expressions that run no other code and cannot throw. */
const OBSERVER_FREE_STATEMENTS = new Set<string>([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "block",
  "break",
  "continue",
]);
const OBSERVER_FREE_EXPRESSIONS = new Set<string>([
  "numLit",
  "boolLit",
  "varRef",
  "bin",
  "unary",
  "incDec",
  "assignExpr",
  "toBool",
  "logical",
  "ternary",
]);

/** Operators whose double form costs conversions or long latency, and that
 * take an integer operand directly. */
const CONSUMING_OPS = new Set<string>([
  "*",
  "/",
  "%",
  "**",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
  "<",
  "<=",
  ">",
  ">=",
  "===",
  "!==",
]);

const INTEGER_OPS = new Set<string>(["+", "-", "*", "%", "&", "|", "^", "<<", ">>", ">>>"]);
const ARITHMETIC_OPS = new Set<string>(["+", "-", "*", "%"]);

/** A number expression that reads only locals and literals through integer
 * operators: evaluating it has no effects, so a failed check may restart its
 * statement. Division and exponentiation usually leave the integers and
 * would only bail. */
export function isSpeculableValue(e: IrExpr, reads = true): boolean {
  if (e.type.kind !== "f64") return false;
  switch (e.kind) {
    case "numLit":
      return Number.isSafeInteger(e.value) && !Object.is(e.value, -0);
    case "varRef":
      return true;
    case "bin": {
      if (!INTEGER_OPS.has(e.op)) return false;
      // Bitwise operators evaluate through the ordinary emitter, which
      // must not read the heap after a check (see speculativeReads).
      const inner = reads && ARITHMETIC_OPS.has(e.op);
      return isSpeculableValue(e.left, inner) && isSpeculableValue(e.right, inner);
    }
    case "unary":
      return (e.op === "-" || e.op === "~") && isSpeculableValue(e.operand, reads && e.op === "-");
    default:
      return reads && isSpeculativeRead(e);
  }
}

/** A number read from a string, an array, a record or an object field that
 * has no effect: it may throw (a missing element), but it changes nothing,
 * so a failed check may restart its statement. Its value carries no range,
 * so it is checked like any other unproven integer. */
export function isSpeculativeRead(e: IrExpr): boolean {
  if (e.type.kind !== "f64") return false;
  switch (e.kind) {
    case "strIntrinsic":
      return (
        e.method === "charCodeAt" &&
        isEffectFree(e.receiver) &&
        e.args.length === 1 &&
        isEffectFree(e.args[0]!)
      );
    case "arrayGet":
      return isEffectFree(e.arr) && isEffectFree(e.index);
    case "recordGet":
    case "fieldGet":
      return isEffectFree(e.obj);
    default:
      return false;
  }
}

/** Receivers and indexes of speculative reads: locals, literals, number
 * arithmetic and nested reads. */
function isEffectFree(e: IrExpr): boolean {
  switch (e.kind) {
    case "numLit":
    case "varRef":
      return true;
    case "bin":
      return e.left.type.kind === "f64" && isEffectFree(e.left) && isEffectFree(e.right);
    case "arrayGet":
      return isEffectFree(e.arr) && isEffectFree(e.index);
    case "recordGet":
    case "fieldGet":
      return isEffectFree(e.obj);
    default:
      return false;
  }
}

/** The speculative reads of a speculable value in evaluation order, those
 * of a rewritten value (rewriteSpeculable) included. */
export function speculativeReads(e: IrExpr, out: IrExpr[] = []): IrExpr[] {
  if (e.kind === "bin" && (ARITHMETIC_OPS.has(e.op) || e.op === "/")) {
    speculativeReads(e.left, out);
    speculativeReads(e.right, out);
  } else if (e.kind === "unary" && e.op === "-") speculativeReads(e.operand, out);
  else if (e.kind === "libCall" && (e.fn === "math.floor" || e.fn === "math.pow"))
    for (const arg of e.args) speculativeReads(arg, out);
  else if (isSpeculativeRead(e) || isSpeculativeByteRead(e)) out.push(e);
  return out;
}

/** `x = x + y` or `x = x - y` with a step that is not a literal, as in a
 * sieve's `j += i`: the double copy pays a conversion of every index and
 * the step's own latency, while counters stepping by a literal usually
 * have a static proof or too little work to repay a second copy. */
function isVariableStep(localId: string, e: IrExpr): boolean {
  if (e.kind !== "bin" || (e.op !== "+" && e.op !== "-")) return false;
  const self = (x: IrExpr): boolean => x.kind === "varRef" && x.localId === localId;
  const step = self(e.left) ? e.right : e.op === "+" && self(e.right) ? e.left : null;
  return step !== null && step.kind !== "numLit";
}

function hasProduct(e: IrExpr): boolean {
  if (e.kind === "bin")
    return e.op === "*" || e.op === "%" || hasProduct(e.left) || hasProduct(e.right);
  if (e.kind === "unary") return hasProduct(e.operand);
  // Math.floor(a / 2^n) and Math.pow(2, n) replace a division and a call.
  if (e.kind === "libCall") return e.fn === "math.floor" || e.fn === "math.pow";
  return false;
}

function hasArithmetic(e: IrExpr): boolean {
  if (e.kind === "bin")
    return ARITHMETIC_OPS.has(e.op) || hasArithmetic(e.left) || hasArithmetic(e.right);
  if (e.kind === "unary") return e.op === "-" || hasArithmetic(e.operand);
  if (e.kind === "libCall") return e.fn === "math.floor" || e.fn === "math.pow";
  return false;
}

/** The written local and value of a statement-level write, or null. A
 * value of null with a local means `x++`/`x--`. */
export function speculativeWriteTarget(
  s: IrStmt,
): { localId: string; value: IrExpr | null; op: "+" | "-" } | null {
  switch (s.kind) {
    case "assign":
      return { localId: s.localId, value: s.value, op: "+" };
    case "varDecl":
      return s.init ? { localId: s.localId, value: s.init, op: "+" } : null;
    case "exprStmt":
      if (s.expr.kind === "incDec") return { localId: s.expr.localId, value: null, op: s.expr.op };
      if (s.expr.kind === "assignExpr")
        return { localId: s.expr.localId, value: s.expr.value, op: "+" };
      return null;
    default:
      return null;
  }
}

/** `eligible` names the locals a shadow may stand for; `integral` those the
 * emitter already holds as integers (counters, int32 locals); `proven` the
 * expressions the static range analysis already proves integral. Static
 * proofs come first: a local whose reads are all proven is never shadowed
 * or checked, and a loop with nothing unproven is never duplicated. */
export function planSpeculativeLoop(
  loop: SpeculativeLoop,
  eligible: (localId: string) => boolean,
  integral: (localId: string) => boolean = () => false,
  proven: (e: IrExpr) => boolean = () => false,
  invariantEligible: (localId: string) => boolean = eligible,
  context: SpeculationContext = {},
): SpeculativeLoopPlan | null {
  const writes = new Map<string, IrStmt[]>();
  const values = new Map<IrStmt, SpeculativeValue>();
  const leafIds = new Set<string>();
  const unspeculable = new Set<string>();
  const reads = new Set<string>();
  // Locals with at least one read the static analysis does not prove.
  const unproven = new Set<string>();
  const declared = new Set<string>();
  let nodes = 0;
  let rejected = false;
  let arithmetic = false;
  let observerFree = true;
  // Locals the loop reads as integers: operands of multiplication,
  // remainder, bitwise operators and comparisons, and indexes. An
  // accumulator only ever added to gains little from an integer shadow
  // (the double add is cheap), so it keeps its double.
  const consumed = new Set<string>();
  const consume = (e: IrExpr): void => {
    if (e.kind === "varRef") consumed.add(e.localId);
  };
  // Operands of multiplication, division and remainder: the operations whose
  // double forms cost the most. A loop whose integers only count and compare
  // gains nothing measurable from a second copy, so it keeps one.
  const multiplied = new Set<string>();
  // A product in the condition alone (`i < Math.floor(n * scale)`) does not
  // make the body's work integer.
  let inCondition = false;

  // What the integer writes read and consume. A rewritten value is noted
  // here alone: its original, which `expr` walks, has its effects.
  const note = (e: IrExpr): void => {
    if (e.kind === "varRef") {
      reads.add(e.localId);
      if (!proven(e)) unproven.add(e.localId);
    } else if (e.kind === "assignExpr" || e.kind === "incDec") unspeculable.add(e.localId);
    else if (e.kind === "bin" && CONSUMING_OPS.has(e.op)) {
      consume(e.left);
      consume(e.right);
      if (!inCondition && (e.op === "*" || e.op === "/" || e.op === "%"))
        for (const operand of [e.left, e.right])
          if (operand.kind === "varRef") multiplied.add(operand.localId);
    } else if (e.kind === "arrayGet" || e.kind === "arrayHas" || e.kind === "arrayState")
      consume(e.index);
    else if (e.kind === "bytesIntrinsic" || e.kind === "strIntrinsic") e.args.forEach(consume);
  };
  // An expanded call is emitted in the fast copy: it counts toward the
  // duplicated code.
  const noteAll = (e: IrExpr): boolean => {
    nodes++;
    note(e);
    return everyExprChild(e, noteAll, () => true);
  };
  const expr = (e: IrExpr): boolean => {
    if (rejected) return false;
    nodes++;
    if (!OBSERVER_FREE_EXPRESSIONS.has(e.kind) || (e.kind === "bin" && e.left.type.kind !== "f64"))
      observerFree = false;
    note(e);
    return everyExprChild(e, expr, nested);
  };
  // Statements inside expressions (sequence expressions) run mid-expression,
  // where no statement can restart: their writes stay unspeculated.
  const nested = (s: IrStmt): boolean => {
    nodes++;
    observerFree = false;
    if (s.kind === "assign" || s.kind === "varDecl") unspeculable.add(s.localId);
    return everyStmtChild(s, expr, nested);
  };
  const stmt = (s: IrStmt): boolean => {
    if (rejected) return false;
    nodes++;
    if (!SIMPLE_STATEMENTS.has(s.kind)) {
      rejected = true;
      return false;
    }
    if (
      !OBSERVER_FREE_STATEMENTS.has(s.kind) ||
      ((s.kind === "break" || s.kind === "continue") && s.label !== undefined)
    )
      observerFree = false;
    if (s.kind === "varDecl") declared.add(s.localId);
    if (s.kind === "arraySet" || s.kind === "bytesSet") consume(s.index);
    const target = speculativeWriteTarget(s);
    if (target) {
      const rewritten =
        target.value === null || isSpeculableValue(target.value)
          ? null
          : rewriteSpeculable(target.value, context);
      if (target.value === null || isSpeculableValue(target.value) || rewritten !== null) {
        const list = writes.get(target.localId) ?? [];
        list.push(s);
        writes.set(target.localId, list);
        if (target.value === null) {
          reads.add(target.localId);
          if (s.kind !== "exprStmt" || !proven(s.expr)) unproven.add(target.localId);
        } else expr(target.value);
        if (rewritten !== null) {
          values.set(s, rewritten);
          for (const leaf of rewritten.leaves) leafIds.add(leaf.localId);
          noteAll(rewritten.value);
        }
        return !rejected;
      }
      unspeculable.add(target.localId);
      if (target.value) expr(target.value);
      return !rejected;
    }
    return everyStmtChild(s, expr, stmt);
  };

  if (loop.cond) {
    inCondition = true;
    expr(loop.cond);
    inCondition = false;
  }
  if (loop.kind === "for" && loop.update) stmt(loop.update);
  for (const s of loop.body) stmt(s);
  if (rejected || nodes > MAX_LOOP_NODES) return null;

  const locals = new Map<string, boolean>();
  for (const id of writes.keys())
    if (!unspeculable.has(id) && consumed.has(id) && unproven.has(id) && eligible(id))
      locals.set(id, !declared.has(id));
  // Every local a speculated write reads must be an integer whenever the
  // write runs: speculated itself, already an integer, or loop-invariant
  // (checked on entry). A value computed from doubles the loop writes
  // would only fail its check on every entry.
  const valueOf = (s: IrStmt): IrExpr | null =>
    values.get(s)?.value ?? speculativeWriteTarget(s)!.value;
  const grounded = (e: IrExpr): boolean => {
    if (e.kind === "varRef") {
      const id = e.localId;
      return (
        leafIds.has(id) ||
        proven(e) ||
        locals.has(id) ||
        integral(id) ||
        (!writes.has(id) && !unspeculable.has(id) && invariantEligible(id))
      );
    }
    if (isSpeculativeRead(e) || isSpeculativeByteRead(e)) return true;
    return everyExprChild(e, grounded, () => false);
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...locals.keys()]) {
      for (const s of writes.get(id)!) {
        const value = valueOf(s);
        if (value !== null && !grounded(value)) {
          locals.delete(id);
          changed = true;
          break;
        }
      }
    }
  }
  const speculated = new Set<IrStmt>();
  for (const id of locals.keys()) for (const s of writes.get(id)!) speculated.add(s);
  if (speculated.size === 0) return null;
  // Loop-invariant integer inputs of the writes and the condition join the
  // shadows, so their reads carry integer facts too.
  const invariant = (e: IrExpr): boolean => {
    if (e.kind === "varRef") {
      const id = e.localId;
      if (
        !leafIds.has(id) &&
        !proven(e) &&
        !locals.has(id) &&
        !writes.has(id) &&
        !unspeculable.has(id) &&
        invariantEligible(id)
      )
        locals.set(id, true);
      return true;
    }
    return everyExprChild(e, invariant, () => true);
  };
  for (const s of speculated) {
    const value = valueOf(s);
    if (value === null) arithmetic = true;
    else {
      if (hasArithmetic(value)) arithmetic = true;
      invariant(value);
    }
  }
  if (!arithmetic) return null;
  if (loop.cond) invariant(loop.cond);
  const heavy =
    [...locals.keys()].some((id) => multiplied.has(id)) ||
    [...speculated].some((s) => {
      const target = speculativeWriteTarget(s)!;
      const value = valueOf(s);
      return value !== null && (hasProduct(value) || isVariableStep(target.localId, value));
    });
  if (!heavy) return null;
  for (const s of values.keys()) if (!speculated.has(s)) values.delete(s);
  return { locals, writes: speculated, observerFree, values };
}

/** A proven integer loop. The bindings integer-ranges.ts bounds over a for
 * loop (`loopRanges`) hold an integer on entry and at every write, so the
 * loop keeps them in i64 shadow slots without a second copy or checks, and
 * writes their doubles once, when it is left. */
export interface ProvenLoopPlan {
  /** Shadowed bindings and their loop ranges. */
  locals: Map<string, IntegerRange>;
  /** Statement-level writes computed as integers. */
  writes: Set<IrStmt>;
  /** Expression-position `++`/`--` of shadowed bindings (`out[o++] = v`),
   * computed on the shadows. */
  increments: Set<IrExpr>;
}

/** Plan a proven integer loop. `cursors` are the loop's bounded bindings,
 * `eligible` the locals a shadow may stand for, `integral` those the emitter
 * already holds as integers and `proven` the expressions the range analysis
 * proves integral. A shadowed binding's double is stale until the loop is
 * left, so every exit has to pass the write-back: the caller plans only
 * loops where an exception leaves the function, and a labeled jump (which
 * may leave past the write-back) keeps the loop ordinary. */
export function planProvenIntegerLoop(
  loop: SpeculativeLoop,
  cursors: ReadonlyMap<string, IntegerRange>,
  eligible: (localId: string) => boolean,
  integral: (localId: string) => boolean,
  proven: (e: IrExpr) => boolean,
): ProvenLoopPlan | null {
  if (cursors.size === 0) return null;
  const writes = new Map<string, IrStmt[]>();
  const increments = new Map<string, IrExpr[]>();
  const refused = new Set<string>();
  let rejected = false;
  const expr = (e: IrExpr): boolean => {
    // Every value a cursor holds in the loop lies in its loop range, so an
    // increment of one writes an integer of that range.
    if (e.kind === "incDec" && cursors.has(e.localId)) {
      const list = increments.get(e.localId) ?? [];
      list.push(e);
      increments.set(e.localId, list);
    } else if (e.kind === "assignExpr" || e.kind === "incDec") refused.add(e.localId);
    return everyExprChild(e, expr, nested);
  };
  const nested = (s: IrStmt): boolean => {
    if (s.kind === "assign" || s.kind === "varDecl") refused.add(s.localId);
    return everyStmtChild(s, expr, nested);
  };
  const stmt = (s: IrStmt): boolean => {
    if (rejected) return false;
    if (
      !SIMPLE_STATEMENTS.has(s.kind) ||
      ((s.kind === "break" || s.kind === "continue") && s.label !== undefined)
    ) {
      rejected = true;
      return false;
    }
    const target = s.kind === "varDecl" ? null : speculativeWriteTarget(s);
    if (target) {
      if (target.value !== null && cursors.has(target.localId)) {
        const list = writes.get(target.localId) ?? [];
        list.push(s);
        writes.set(target.localId, list);
      } else refused.add(target.localId);
      return target.value === null || expr(target.value);
    }
    if (s.kind === "varDecl") refused.add(s.localId);
    return everyStmtChild(s, expr, stmt);
  };
  if (loop.cond) expr(loop.cond);
  if (loop.kind === "for" && loop.update) nested(loop.update);
  for (const s of loop.body) stmt(s);
  if (rejected) return null;
  const locals = new Map<string, IntegerRange>();
  for (const id of new Set([...writes.keys(), ...increments.keys()])) {
    if (refused.has(id) || !eligible(id)) continue;
    const exact =
      (writes.get(id) ?? []).every((s) => {
        const value = speculativeWriteTarget(s)!.value!;
        return isSpeculableValue(value, false) && proven(value);
      }) && (increments.get(id) ?? []).every(proven);
    if (exact) locals.set(id, cursors.get(id)!);
  }
  // Every binding a shadowed write reads is shadowed, already an integer,
  // or proven integral where it is read.
  const grounded = (e: IrExpr): boolean =>
    e.kind === "varRef"
      ? locals.has(e.localId) || integral(e.localId) || proven(e)
      : everyExprChild(e, grounded, () => false);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...locals.keys()])
      if (!(writes.get(id) ?? []).every((s) => grounded(speculativeWriteTarget(s)!.value!))) {
        locals.delete(id);
        changed = true;
      }
  }
  if (locals.size === 0) return null;
  const planned = new Set<IrStmt>();
  const plannedIncrements = new Set<IrExpr>();
  for (const id of locals.keys()) {
    for (const s of writes.get(id) ?? []) planned.add(s);
    for (const e of increments.get(id) ?? []) plannedIncrements.add(e);
  }
  return { locals, writes: planned, increments: plannedIncrements };
}

const SAFE = Number.MAX_SAFE_INTEGER;

/** The range every speculative shadow holds. */
export const SPECULATIVE_RANGE = { min: -SAFE, max: SAFE };

/** Convert a double to i64 and test that it is a safe integer other than
 * -0: the ordered range tests reject NaN and infinities, and the bit
 * patterns of the value and its round trip agree only for integers that are
 * not -0. `freeze` keeps out-of-range conversions from producing poison. */
export function emitSafeIntegerCheck(host: LlvmEmitterContext, value: string): [string, string] {
  const B = host.B;
  const low = B.tmp(),
    high = B.tmp(),
    inRange = B.tmp(),
    raw = B.tmp(),
    integer = B.tmp(),
    back = B.tmp(),
    bits = B.tmp(),
    backBits = B.tmp(),
    exact = B.tmp(),
    ok = B.tmp();
  B.line(`${low} = fcmp oge double ${value}, ${f64Lit(-SAFE)}`);
  B.line(`${high} = fcmp ole double ${value}, ${f64Lit(SAFE)}`);
  B.line(`${inRange} = and i1 ${low}, ${high}`);
  B.line(`${raw} = fptosi double ${value} to i64`);
  B.line(`${integer} = freeze i64 ${raw}`);
  B.line(`${back} = sitofp i64 ${integer} to double`);
  B.line(`${bits} = bitcast double ${value} to i64`);
  B.line(`${backBits} = bitcast double ${back} to i64`);
  B.line(`${exact} = icmp eq i64 ${bits}, ${backBits}`);
  B.line(`${ok} = and i1 ${inRange}, ${exact}`);
  return [integer, ok];
}

/** A condition that is true when an i64 lies outside the safe range. */
function unsafeInteger(host: LlvmEmitterContext, value: string): string {
  const B = host.B;
  const biased = B.tmp(),
    outside = B.tmp();
  B.line(`${biased} = add i64 ${value}, ${SAFE}`);
  B.line(`${outside} = icmp ugt i64 ${biased}, ${2 * SAFE}`);
  return outside;
}

/** A condition that is true when a safe i64 lies outside [low, high]. Every
 * speculative value is within ±(2^53 - 1), so bounds at or past those
 * limits need no test, and the remaining bounds are exact integers. */
function outsideRange(host: LlvmEmitterContext, value: string, low: number, high: number): string {
  const B = host.B;
  let outside = "false";
  if (low > -SAFE) {
    outside = B.tmp();
    B.line(`${outside} = icmp slt i64 ${value}, ${low}`);
  }
  if (high < SAFE) {
    const above = B.tmp();
    B.line(`${above} = icmp sgt i64 ${value}, ${high}`);
    outside = outside === "false" ? above : either(host, outside, above);
  }
  return outside;
}

/** A literal's value or the range analysis' proof for an expression whose
 * range lies well inside the safe integers. */
function staticRange(
  host: LlvmEmitterContext,
  e: IrExpr,
): { min: number; max: number } | undefined {
  const range = e.kind === "numLit" ? { min: e.value, max: e.value } : host.integerRanges.get(e);
  if (!range) return undefined;
  const limit = 2 ** 52;
  return range.min >= -limit && range.max <= limit ? range : undefined;
}

function either(host: LlvmEmitterContext, a: string, b: string): string {
  const t = host.B.tmp();
  host.B.line(`${t} = or i1 ${a}, ${b}`);
  return t;
}

/** Evaluate a speculable value (isSpeculableValue) as a safe i64. `bail`
 * branches away when its condition holds, so the integer result equals the
 * JS number exactly whenever control continues: sums and products stay
 * within 2^53 - 1, no result is -0, and `%` never divides by zero. Other
 * operators evaluate through the ordinary emitter and must yield a safe
 * integer. */
export function emitSpeculativeInteger(
  host: LlvmEmitterContext,
  e: IrExpr,
  bail: (condition: string) => void,
  reads: ReadonlyMap<IrExpr, LlValue> = new Map(),
  integral = false,
): string {
  const B = host.B;
  // A value the range analysis already proves takes the ordinary integer
  // emission, which needs no checks. A proven integer loop's write
  // (`integral`) is proven throughout and computes its operands as integers
  // instead: the ordinary emission of a sum past int32 is a double.
  const proven = e.kind === "bin" && !integral ? host.integerRanges.get(e) : undefined;
  if (proven && proven.min >= -SAFE && proven.max <= SAFE && speculativeReads(e).length === 0)
    return speculativeLeaf(host, host.emitExpr(e), e, bail);
  switch (e.kind) {
    case "numLit":
      return String(e.value);
    case "varRef": {
      const slot = host.integerLoopBindings.get(e.localId);
      if (slot !== undefined) {
        const value = B.tmp();
        B.line(`${value} = load ${slot.type}, ptr ${slot.slot}`);
        if (slot.type === "i64") return value;
        const wide = B.tmp();
        B.line(`${wide} = ${slot.signed ? "sext" : "zext"} i32 ${value} to i64`);
        return wide;
      }
      const int32 = host.int32Locals.get(e.localId);
      if (int32 !== undefined) {
        const bits = B.tmp(),
          wide = B.tmp();
        B.line(`${bits} = load i32, ptr ${host.binding(e.localId).slot}`);
        B.line(`${wide} = ${int32.signed ? "sext" : "zext"} i32 ${bits} to i64`);
        return wide;
      }
      break;
    }
    case "bin": {
      if (e.op !== "+" && e.op !== "-" && e.op !== "*" && e.op !== "%") break;
      // The floor-mod of a safe integer by 2^n (n in [0, 52]) is its low n
      // bits, also for a negative value: in [0, 2^n), and never -0.
      const mod = floorModPowerOfTwo(e);
      if (mod) {
        const value = emitSpeculativeInteger(host, mod.value, bail, reads, integral);
        const n = exponentOf(host, mod.power, bail, reads, integral);
        const mask = B.tmp(),
          low = B.tmp();
        B.line(`${mask} = sub i64 ${shiftOne(host, n)}, 1`);
        B.line(`${low} = and i64 ${value}, ${mask}`);
        return low;
      }
      // A product with 2^n shifts: it is safe iff the other factor's
      // magnitude is at most (2^53 - 1) >> n, and a zero product of a safe
      // integer and a positive power is +0.
      if (e.op === "*" && (powerOfTwo(e.right) || powerOfTwo(e.left))) {
        const [factor, power] = powerOfTwo(e.right) ? [e.left, e.right] : [e.right, e.left];
        const value = emitSpeculativeInteger(host, factor, bail, reads, integral);
        const n = exponentOf(host, power, bail, reads, integral);
        const limit = B.tmp(),
          magnitude = B.tmp(),
          outside = B.tmp(),
          product = B.tmp();
        B.line(`${limit} = ashr i64 ${SAFE}, ${n}`);
        host.declare("declare i64 @llvm.abs.i64(i64, i1)");
        B.line(`${magnitude} = call i64 @llvm.abs.i64(i64 ${value}, i1 true)`);
        B.line(`${outside} = icmp ugt i64 ${magnitude}, ${limit}`);
        bail(outside);
        B.line(`${product} = shl nsw i64 ${value}, ${n}`);
        return product;
      }
      const a = emitSpeculativeInteger(host, e.left, bail, reads, integral);
      const b = emitSpeculativeInteger(host, e.right, bail, reads, integral);
      const result = B.tmp();
      if (e.op === "+" || e.op === "-") {
        // With one operand's range known, the other is checked against the
        // narrowed bounds before the operation: the check then depends on
        // no new value, and LLVM keeps the operation itself simple.
        const right = staticRange(host, e.right);
        const left = e.op === "+" ? staticRange(host, e.left) : undefined;
        if (right) {
          // a + b with b in [lo, hi] is safe iff a in [-SAFE - lo, SAFE - hi];
          // a - b iff a in [-SAFE + hi, SAFE + lo].
          const low = e.op === "+" ? -SAFE - right.min : -SAFE + right.max;
          const high = e.op === "+" ? SAFE - right.max : SAFE + right.min;
          bail(outsideRange(host, a, low, high));
        } else if (left) bail(outsideRange(host, b, -SAFE - left.min, SAFE - left.max));
        // Safe operands cannot overflow i64; an exact zero sum is +0.
        B.line(`${result} = ${e.op === "+" ? "add" : "sub"} nsw i64 ${a}, ${b}`);
        if (!right && !left) bail(unsafeInteger(host, result));
        return result;
      }
      if (e.op === "*") {
        host.declare("declare { i64, i1 } @llvm.smul.with.overflow.i64(i64, i64)");
        const pair = B.tmp(),
          overflow = B.tmp(),
          zero = B.tmp(),
          signs = B.tmp(),
          negative = B.tmp(),
          negativeZero = B.tmp();
        B.line(`${pair} = call { i64, i1 } @llvm.smul.with.overflow.i64(i64 ${a}, i64 ${b})`);
        B.line(`${result} = extractvalue { i64, i1 } ${pair}, 0`);
        B.line(`${overflow} = extractvalue { i64, i1 } ${pair}, 1`);
        // A zero product with a negative factor is -0.
        B.line(`${zero} = icmp eq i64 ${result}, 0`);
        B.line(`${signs} = or i64 ${a}, ${b}`);
        B.line(`${negative} = icmp slt i64 ${signs}, 0`);
        B.line(`${negativeZero} = and i1 ${zero}, ${negative}`);
        bail(either(host, either(host, overflow, unsafeInteger(host, result)), negativeZero));
        return result;
      }
      // `%`: a zero divisor yields NaN, and a zero remainder of a negative
      // dividend is -0. Safe operands cannot hit INT64_MIN % -1.
      const zeroDivisor = B.tmp();
      B.line(`${zeroDivisor} = icmp eq i64 ${b}, 0`);
      bail(zeroDivisor);
      const zero = B.tmp(),
        negative = B.tmp(),
        negativeZero = B.tmp();
      B.line(`${result} = srem i64 ${a}, ${b}`);
      B.line(`${zero} = icmp eq i64 ${result}, 0`);
      B.line(`${negative} = icmp slt i64 ${a}, 0`);
      B.line(`${negativeZero} = and i1 ${zero}, ${negative}`);
      bail(negativeZero);
      return result;
    }
    case "libCall": {
      // A rewritten value's Math.pow(2, n) and Math.floor(a / 2^n)
      // (rewriteSpeculable): with n an integer in [0, 52], 2^n is exact and
      // so is a / 2^n for a safe integer a, whose floor the arithmetic shift
      // computes, also for negative a. No result is -0.
      if (e.fn === "math.pow") return shiftOne(host, exponentOf(host, e, bail, reads, integral));
      if (e.fn !== "math.floor" || e.args[0]?.kind !== "bin") break;
      const a = emitSpeculativeInteger(host, e.args[0].left, bail, reads, integral);
      const n = exponentOf(host, e.args[0].right, bail, reads, integral);
      const result = B.tmp();
      B.line(`${result} = ashr i64 ${a}, ${n}`);
      return result;
    }
    case "unary": {
      if (e.op !== "-") break;
      const a = emitSpeculativeInteger(host, e.operand, bail, reads, integral);
      const zero = B.tmp(),
        result = B.tmp();
      // -0 is not an integer result.
      B.line(`${zero} = icmp eq i64 ${a}, 0`);
      bail(zero);
      B.line(`${result} = sub nsw i64 0, ${a}`);
      return result;
    }
    default:
      break;
  }
  return speculativeLeaf(host, reads.get(e) ?? host.emitExpr(e), e, bail);
}

/** The exponent of a power of two (Math.pow(2, n) or a literal 2^k) as an
 * i64 in [0, 52]; other exponents bail. */
function exponentOf(
  host: LlvmEmitterContext,
  e: IrExpr,
  bail: (condition: string) => void,
  reads: ReadonlyMap<IrExpr, LlValue>,
  integral: boolean,
): string {
  if (e.kind === "numLit") {
    const k = exactPowerOfTwo(e.value);
    if (k === null) throw new InternalCompilerError("llvm emitter bug: speculative power of two");
    return String(k);
  }
  if (e.kind !== "libCall")
    throw new InternalCompilerError("llvm emitter bug: speculative power of two");
  const n = emitSpeculativeInteger(host, e.args[1]!, bail, reads, integral);
  const outside = host.B.tmp();
  host.B.line(`${outside} = icmp ugt i64 ${n}, 52`);
  bail(outside);
  return n;
}

function shiftOne(host: LlvmEmitterContext, n: string): string {
  const result = host.B.tmp();
  host.B.line(`${result} = shl i64 1, ${n}`);
  return result;
}

/** The safe i64 of an evaluated number: its proven integer, or a checked
 * conversion. */
function speculativeLeaf(
  host: LlvmEmitterContext,
  value: LlValue,
  e: IrExpr,
  bail: (condition: string) => void,
): string {
  const integer = exactInteger(host, value, e);
  if (integer && integer.type === "i64" && withinInt32(integer.range)) {
    // Only the low half is used, as by a double conversion of an int32:
    // LLVM then narrows the operation that produced it (a 64-bit remainder
    // by a constant costs a wide multiply).
    const narrow = host.B.tmp(),
      wide = host.B.tmp();
    host.B.line(`${narrow} = trunc i64 ${integer.name} to i32`);
    host.B.line(`${wide} = sext i32 ${narrow} to i64`);
    return wide;
  }
  if (integer && integer.range.min >= -SAFE && integer.range.max <= SAFE)
    return widenInteger(host, integer);
  const [wide, ok] = emitSafeIntegerCheck(host, value.name);
  const fail = host.B.tmp();
  host.B.line(`${fail} = xor i1 ${ok}, true`);
  bail(fail);
  return wide;
}
