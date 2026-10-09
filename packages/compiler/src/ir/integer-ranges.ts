import type { IrExpr, IrFunction, IrStmt } from "./ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "./traverse.js";
import { byteNumberAccess, byteNumberRange } from "./byte-numbers.js";
import { boundedIntegerLoopFacts, integerPathFallsThrough } from "./integer-loop-facts.js";

/** Exactly representable integers, excluding negative zero. Facts describe
 * the evaluated value, never a later read of the same local binding. */
export interface IntegerRange {
  min: number;
  max: number;
}
export type IntegerRanges = ReadonlyMap<IrExpr, IntegerRange | null>;
const SIGNED: IntegerRange = { min: -2147483648, max: 2147483647 };
const UNSIGNED: IntegerRange = { min: 0, max: 4294967295 };
const EXACT_LIMIT = 2 ** 53;
type Facts = Map<string, IntegerRange>;

function union(left: IntegerRange, right: IntegerRange): IntegerRange {
  return { min: Math.min(left.min, right.min), max: Math.max(left.max, right.max) };
}
function merge(into: Facts, left: Facts, right: Facts): void {
  into.clear();
  for (const [id, value] of left) {
    const other = right.get(id);
    if (other) into.set(id, union(value, other));
  }
}
export function integerArithmeticRange(
  op: string,
  left: IntegerRange,
  right: IntegerRange,
): IntegerRange | null {
  let min: number;
  let max: number;
  if (op === "+") {
    min = left.min + right.min;
    max = left.max + right.max;
  } else if (op === "-") {
    min = left.min - right.max;
    max = left.max - right.min;
  } else if (op === "*") {
    if (
      (left.min <= 0 && left.max >= 0 && right.min < 0) ||
      (right.min <= 0 && right.max >= 0 && left.min < 0)
    )
      return null;
    const products = [
      left.min * right.min,
      left.min * right.max,
      left.max * right.min,
      left.max * right.max,
    ];
    min = Math.min(...products);
    max = Math.max(...products);
  } else if (op === "%" && left.min >= 0 && right.min > 0) {
    return { min: 0, max: Math.min(left.max, right.max - 1) };
  } else return null;
  return Number.isSafeInteger(min) && Number.isSafeInteger(max) ? { min, max } : null;
}

/** Structured local dataflow. Calls cannot write uncaptured local slots,
 * but argument expressions can; unknown evaluation forms invalidate all
 * syntactically written slots before their children are inspected. Loops
 * discard loop-carried facts and retain only invariant or induction facts.
 * Suspensions and captured bindings deliberately remain outside the proof. */
