import { createHash } from "node:crypto";
import { InternalCompilerError } from "../../errors.js";
import type { IrExpr, IrStmt } from "../../ir/ir.js";
import { exactInteger, widenInteger } from "./integer-values.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { f64Lit } from "./common.js";

type BytesSet = Extract<IrStmt, { kind: "bytesSet" }>;

/** An if/else-if chain that stores one of several numeric literals to the
 * same typed-array element, choosing it by comparing one number local with
 * integer literals:
 *
 *     if (x === 97) a[i] = 0; else if (x === 116) a[i] = 1; ... else a[i] = 3;
 *
 * The chain is emitted as one store of a value read from a constant table,
 * with no branch on the comparisons. Branches on unpredictable input (the
 * bases of a DNA sequence, the bytes of a text) mispredict about half the
 * time; LLVM keeps them, because sparse cases (97, 99, 116) are too far
 * apart for its own switch tables. */
export interface ConstantChoice {
  subject: IrExpr;
  /** The first arm for each distinct value, in chain order. */
  cases: readonly { value: number; result: number }[];
  fallback: number;
  /** Every arm's store, the final else's last. */
  stores: readonly BytesSet[];
}

/** At least this many distinct values: shorter chains predict as well as a
 * table load. */
const MIN_CASES = 3;
/** The table covers the subject's values from the smallest case (or the
 * subject's proven minimum) up to this many entries. */
const MAX_TABLE = 256;

function integerLiteral(expr: IrExpr): number | null {
  if (expr.kind !== "numLit" || !Number.isSafeInteger(expr.value)) return null;
  // `x === -0` and `x === 0` select the same values.
  return expr.value === 0 ? 0 : expr.value;
}

function sameVarRef(a: IrExpr, b: IrExpr): boolean {
  return a.kind === "varRef" && b.kind === "varRef" && a.localId === b.localId;
}

/** A local read or a number literal: reading it has no effect. */
function sameOperand(a: IrExpr, b: IrExpr): boolean {
  if (a.kind === "numLit" && b.kind === "numLit") return Object.is(a.value, b.value);
  return sameVarRef(a, b);
}

/** The store of a single-statement arm, when it stores a number literal to
 * an element named by a local and a local or a literal index (so evaluating
 * them once, after the comparisons, reads what every arm would). */
function literalStore(body: readonly IrStmt[] | null): BytesSet | null {
  if (body === null || body.length !== 1) return null;
  const s = body[0]!;
  if (s.kind !== "bytesSet" || s.value.kind !== "numLit") return null;
  if (s.arr.kind !== "varRef" || (s.index.kind !== "varRef" && s.index.kind !== "numLit"))
    return null;
  if (s.arr.type.kind !== "bytes" || s.index.type.kind !== "f64") return null;
  return s;
}

export function matchConstantChoice(s: IrStmt): ConstantChoice | null {
  if (s.kind !== "if") return null;
  let subject: IrExpr | null = null;
  const cases: { value: number; result: number }[] = [];
  const seen = new Set<number>();
  const stores: BytesSet[] = [];
  let current: IrStmt = s;
  for (;;) {
    if (current.kind !== "if") return null;
    const cond = current.cond;
    if (cond.kind !== "bin" || cond.op !== "===") return null;
    const [local, literal] =
      cond.left.kind === "varRef" ? [cond.left, cond.right] : [cond.right, cond.left];
    if (local.kind !== "varRef" || local.type.kind !== "f64") return null;
    if (subject === null) subject = local;
    else if (!sameVarRef(subject, local)) return null;
    const value = integerLiteral(literal);
    if (value === null) return null;
    const store = literalStore(current.then);
    if (store === null) return null;
    stores.push(store);
    // A repeated value never reaches its later arm.
    if (!seen.has(value)) {
      seen.add(value);
      cases.push({ value, result: (store.value as IrExpr & { kind: "numLit" }).value });
    }
    const rest: readonly IrStmt[] | null = current.else_;
    if (rest === null || rest.length !== 1) return null;
    if (rest[0]!.kind === "if") {
      current = rest[0]!;
      continue;
    }
    const last = literalStore(rest);
    if (last === null) return null;
    stores.push(last);
    break;
  }
  const first = stores[0]!;
  for (const store of stores) {
    if (!sameVarRef(store.arr, first.arr) || !sameOperand(store.index, first.index)) return null;
    if (store.arr.type.kind !== "bytes" || first.arr.type.kind !== "bytes") return null;
    if (store.arr.type.elem !== first.arr.type.elem) return null;
  }
  if (cases.length < MIN_CASES) return null;
  const values = cases.map((c) => c.value);
  if (Math.max(...values) - Math.min(...values) >= MAX_TABLE) return null;
  const fallback = (stores[stores.length - 1]!.value as IrExpr & { kind: "numLit" }).value;
  return { subject: subject!, cases, fallback, stores };
}

function int32(value: number): boolean {
  return (
    Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 && !Object.is(value, -0)
  );
}

/** The chosen number: the table entry for the subject's value, or the final
 * else's literal for a value no case names (including NaN, a fraction and
 * every value outside the table). */
function emitChoice(host: LlvmEmitterContext, choice: ConstantChoice): LlValue {
  const B = host.B;
  const subject = host.emitExpr(choice.subject);
  const results = [...choice.cases.map((c) => c.result), choice.fallback];
  const integral = results.every(int32);
  const element = integral ? "i32" : "double";
  const literal = (value: number): string => (integral ? String(value) : f64Lit(value));

  const proven = exactInteger(host, subject, choice.subject);
  const values = choice.cases.map((c) => c.value);
  let low = Math.min(...values);
  let high = Math.max(...values);
  // A proven range that fits a table needs no test: every value it allows
  // has an entry.
  const covered =
    proven !== null && proven.range.max - proven.range.min < MAX_TABLE ? proven : null;
  if (covered !== null) {
    low = covered.range.min;
    high = covered.range.max;
  }
  const size = high - low + 1;
  const entries: string[] = [];
  for (let value = low; value <= high; value++) {
    const hit = choice.cases.find((c) => c.value === value);
    entries.push(`${element} ${literal(hit === undefined ? choice.fallback : hit.result)}`);
  }
  const table = `@sc_choice_${createHash("sha256")
    .update(`${element}:${entries.join(",")}`)
    .digest("hex")
    .slice(0, 16)}`;
  host.declare(
    `${table} = private unnamed_addr constant [${size} x ${element}] [${entries.join(", ")}]`,
  );

  let index: string;
  let ok: string | null = null;
  if (covered !== null) {
    const wide = widenInteger(host, covered);
    index = B.tmp();
    B.line(`${index} = sub i64 ${wide}, ${low}`);
  } else {
    // freeze keeps NaN and out-of-range conversions from producing poison;
    // the round trip then rejects every value that is not an exact integer
    // (-0 converts to 0, which `=== 0` selects too).
    const raw = B.tmp();
    const selector = B.tmp();
    const restored = B.tmp();
    const exact = B.tmp();
    const offset = B.tmp();
    const inside = B.tmp();
    ok = B.tmp();
    index = B.tmp();
    B.line(`${raw} = fptosi double ${subject.name} to i64`);
    B.line(`${selector} = freeze i64 ${raw}`);
    B.line(`${restored} = sitofp i64 ${selector} to double`);
    B.line(`${exact} = fcmp oeq double ${subject.name}, ${restored}`);
    B.line(`${offset} = sub i64 ${selector}, ${low}`);
    B.line(`${inside} = icmp ult i64 ${offset}, ${size}`);
    B.line(`${ok} = and i1 ${exact}, ${inside}`);
    B.line(`${index} = select i1 ${ok}, i64 ${offset}, i64 0`);
  }
  const slot = B.tmp();
  const entry = B.tmp();
  B.line(
    `${slot} = getelementptr inbounds [${size} x ${element}], ptr ${table}, i64 0, i64 ${index}`,
  );
  B.line(`${entry} = load ${element}, ptr ${slot}`);
  let chosen = entry;
  if (ok !== null) {
    chosen = B.tmp();
    B.line(
      `${chosen} = select i1 ${ok}, ${element} ${entry}, ${element} ${literal(choice.fallback)}`,
    );
  }
  if (!integral) return { name: chosen, type: choice.stores[0]!.value.type };
  const number = B.tmp();
  B.line(`${number} = sitofp i32 ${chosen} to double`);
  return {
    name: number,
    type: choice.stores[0]!.value.type,
    uint32: chosen,
    integer: {
      name: chosen,
      type: "i32",
      signed: Math.min(...results) < 0,
      range: { min: Math.min(...results), max: Math.max(...results) },
    },
  };
}

/** Emits a matched chain as one store of the chosen literal. The element
 * write is the arms' own: every arm names the same receiver and index. */
export function emitConstantChoice(host: LlvmEmitterContext, choice: ConstantChoice): void {
  const first = choice.stores[0]!;
  if (first.arr.type.kind !== "bytes")
    throw new InternalCompilerError("llvm emitter bug: constant choice on non-bytes");
  // An arm's index carries the ranges proven inside that arm: an index that
  // is the compared local holds the arm's value there. The one store runs
  // for every value, so such an index reads the local through the first
  // comparison's operand, whose range holds before the chain branches.
  const indexExpr = sameVarRef(first.index, choice.subject) ? choice.subject : first.index;
  const arr = host.emitStableReceiver(first.arr, [indexExpr]);
  const index = host.emitExpr(indexExpr);
  const value = emitChoice(host, choice);
  const scopes = choice.stores.map((store) => host.bytesAliasScopes.get(store));
  host.emitBytesSet(
    first.arr.type.elem,
    arr.name,
    index,
    value,
    indexExpr,
    undefined,
    choice.stores.every((store) => host.bytesBounds.has(store)),
    choice.stores.every((store) => host.bytesOwned.has(store)),
    scopes.every((scope) => scope === scopes[0]) ? (scopes[0] ?? "") : "",
  );
}