export function analyzeIntegerRanges(fn: IrFunction): IntegerRanges {
  const ranges = new Map<IrExpr, IntegerRange | null>();
  if (fn.async || fn.generator) return ranges;
  const captures = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  const eligible = new Set(
    fn.locals
      .filter((l) => l.type.kind === "f64" && !l.boxed && !l.tdz && !captures.has(l.id))
      .map((l) => l.id),
  );
  const loopLocals = new Map(fn.locals.filter((l) => !captures.has(l.id)).map((l) => [l.id, l]));

  function remember(e: IrExpr, range: IntegerRange | null): IntegerRange | null {
    // Shared IR objects have to satisfy the proof at every occurrence.
    const previous = ranges.get(e);
    ranges.set(
      e,
      previous === undefined ? range : previous && range ? union(previous, range) : null,
    );
    return range;
  }
  function set(facts: Facts, id: string, range: IntegerRange | null): void {
    if (range && eligible.has(id)) facts.set(id, range);
    else facts.delete(id);
  }
  function writes(node: IrExpr | IrStmt): Set<string> {
    const result = new Set<string>();
    const e = (value: IrExpr): boolean => {
      if (value.kind === "assignExpr" || value.kind === "incDec") result.add(value.localId);
      return true;
    };
    const s = (value: IrStmt): boolean => {
      if (value.kind === "assign" || value.kind === "varDecl" || value.kind === "forOf")
        result.add(value.localId);
      if (value.kind === "tryCatch" && value.catchLocalId) result.add(value.catchLocalId);
      return true;
    };
    const walkExpr = (value: IrExpr): boolean =>
      e(value) && everyExprChild(value, walkExpr, walkStmt);
    const walkStmt = (value: IrStmt): boolean =>
      s(value) && everyStmtChild(value, walkExpr, walkStmt);
    if ("type" in node) walkExpr(node as IrExpr);
    else walkStmt(node as IrStmt);
    return result;
  }
  function invalidate(facts: Facts, nodes: (IrExpr | IrStmt)[]): void {
    for (const node of nodes) for (const id of writes(node)) facts.delete(id);
  }
  function refine(condition: IrExpr, truth: boolean, facts: Facts): void {
    // A comparison constrains operand snapshots. If evaluating it writes a
    // binding, the current slot may no longer contain the compared value.
    if (writes(condition).size > 0) return;
    if (condition.kind === "toBool") return refine(condition.operand, truth, facts);
    if (condition.kind === "unary" && condition.op === "!")
      return refine(condition.operand, !truth, facts);
    if (
      condition.kind === "logical" &&
      ((condition.op === "&&" && truth) || (condition.op === "||" && !truth))
    ) {
      refine(condition.left, truth, facts);
      refine(condition.right, truth, facts);
      return;
    }
    if (condition.kind !== "bin") return;
    let ref = condition.left;
    let bound = condition.right;
    let op: string = condition.op;
    if (ref.kind !== "varRef" && bound.kind === "varRef") {
      [ref, bound] = [bound, ref];
      op =
        (
          { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "===": "===", "!==": "!==" } as Record<
            string,
            string
          >
        )[op] ?? "";
    }
    if (ref.kind !== "varRef") return;
    const boundRange =
      bound.kind === "numLit" && Number.isFinite(bound.value)
        ? { min: bound.value, max: bound.value }
        : ranges.get(bound);
    if (!boundRange) return;
    const previous = facts.get(ref.localId);
    if (!previous) return;
    if (!truth)
      op =
        (
          { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "===": "!==", "!==": "===" } as Record<
            string,
            string
          >
        )[op] ?? "";
    let { min, max } = previous;
    if (op === "<") max = Math.min(max, Math.ceil(boundRange.max) - 1);
    else if (op === "<=") max = Math.min(max, Math.floor(boundRange.max));
    else if (op === ">") min = Math.max(min, Math.floor(boundRange.min) + 1);
    else if (op === ">=") min = Math.max(min, Math.ceil(boundRange.min));
    else if (op === "===") {
      min = Math.max(min, boundRange.min);
      max = Math.min(max, boundRange.max);
    }
    if (min <= max && Number.isInteger(min) && Number.isInteger(max))
      facts.set(ref.localId, { min, max });
  }
  function expr(e: IrExpr, facts: Facts): IntegerRange | null {
    let range: IntegerRange | null = null;
    switch (e.kind) {
      case "numLit":
        if (Number.isSafeInteger(e.value) && !Object.is(e.value, -0))
          range = { min: e.value, max: e.value };
        break;
      case "varRef":
        range = facts.get(e.localId) ?? null;
        break;
      case "assignExpr":
        range = expr(e.value, facts);
        set(facts, e.localId, range);
        break;
      case "incDec": {
        const before = facts.get(e.localId) ?? null;
        const after = before ? integerArithmeticRange(e.op, before, { min: 1, max: 1 }) : null;
        set(facts, e.localId, after);
        range = e.prefix ? after : before;
        break;
      }
      case "bin": {
        const left = expr(e.left, facts);
        const right = expr(e.right, facts);
        if (e.type.kind !== "f64") break;
        if (e.op === ">>>") {
          const shift = e.right.kind === "numLit" ? e.right.value & 31 : 0;
          range = { min: 0, max: 4294967295 >>> shift };
        } else if (e.op === "&") {
          const mask =
            e.left.kind === "numLit"
              ? e.left.value | 0
              : e.right.kind === "numLit"
                ? e.right.value | 0
                : -1;
          range = mask >= 0 ? { min: 0, max: mask } : SIGNED;
        } else if (e.op === "|" || e.op === "^" || e.op === "<<" || e.op === ">>") range = SIGNED;
        else if (left && right) range = integerArithmeticRange(e.op, left, right);
        break;
      }
      case "unary": {
        const operand = expr(e.operand, facts);
        if (e.op === "~") range = SIGNED;
        else if (e.op === "-" && operand && (operand.max < 0 || operand.min > 0))
          range = { min: -operand.max, max: -operand.min };
        break;
      }
      case "ternary": {
        expr(e.cond, facts);
        const yes = new Map(facts),
          no = new Map(facts);
        refine(e.cond, true, yes);
        refine(e.cond, false, no);
        const left = expr(e.then, yes),
          right = expr(e.else_, no);
        merge(facts, yes, no);
        if (left && right) range = union(left, right);
        break;
      }
      case "logical": {
        const left = expr(e.left, facts);
        const skipped = new Map(facts),
          evaluated = new Map(facts);
        refine(e.left, e.op === "&&", evaluated);
        const right = expr(e.right, evaluated);
        merge(facts, skipped, evaluated);
        if (left && right) range = union(left, right);
        break;
      }
      case "seqExpr":
        body(e.stmts, facts);
        range = expr(e.result, facts);
        break;
      case "libCall": {
        const args = e.args.map((a) => expr(a, facts));
        if (e.fn === "math.imul") range = SIGNED;
        else if (e.fn === "math.clz32") range = { min: 0, max: 32 };
        else if (
          (e.fn === "math.min" || e.fn === "math.max") &&
          args.length > 0 &&
          args.every((a) => a !== null)
        ) {
          const known = args as IntegerRange[];
          const mins = known.map((a) => a.min),
            maxes = known.map((a) => a.max);
          range =
            e.fn === "math.min"
              ? { min: Math.min(...mins), max: Math.min(...maxes) }
              : { min: Math.max(...mins), max: Math.max(...maxes) };
        }
        break;
      }
      case "bytesIntrinsic": {
        expr(e.receiver, facts);
        for (const arg of e.args) expr(arg, facts);
        const numeric = byteNumberAccess(e);
        if (numeric && !numeric.write) range = byteNumberRange(numeric);
        else if (e.method === "length" || e.method === "byteLength" || e.method === "byteOffset")
          range = { min: 0, max: Number.MAX_SAFE_INTEGER };
        else if (e.method === "get" && e.invalidNaN !== true && e.receiver.type.kind === "bytes") {
          const elem = e.receiver.type.elem;
          if (elem === "u8" || elem === "u8c") range = { min: 0, max: 255 };
          else if (elem === "i8") range = { min: -128, max: 127 };
          else if (elem === "u16") range = { min: 0, max: 65535 };
          else if (elem === "i16") range = { min: -32768, max: 32767 };
          else if (elem === "u32") range = UNSIGNED;
          else if (elem === "i32") range = SIGNED;
        }
        break;
      }
      case "arrIntrinsic":
        // Callbacks and arguments can have writes hidden in lazy lowering.
        invalidate(facts, [e]);
        everyExprChild(
          e,
          (child) => {
            expr(child, new Map(facts));
            return true;
          },
          (child) => {
            body([child], new Map(facts));
            return true;
          },
        );
        if (e.method === "length") range = UNSIGNED;
        break;
      default:
        // Do not assume the traversal order is an evaluation order for an
        // unknown node. Every child gets the same conservative entry state.
        invalidate(facts, [e]);
        everyExprChild(
          e,
          (child) => {
            expr(child, new Map(facts));
            return true;
          },
          (child) => {
            body([child], new Map(facts));
            return true;
          },
        );
        break;
    }
    return remember(e, range);
  }
  function induction(
    s: IrStmt & { kind: "for" },
    facts: Facts,
  ): { id: string; range: IntegerRange } | null {
    if (s.init?.kind !== "varDecl" || !eligible.has(s.init.localId)) return null;
    const id = s.init.localId,
      start = facts.get(id);
    if (!start) return null;
    let step = 0;
    const update = s.update;
    if (
      update?.kind === "assign" &&
      update.localId === id &&
      update.value.kind === "bin" &&
      update.value.left.kind === "varRef" &&
      update.value.left.localId === id &&
      update.value.right.kind === "numLit" &&
      update.value.right.value === 1
    ) {
      step = update.value.op === "+" ? 1 : update.value.op === "-" ? -1 : 0;
    } else if (
      update?.kind === "exprStmt" &&
      update.expr.kind === "incDec" &&
      update.expr.localId === id
    )
      step = update.expr.op === "+" ? 1 : -1;
    if (!step || s.body.some((node) => writes(node).has(id)) || (s.cond && writes(s.cond).has(id)))
      return null;
    return {
      id,
      range:
        step > 0 ? { min: start.min, max: EXACT_LIMIT } : { min: -EXACT_LIMIT, max: start.max },
    };
  }
  function body(stmts: IrStmt[], facts: Facts): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "varDecl":
        case "assign": {
          const value = s.kind === "varDecl" ? s.init : s.value;
          set(facts, s.localId, value ? expr(value, facts) : null);
          break;
        }
        case "exprStmt":
          expr(s.expr, facts);
          break;
        case "return":
          if (s.value) expr(s.value, facts);
          facts.clear();
          break;
        case "block":
          body(s.body, facts);
          // A labeled break can skip the tail of this block. We have no
          // exit-edge lattice here, so discard its written facts at a join.
          if (
            !everyStmtList(s.body, {
              expr: () => true,
              stmt: (node) => node.kind !== "break" && node.kind !== "continue",
            })
          )
            invalidate(facts, s.body);
          break;
        case "if": {
          expr(s.cond, facts);
          const yes = new Map(facts),
            no = new Map(facts);
          refine(s.cond, true, yes);
          refine(s.cond, false, no);
          body(s.then, yes);
          if (s.else_) body(s.else_, no);
          if (!integerPathFallsThrough(s.then)) {
            facts.clear();
            for (const [id, range] of no) facts.set(id, range);
          } else if (s.else_ && !integerPathFallsThrough(s.else_)) {
            facts.clear();
            for (const [id, range] of yes) facts.set(id, range);
          } else merge(facts, yes, no);
          break;
        }
        case "for": {
          if (s.init) body([s.init], facts);
          const counter = induction(s, facts);
          const bounded = boundedIntegerLoopFacts(s, loopLocals, facts);
          const loop = new Map(facts);
          invalidate(loop, [
            ...s.body,
            ...(s.cond ? [s.cond] : []),
            ...(s.update ? [s.update] : []),
          ]);
          if (counter) loop.set(counter.id, counter.range);
          for (const [id, range] of bounded) loop.set(id, range);
          if (s.cond) expr(s.cond, loop);
          const inside = new Map(loop);
          if (s.cond) refine(s.cond, true, inside);
          body(s.body, inside);
          // Continue can bypass any body assignment. The update therefore
          // starts from header invariants rather than the body's exit facts.
          if (s.update) body([s.update], new Map(loop));
          invalidate(facts, [s]);
          break;
        }
        case "while":
        case "doWhile": {
          const loop = new Map(facts);
          invalidate(loop, [s]);
          const header = new Map(loop);
          expr(s.cond, header);
          if (s.kind === "while") {
            refine(s.cond, true, header);
            body(s.body, header);
          } else body(s.body, new Map(loop));
          invalidate(facts, [s]);
          break;
        }
        case "forOf": {
          expr(s.iterable, facts);
          const loop = new Map(facts);
          invalidate(loop, [s]);
          body(s.body, loop);
          invalidate(facts, [s]);
          break;
        }
        case "tryCatch":
          // Catch/finally, fallthrough and nonlocal exits need their own
          // control-flow joins. Analyze each region from invariant facts.
          invalidate(facts, [s]);
          body(s.tryBody, new Map(facts));
          if (s.catchBody) body(s.catchBody, new Map(facts));
          if (s.finallyBody) body(s.finallyBody, new Map(facts));
          break;
        case "switch":
          invalidate(facts, [s]);
          expr(s.disc, new Map(facts));
          for (const region of s.cases) {
            if (region.test) expr(region.test, new Map(facts));
            body(region.body, new Map(facts));
          }
          break;
        case "break":
        case "continue":
          // An outer labeled jump can bypass following assignments. Clearing
          // the continuing path is conservative; loop exits discard writes.
          facts.clear();
          break;
        default:
          invalidate(facts, [s]);
          everyStmtChild(
            s,
            (child) => {
              expr(child, new Map(facts));
              return true;
            },
            (child) => {
              body([child], new Map(facts));
              return true;
            },
          );
          break;
      }
    }
  }
  body(fn.body, new Map());
  return ranges;
}
