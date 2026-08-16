/* Ask 4: the integer-boundary inference — a flow-sensitive forward abstract
 * interpretation over the lowered IR that PROVES wholeness and range for
 * every value reaching a profile-declared i64/u64 boundary slot, or REFUSES
 * with the failed obligation, the observed evidence, and the author's fix.
 *
 * The two-layer model (the ask-4 reference package): Layer 1 —
 * representing provably-integer numbers as machine integers inside
 * compiled code — is an engine-style optimization this module does NOT
 * implement and nothing here constrains; semantics stay f64, byte-exact
 * to Node. Layer 2 — this module — is the boundary: a profile declares
 * specific ABI slots i64/u64 (export/helper parameters and returns,
 * message-arm payloads, record fields), and every value that can reach a
 * declared slot must discharge, at compile time:
 *
 *   1. representability — an integer literal whose SOURCE SPELLING does
 *      not round-trip f64 refuses when it flows to an integer slot (the
 *      author wrote a number the program never held); numLit.spelling is
 *      the frontend's witness, carried only for non-round-tripping
 *      decimal integer spellings and dropped by any arithmetic.
 *   2. wholeness — the value is a mathematical integer on every path
 *      (never NaN, never fractional).
 *   3. range — the proven interval fits ±(2^53 − 1), the f64
 *      exact-integer bound (integrality beyond it is unprovable because
 *      adjacent integers stop being distinguishable); u64 additionally
 *      requires a non-negative lower bound.
 *
 * Never reinterpretation, never silent truncation, never a coercion the
 * author didn't write: a proven crossing is the mathematically exact
 * integer the f64 held. One consequence decided here: -0 is a whole
 * number (the f64 spelling of integer zero) — it crosses as 0, a PROVE.
 *
 * The abstract domain is an interval over the extended reals joined with
 * a wholeness flag, a may-be-NaN flag (NaN lives OUTSIDE the interval),
 * and the literal spelling. Transfer functions implement JS semantics,
 * never idealized math: the bitwise operators' ToInt32/ToUint32 coercion
 * contract makes `x | 0` a PROOF (whole, int32 range, whatever x was —
 * NaN included); JS remainder's sign follows the dividend; the
 * Math.trunc/floor/ceil/round family discharges wholeness (not range,
 * not NaN). Branches refine BOTH compared values on BOTH edges — every
 * ordered comparison excludes NaN on its true edge, and wholeness
 * sharpens strict bounds (whole x < b ⇒ x ≤ ⌈b⌉ − 1, what lets an
 * ordinary counter loop prove a precise bound). Loop joins widen to a
 * short threshold list ONLY at loop headers, after a few plain joins;
 * precision lost to widening is recovered by the body-edge refinement,
 * so `for (let n = 0; n < 10; n = n + 1) send(n)` proves exactly [0, 9].
 * Static numeric field reads rooted at one binding carry the same guard
 * facts as locals through a straight-line dominated region, whether or
 * not the field is itself a declared integer slot. Those facts are proof
 * state only (the emitted program still performs every source read), and
 * are discarded at calls/suspensions, heap writes, receiver rebindings,
 * and control-flow joins. This is deliberately not alias analysis.
 *
 * INTERPROCEDURAL STRATEGY (v1, deliberate): intraprocedural with
 * declared-slot summaries at the boundaries. Every declared slot is both
 * an obligation and an assumption — a call ARGUMENT flowing into a
 * declared integer parameter is checked at the call site, and inside the
 * callee that parameter is SEEDED with its class's proven shape (whole,
 * class range: i64 ⇒ ±(2^53−1), u64 ⇒ [0, 2^53−1], the u8/u32/i32
 * plumbing classes their C ranges); a call RESULT of a declared integer
 * return is likewise assumed whole-in-range (its own function's returns
 * are checked). A declared RECORD FIELD works the same way: every write
 * into the field (construction or assignment, in any function) is
 * checked, and a read of the field is assumed whole-in-class-range —
 * which is what makes `count: model.count + 1` a RANGE refusal (the
 * unbounded counter may leave ±(2^53 − 1)) rather than a spurious
 * NaN complaint. External calls of the same slots are the wrapper's
 * business (inbound integer parameters range-check at the marshalled
 * edge — index.ts assembles the host-contract trap). Undeclared function
 * boundaries stay TOP — the obligations are the contract; the strategy
 * is free.
 *
 * Runs ONLY for library builds whose profile declares at least one
 * integer slot; the executable lane never calls it. */
import type {
  IrExpr,
  IrFunction,
  IrModule,
  IrNumBinOp,
  IrStmt,
  IrType,
  SrcLoc,
} from "../ir/nodes.js";

/* ── the abstract domain ────────────────────────────────────────────────── */

export const SAFE_MAX = 2 ** 53 - 1; // Number.MAX_SAFE_INTEGER
export const SAFE_MIN = -SAFE_MAX;

/** The set of f64 values a binding may hold at a program point: a closed
 * interval over the extended reals (`-0` normalized to 0 — the interval
 * tracks mathematical value; zero's sign is an f64-interior observation
 * with no boundary consequence), `whole` when every member is a finite
 * integer-valued f64, `maybeNaN` when NaN may be in the set (NaN lives
 * outside the interval, which describes only the numeric members), and
 * the integer literal's source `spelling` for the representability check
 * (propagates through copies and agreeing joins only; any arithmetic
 * drops it — a computed value is a new number, not the author's
 * literal). */
export interface AbsVal {
  lo: number;
  hi: number;
  whole: boolean;
  maybeNaN: boolean;
  spelling?: string;
}

const normZero = (x: number): number => (Object.is(x, -0) ? 0 : x);

export function absVal(lo: number, hi: number, whole: boolean, maybeNaN: boolean, spelling?: string): AbsVal {
  lo = normZero(lo);
  hi = normZero(hi);
  // Infinities are not integers: a set with a non-finite bound may
  // contain them, so the wholeness claim drops.
  if (whole && !(Number.isFinite(lo) && Number.isFinite(hi))) whole = false;
  const v: AbsVal = { lo, hi, whole, maybeNaN };
  if (spelling !== undefined) v.spelling = spelling;
  return v;
}

/** Any f64 a caller could pass — unbounded, not whole, NaN included. */
export const TOP: AbsVal = { lo: -Infinity, hi: Infinity, whole: false, maybeNaN: true };
/** The empty set (unreachable): lo > hi and no NaN. */
export const BOTTOM: AbsVal = { lo: Infinity, hi: -Infinity, whole: true, maybeNaN: false };

export const isBottom = (v: AbsVal): boolean => v.lo > v.hi && !v.maybeNaN;
export const isSingleton = (v: AbsVal): boolean => v.lo === v.hi && !v.maybeNaN;
const hasNumeric = (v: AbsVal): boolean => v.lo <= v.hi;

export function constVal(value: number, spelling?: string): AbsVal {
  if (Number.isNaN(value)) return { lo: Infinity, hi: -Infinity, whole: false, maybeNaN: true };
  return absVal(value, value, Number.isInteger(value), false, spelling);
}

/** Least upper bound: interval hull, wholeness/NaN pessimism, spelling
 * kept only when both sides carry the same one. */
export function join(a: AbsVal, b: AbsVal): AbsVal {
  if (isBottom(a)) return b;
  if (isBottom(b)) return a;
  const numA = hasNumeric(a);
  const numB = hasNumeric(b);
  const lo = numA && numB ? Math.min(a.lo, b.lo) : numA ? a.lo : b.lo;
  const hi = numA && numB ? Math.max(a.hi, b.hi) : numA ? a.hi : b.hi;
  const whole = (numA ? a.whole : true) && (numB ? b.whole : true);
  const spelling = a.spelling !== undefined && a.spelling === b.spelling ? a.spelling : undefined;
  return absVal(lo, hi, whole, a.maybeNaN || b.maybeNaN, spelling);
}

export function sameVal(a: AbsVal, b: AbsVal): boolean {
  return a.lo === b.lo && a.hi === b.hi && a.whole === b.whole && a.maybeNaN === b.maybeNaN && a.spelling === b.spelling;
}

/* Threshold widening: when a loop-header join keeps growing, jump each
 * still-moving bound to the next threshold instead of crawling one
 * iteration at a time. The thresholds are the ranges the boundary check
 * cares about, so precision is lost only past the points where the
 * verdict would change anyway. */
const WIDEN_THRESHOLDS = [0, 2 ** 31 - 1, 2 ** 32 - 1, SAFE_MAX, Infinity];
const WIDEN_THRESHOLDS_NEG = [0, -(2 ** 31), SAFE_MIN, -Infinity];

export function widen(prev: AbsVal, next: AbsVal): AbsVal {
  if (isBottom(prev)) return next;
  let lo = next.lo;
  let hi = next.hi;
  if (next.lo < prev.lo) lo = WIDEN_THRESHOLDS_NEG.find((t) => t <= next.lo) ?? -Infinity;
  if (next.hi > prev.hi) hi = WIDEN_THRESHOLDS.find((t) => t >= next.hi) ?? Infinity;
  return absVal(lo, hi, next.whole, next.maybeNaN, next.spelling);
}

/* ── transfer functions (JS semantics, never idealized math) ───────────── */

/* Endpoint product with the JS wrinkle 0 * Infinity = NaN handled for
 * BOUND purposes: as an interval bound the correct limit is 0 (the NaN is
 * the maybeNaN flag's business). */
function boundMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return a * b;
}

function transferAdd(a: AbsVal, b: AbsVal): AbsVal {
  let maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  // Infinity + -Infinity = NaN: possible when opposite infinities meet.
  if ((a.hi === Infinity && b.lo === -Infinity) || (a.lo === -Infinity && b.hi === Infinity)) maybeNaN = true;
  return absVal(a.lo + b.lo, a.hi + b.hi, a.whole && b.whole, maybeNaN);
}

function transferSub(a: AbsVal, b: AbsVal): AbsVal {
  let maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  if ((a.hi === Infinity && b.hi === Infinity) || (a.lo === -Infinity && b.lo === -Infinity)) maybeNaN = true;
  return absVal(a.lo - b.hi, a.hi - b.lo, a.whole && b.whole, maybeNaN);
}

function transferMul(a: AbsVal, b: AbsVal): AbsVal {
  let maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  // 0 * Infinity = NaN: possible when one side may be 0 and the other infinite.
  const aHasZero = a.lo <= 0 && a.hi >= 0;
  const bHasZero = b.lo <= 0 && b.hi >= 0;
  const aInf = a.lo === -Infinity || a.hi === Infinity;
  const bInf = b.lo === -Infinity || b.hi === Infinity;
  if ((aHasZero && bInf) || (bHasZero && aInf)) maybeNaN = true;
  const p = [boundMul(a.lo, b.lo), boundMul(a.lo, b.hi), boundMul(a.hi, b.lo), boundMul(a.hi, b.hi)];
  return absVal(Math.min(...p), Math.max(...p), a.whole && b.whole, maybeNaN);
}

function transferDiv(a: AbsVal, b: AbsVal): AbsVal {
  const maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  // Divisor exactly 0: x/0 is ±Infinity (sign by the dividend), 0/0 NaN.
  if (isSingleton(b) && b.lo === 0) {
    const nanPossible = maybeNaN || (a.lo <= 0 && a.hi >= 0);
    const lo = a.lo < 0 ? -Infinity : Infinity; // -Infinity reachable iff some dividend < 0
    const hi = a.hi > 0 ? Infinity : -Infinity; // +Infinity reachable iff some dividend > 0
    if (lo > hi) return { ...BOTTOM, maybeNaN: nanPossible }; // only 0/0: no numeric members
    return absVal(lo, hi, false, nanPossible);
  }
  // Divisor may be 0 among other values: give up on precision.
  if (b.lo <= 0 && b.hi >= 0) return { ...TOP };
  const q = [a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi];
  const lo = Math.min(...q);
  const hi = Math.max(...q);
  // Division does not preserve wholeness (7 / 2 = 3.5); the one provable
  // case is a singleton landing on an integer.
  return absVal(lo, hi, lo === hi && Number.isInteger(lo), maybeNaN);
}

function transferMod(a: AbsVal, b: AbsVal): AbsVal {
  let maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  // x % 0 = NaN; Infinity % y = NaN.
  if (b.lo <= 0 && b.hi >= 0) maybeNaN = true;
  if (a.lo === -Infinity || a.hi === Infinity) maybeNaN = true;
  if (isSingleton(a) && isSingleton(b) && !maybeNaN) return constVal(a.lo % b.lo);
  // JS remainder: the sign follows the DIVIDEND; |r| < |divisor|.
  const dMax = Math.max(Math.abs(b.lo), Math.abs(b.hi));
  const bound = a.whole && b.whole && Number.isFinite(dMax) ? dMax - 1 : dMax;
  const lo = a.lo < 0 ? -bound : 0;
  const hi = a.hi > 0 ? bound : 0;
  return absVal(lo, hi, a.whole && b.whole, maybeNaN);
}

function transferPow(a: AbsVal, b: AbsVal): AbsVal {
  const maybeNaN = a.maybeNaN || b.maybeNaN;
  if (!hasNumeric(a) || !hasNumeric(b)) return { ...BOTTOM, maybeNaN };
  if (isSingleton(a) && isSingleton(b) && !maybeNaN) return constVal(a.lo ** b.lo);
  // Provable without folding: whole base ≥ 1 with whole non-negative
  // exponent (pow is monotone in both arguments on that region).
  if (a.whole && b.whole && b.lo >= 0 && a.lo >= 1) {
    return absVal(a.lo ** b.lo, a.hi ** b.hi, true, maybeNaN);
  }
  // Anything else (negative bases, fractional exponents): NaN is
  // reachable ((-1) ** 0.5), so give up rather than enumerate corners.
  return { ...TOP };
}

/* The bitwise coercion contract, exactly: each operand passes through
 * ToInt32 (ToUint32 for >>>), which maps NaN and the infinities to 0 and
 * truncates-and-wraps everything else; shift counts mask to 5 bits. The
 * RESULT is therefore always whole and in int32 (uint32 for >>>) range
 * no matter what the inputs were — `x | 0` is a proof, not a hint. */
function transferBitwise(op: IrNumBinOp, a: AbsVal, b: AbsVal): AbsVal {
  if (isSingleton(a) && isSingleton(b)) {
    const x = a.lo;
    const y = b.lo;
    const r =
      op === "&" ? x & y :
      op === "|" ? x | y :
      op === "^" ? x ^ y :
      op === "<<" ? x << y :
      op === ">>" ? x >> y :
      x >>> y;
    return constVal(r);
  }
  if (op === ">>>") return absVal(0, 2 ** 32 - 1, true, false);
  return absVal(-(2 ** 31), 2 ** 31 - 1, true, false);
}

/** JS `~`: ToInt32, complement — whole, int32 range, whatever the input. */
export function transferBitNot(a: AbsVal): AbsVal {
  if (isSingleton(a)) return constVal(~a.lo);
  return absVal(-(2 ** 31), 2 ** 31 - 1, true, false);
}

export function transferNeg(a: AbsVal): AbsVal {
  if (!hasNumeric(a)) return { ...BOTTOM, maybeNaN: a.maybeNaN };
  return absVal(-a.hi, -a.lo, a.whole, a.maybeNaN);
}

export function transferBin(op: IrNumBinOp, a: AbsVal, b: AbsVal): AbsVal {
  switch (op) {
    case "+": return transferAdd(a, b);
    case "-": return transferSub(a, b);
    case "*": return transferMul(a, b);
    case "/": return transferDiv(a, b);
    case "%": return transferMod(a, b);
    case "**": return transferPow(a, b);
    case "&": case "|": case "^": case "<<": case ">>": case ">>>":
      return transferBitwise(op, a, b);
    default:
      // Comparisons produce bool, not a numeric abstract value.
      return { ...TOP };
  }
}

/** The Math rounding family is the author's stated intent: every finite
 * input maps to a whole output, so these discharge the WHOLENESS
 * obligation. They do not discharge range (an unbounded input stays
 * unbounded) or NaN (Math.trunc(NaN) is NaN — maybeNaN propagates). */
export function transferMathRound(fn: "trunc" | "floor" | "ceil" | "round", a: AbsVal): AbsVal {
  if (!hasNumeric(a)) return { ...BOTTOM, maybeNaN: a.maybeNaN };
  const f = fn === "trunc" ? Math.trunc : fn === "floor" ? Math.floor : fn === "ceil" ? Math.ceil : Math.round;
  return absVal(f(a.lo), f(a.hi), true, a.maybeNaN);
}

export function transferAbs(a: AbsVal): AbsVal {
  if (!hasNumeric(a)) return { ...BOTTOM, maybeNaN: a.maybeNaN };
  const lo = a.lo <= 0 && a.hi >= 0 ? 0 : Math.min(Math.abs(a.lo), Math.abs(a.hi));
  return absVal(lo, Math.max(Math.abs(a.lo), Math.abs(a.hi)), a.whole, a.maybeNaN);
}

/** Math.min/max propagate NaN from ANY argument, exactly as JS does. */
export function transferMinMax(fn: "min" | "max", args: AbsVal[]): AbsVal {
  const maybeNaN = args.some((v) => v.maybeNaN);
  if (args.some((v) => !hasNumeric(v))) return { ...BOTTOM, maybeNaN };
  const lo = fn === "min" ? Math.min(...args.map((v) => v.lo)) : Math.max(...args.map((v) => v.lo));
  const hi = fn === "min" ? Math.min(...args.map((v) => v.hi)) : Math.max(...args.map((v) => v.hi));
  return absVal(lo, hi, args.every((v) => v.whole), maybeNaN);
}

/* ── the boundary check: PROVE or REFUSE ───────────────────────────────── */

export type IntClass = "i64" | "u64";
export type IntObligation = "representability" | "wholeness" | "range";

export interface IntVerdict {
  /** The sidecar slot path (`Msg.count`, `Point.x`,
   * `helpers.clamp.params[0]`, `exports.send.params[0]`). */
  path: string;
  cls: IntClass;
  loc: SrcLoc;
  outcome: "prove" | "refuse";
  /** PROVE: the proven crossing range (the exact crossing value when the
   * interval is a singleton); NaN/NaN for a vacuous (unreachable) proof. */
  provenLo?: number;
  provenHi?: number;
  /** REFUSE: the failed obligation (the FIRST failure in the §2.4 order),
   * the observed evidence, and the author's concrete fix. */
  obligation?: IntObligation;
  detail?: string;
  fix?: string;
}

/** Does an integer literal's source spelling survive the trip through
 * f64? Parse, convert, format back, compare (numeric separators were
 * stripped by the frontend — they are spelling sugar, not value). */
export function spellingRoundTrips(spelling: string): boolean {
  return String(Number(spelling)) === spelling;
}

/** Check a converged abstract value against a slot's obligations, in the
 * teaching-quality order: representability, then NaN, then range, then
 * fractional wholeness — the FIRST failure names the refusal (a value
 * both fractional and out of range hears about the more fundamental
 * problem). */
export function checkBoundary(v: AbsVal, path: string, cls: IntClass, loc: SrcLoc): IntVerdict {
  // Representability first: the author wrote a number the program never held.
  if (v.spelling !== undefined && !spellingRoundTrips(v.spelling)) {
    return {
      path, cls, loc, outcome: "refuse", obligation: "representability",
      detail: `the literal ${v.spelling} is not representable as f64 — it reads back as ${Number(v.spelling)}`,
      fix: "write the nearest representable integer explicitly, or restructure so the value stays within ±(2^53 − 1)",
    };
  }
  if (isBottom(v)) {
    // The slot is unreachable on every path; vacuously proven.
    return { path, cls, loc, outcome: "prove", provenLo: NaN, provenHi: NaN };
  }
  if (v.maybeNaN) {
    return {
      path, cls, loc, outcome: "refuse", obligation: "wholeness",
      detail: "the value may be NaN, which is not a whole number",
      fix: "guard the value with a comparison before the boundary (any ordered comparison excludes NaN), then state intent with Math.trunc/Math.floor/Math.ceil/Math.round if it may be fractional",
    };
  }
  const min = cls === "u64" ? 0 : SAFE_MIN;
  if (!(v.lo >= min && v.hi <= SAFE_MAX)) {
    return {
      path, cls, loc, outcome: "refuse", obligation: "range",
      detail:
        `the proven range [${v.lo}, ${v.hi}] does not fit ${cls === "u64" ? `[0, ${SAFE_MAX}]` : `[${SAFE_MIN}, ${SAFE_MAX}]`} — integrality is provable only within ±(2^53 − 1)` +
        (cls === "u64" ? ", and a u64 slot additionally requires a non-negative proven range" : ""),
      fix: "bound the value before the boundary (clamp, compare, or restructure the computation to stay in range)",
    };
  }
  if (!v.whole) {
    return {
      path, cls, loc, outcome: "refuse", obligation: "wholeness",
      detail: `the value is not provably whole — the proven range [${v.lo}, ${v.hi}] may contain non-integers`,
      fix: "state intent at the boundary with Math.trunc, Math.floor, Math.ceil, or Math.round",
    };
  }
  return { path, cls, loc, outcome: "prove", provenLo: v.lo, provenHi: v.hi };
}

/* ── slot configuration (what the profile declared, resolved to IR) ────── */

/** One function's declared integer slots: `params[i]` is the class of the
 * i-th parameter (null = not integer-declared), `ret` the return's.
 * `paramPaths`/`retPath` are the sidecar slot paths refusals carry. */
export interface FnIntSlots {
  fnName: string;
  params: (IntClass | null)[];
  paramPaths: (string | null)[];
  ret: IntClass | null;
  retPath: string | null;
  /** The plumbing classes of the NON-integer params (u8/u32/i32/f64/...):
   * used to seed the callee's parameter environment precisely. */
  paramSeeds: (AbsVal | null)[];
}

/** One lowered record-field obligation. Every program-side construction
 * (recordLit) or write (recordSet) of the field must discharge `cls` for
 * EVERY source contract path in `paths`. Shapes are interned STRUCTURALLY,
 * so same-shaped source slots with the same declared class coalesce here:
 * one proof fact, all attestation/diagnostic identities retained. */
export interface RecordIntSlot {
  cls: IntClass;
  paths: string[];
}

export interface IntSlotConfig {
  /** Keyed by IR function name. */
  fns: Map<string, FnIntSlots>;
  /** shapeId → field → slot. */
  records: Map<string, Map<string, RecordIntSlot>>;
}

/** The IR representations whose PRESENT values can carry one number slot.
 * A bare f64 is plain; a union of exactly one f64 arm and one or more
 * null/undefined arms is optional. The abstract interpreter tracks the
 * possible f64 arm values and treats unit arms as the empty numeric set. */
export function numberCarrierKind(t: IrType, mod: IrModule): "plain" | "optional" | null {
  if (t.kind === "f64") return "plain";
  if (t.kind !== "union") return null;
  const def = mod.unions?.find((u) => u.id === t.unionId);
  if (def === undefined) return null;
  let numbers = 0;
  let units = 0;
  for (const arm of def.arms) {
    if (arm.kind === "f64") numbers++;
    else if (arm.kind === "nullT" || arm.kind === "undefinedT") units++;
    else return null;
  }
  return numbers === 1 && units > 0 ? "optional" : null;
}

export function hasIntSlots(cfg: IntSlotConfig): boolean {
  if (cfg.records.size > 0) return true;
  for (const f of cfg.fns.values()) {
    if (f.ret !== null || f.params.some((p) => p !== null)) return true;
  }
  return false;
}

/** The class seed for a declared parameter: what the slot's own contract
 * proves about every value that ever arrives through it (internal calls
 * are checked at their call sites; external calls range-check in the
 * marshalling wrapper). */
export function classSeed(cls: string): AbsVal {
  switch (cls) {
    case "i64": return absVal(SAFE_MIN, SAFE_MAX, true, false);
    case "u64": return absVal(0, SAFE_MAX, true, false);
    case "u8": return absVal(0, 255, true, false);
    case "u32": return absVal(0, 2 ** 32 - 1, true, false);
    case "i32": return absVal(-(2 ** 31), 2 ** 31 - 1, true, false);
    default: return { ...TOP };
  }
}

/* ── the environment ───────────────────────────────────────────────────────
 * Abstract state per program point: binding/access key → AbsVal. Binding
 * keys cover f64-typed locals and module globals ("%g." ids); reserved path
 * keys carry temporary facts for static numeric fields. A missing LOCAL is
 * bottom (not yet bound on this path — tsc's definite-assignment analysis
 * guarantees no read precedes a binding); a missing GLOBAL or ordinary
 * field path is TOP (any value, including NaN). `null` in place of an Env
 * is unreachable. */

type Env = Map<string, AbsVal>;

/** Static-access facts share Env's join/clone machinery but have their own
 * missing-key value: TOP for an ordinary numeric field, or the declared
 * slot seed for a declared integer field. A killed declared-field fact
 * therefore falls back to the same whole-in-class-range assumption its read
 * had before access-path refinement, preserving SC4023 rather than
 * degrading to a spurious SC4022. */
const PATH_TOP_PREFIX = "%path.top:";
const PATH_I64_PREFIX = "%path.i64:";
const PATH_U64_PREFIX = "%path.u64:";

type PathSeed = IntClass | "top";

function pathSeedOfKey(id: string): PathSeed | null {
  if (id.startsWith(PATH_TOP_PREFIX)) return "top";
  if (id.startsWith(PATH_I64_PREFIX)) return "i64";
  if (id.startsWith(PATH_U64_PREFIX)) return "u64";
  return null;
}

function clearPathFacts(env: Env): void {
  for (const k of [...env.keys()]) {
    if (pathSeedOfKey(k) !== null) env.delete(k);
  }
}

const isGlobalId = (id: string): boolean => id.startsWith("%g.");
const defaultVal = (id: string): AbsVal => {
  const pathSeed = pathSeedOfKey(id);
  if (pathSeed !== null) return pathSeed === "top" ? { ...TOP } : classSeed(pathSeed);
  return isGlobalId(id) ? TOP : BOTTOM;
};

function envGet(env: Env, id: string): AbsVal {
  return env.get(id) ?? defaultVal(id);
}

function joinEnv(a: Env | null, b: Env | null): Env | null {
  if (a === null) return b === null ? null : new Map(b);
  if (b === null) return new Map(a);
  const out: Env = new Map();
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    out.set(k, join(a.get(k) ?? defaultVal(k), b.get(k) ?? defaultVal(k)));
  }
  // A real flow join ends the cheap straight-line access-path proof even
  // when both incoming facts happen to agree. A sole reachable edge
  // (early return/throw on the other edge) retains its dominated fact.
  clearPathFacts(out);
  return out;
}

function envEquals(a: Env, b: Env): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    if (!sameVal(a.get(k) ?? defaultVal(k), b.get(k) ?? defaultVal(k))) return false;
  }
  return true;
}

function widenEnv(prev: Env, next: Env): Env {
  const out: Env = new Map();
  const keys = new Set([...prev.keys(), ...next.keys()]);
  for (const k of keys) {
    out.set(k, widen(prev.get(k) ?? defaultVal(k), next.get(k) ?? defaultVal(k)));
  }
  clearPathFacts(out);
  return out;
}

/* ── which globals may a call mutate? ──────────────────────────────────────
 * A per-function transitive summary of written global ids, so a direct
 * call havocs exactly what its callee (and everything IT calls) can
 * write. Indirect calls — through function values, class methods,
 * dynamic machinery, or a libCall that receives a function argument (the
 * runtime may invoke it) — havoc everything. */

interface GlobalEffects {
  perFn: Map<string, Set<string>>;
  havocAll: Set<string>;
}

function globalEffectsOf(mod: IrModule): GlobalEffects {
  const writes = new Map<string, Set<string>>();
  const calls = new Map<string, Set<string>>();
  const unknown = new Set<string>();

  const typeHasFunc = (t: { kind: string }): boolean => JSON.stringify(t).includes('"func"');

  for (const fn of mod.functions) {
    const w = new Set<string>();
    const c = new Set<string>();
    let u = false;
    const visitExpr = (e: IrExpr): void => {
      switch (e.kind) {
        case "assignExpr":
          if (isGlobalId(e.localId)) w.add(e.localId);
          visitExpr(e.value);
          return;
        case "incDec":
          if (isGlobalId(e.localId)) w.add(e.localId);
          return;
        case "call":
          c.add(e.callee);
          e.args.forEach(visitExpr);
          return;
        case "callValue":
        case "newValue":
        case "dynCall":
        case "dynInvoke":
        case "virtualCall":
        case "new":
        case "intrinsic":
          u = true;
          break;
        case "libCall":
          if (e.args.some((a) => typeHasFunc(a.type))) u = true;
          break;
        case "seqExpr":
          e.stmts.forEach(visitStmt);
          visitExpr(e.result);
          return;
        default:
          break;
      }
      for (const key of Object.keys(e) as (keyof typeof e)[]) {
        const v = e[key] as unknown;
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item !== null && typeof item === "object" && "kind" in (item as object)) {
              const it = item as { kind: unknown };
              if (typeof it.kind === "string") visitExpr(item as IrExpr);
            } else if (item !== null && typeof item === "object") {
              // field-shaped entries ({ name, value } etc.)
              for (const sub of Object.values(item as object)) {
                if (sub !== null && typeof sub === "object" && typeof (sub as { kind?: unknown }).kind === "string") {
                  visitExpr(sub as IrExpr);
                }
              }
            }
          }
        } else if (v !== null && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && key !== "type") {
          visitExpr(v as IrExpr);
        }
      }
    };
    const visitStmt = (s: IrStmt): void => {
      switch (s.kind) {
        case "assign":
          if (isGlobalId(s.localId)) w.add(s.localId);
          visitExpr(s.value);
          return;
        case "varDecl":
          if (s.init !== null) visitExpr(s.init);
          return;
        default:
          break;
      }
      for (const v of Object.values(s) as unknown[]) {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item !== null && typeof item === "object" && typeof (item as { kind?: unknown }).kind === "string") {
              const node = item as { kind: string };
              if (isStmtKind(node.kind)) visitStmt(item as IrStmt);
              else visitExpr(item as IrExpr);
            } else if (item !== null && typeof item === "object") {
              // switch cases: { test, body }
              const cs = item as { test?: IrExpr | null; body?: IrStmt[] };
              if (cs.test !== undefined && cs.test !== null) visitExpr(cs.test);
              if (Array.isArray(cs.body)) cs.body.forEach(visitStmt);
            }
          }
        } else if (v !== null && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string") {
          const node = v as { kind: string };
          if (isStmtKind(node.kind)) visitStmt(v as IrStmt);
          else visitExpr(v as IrExpr);
        }
      }
    };
    fn.body.forEach(visitStmt);
    writes.set(fn.name, w);
    calls.set(fn.name, c);
    if (u) unknown.add(fn.name);
  }

  // Transitive closure over the direct-call graph.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, callees] of calls) {
      const w = writes.get(name)!;
      for (const callee of callees) {
        if (unknown.has(callee) && !unknown.has(name)) {
          unknown.add(name);
          changed = true;
        }
        for (const g of writes.get(callee) ?? []) {
          if (!w.has(g)) {
            w.add(g);
            changed = true;
          }
        }
      }
    }
  }
  return { perFn: writes, havocAll: unknown };
}

const STMT_KINDS = new Set([
  "varDecl", "assign", "exprStmt", "if", "while", "doWhile", "switch", "for",
  "arraySet", "bytesSet", "forOf", "return", "fieldSet", "recordSet",
  "recordKeySet", "recordKeyDelete", "break", "continue", "block", "throw",
  "runtimeFence", "rethrow", "tryCatch",
]);
const isStmtKind = (k: string): boolean => STMT_KINDS.has(k);

/* ── the analyzer ──────────────────────────────────────────────────────── */

const WIDEN_AFTER = 3; // plain joins at a loop header before widening
const LOOP_CAP = 64; // hard bound; thresholds converge far earlier

interface LoopFrame {
  kind: "loop" | "switch" | "block";
  labels: string[];
  breaks: (Env | null)[];
  continues: (Env | null)[];
}

const NEGATE: Record<string, string> = { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "===": "!==", "!==": "===" };
const FLIP: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "===": "===", "!==": "!==" };
const CMP_OPS = new Set(["<", "<=", ">", ">=", "===", "!=="]);
const ORDERED_CMP_OPS = new Set(["<", "<=", ">", ">="]);

/** Meet a value with an interval; `clearNaN` when the comparison's truth
 * on this edge excludes NaN operands. */
function meetInterval(v: AbsVal, lo: number, hi: number, clearNaN: boolean): AbsVal {
  const newLo = Math.max(v.lo, lo);
  const newHi = Math.min(v.hi, hi);
  if (newLo > newHi) {
    // No numeric member survives this edge; NaN may still flow through.
    return { ...BOTTOM, maybeNaN: clearNaN ? false : v.maybeNaN };
  }
  return absVal(newLo, newHi, v.whole, clearNaN ? false : v.maybeNaN, v.spelling);
}

/** Refine `a` under the assumption `a OP b` held. Wholeness sharpens the
 * strict bounds: whole x < b ⇒ x ≤ ⌈b.hi⌉ − 1 — the rule that lets the
 * ordinary counter loop prove a precise bound. */
function refineLhs(op: string, a: AbsVal, b: AbsVal, clearNaN: boolean): AbsVal {
  if (!hasNumeric(b) || !hasNumeric(a)) return clearNaN ? { ...a, maybeNaN: false } : a;
  // On a failed ordered comparison, a NaN in `b` satisfies the failed edge
  // regardless of `a`'s numeric value. Preserve every numeric member of `a`
  // in that case; the caller applies the same rule in the other direction.
  if (!clearNaN && b.maybeNaN && ORDERED_CMP_OPS.has(op)) return a;
  switch (op) {
    case "<":
      return meetInterval(a, -Infinity, a.whole ? Math.ceil(b.hi) - 1 : b.hi, clearNaN);
    case "<=":
      return meetInterval(a, -Infinity, a.whole ? Math.floor(b.hi) : b.hi, clearNaN);
    case ">":
      return meetInterval(a, a.whole ? Math.floor(b.lo) + 1 : b.lo, Infinity, clearNaN);
    case ">=":
      return meetInterval(a, a.whole ? Math.ceil(b.lo) : b.lo, Infinity, clearNaN);
    case "===":
      return meetInterval(a, b.lo, b.hi, clearNaN);
    case "!==": {
      // Only endpoint exclusion is useful: whole x !== integer singleton k
      // sitting on an endpoint of x's interval.
      if (isSingleton(b) && a.whole && Number.isInteger(b.lo)) {
        if (a.lo === b.lo) return meetInterval(a, a.lo + 1, a.hi, clearNaN);
        if (a.hi === b.lo) return meetInterval(a, a.lo, a.hi - 1, clearNaN);
      }
      return clearNaN ? { ...a, maybeNaN: false } : a;
    }
    default:
      return a;
  }
}

class FnAnalyzer {
  private frames: LoopFrame[] = [];
  private collect = false;
  /** Return-site abstract values (for the declared-return check). */
  constructor(
    private readonly mod: IrModule,
    private readonly cfg: IntSlotConfig,
    private readonly effects: GlobalEffects,
    private readonly verdicts: IntVerdict[],
  ) {}

  analyze(fn: IrFunction): void {
    const env: Env = new Map();
    const slots = this.cfg.fns.get(fn.name);
    fn.params.forEach((p, i) => {
      if (!this.bindingCarriesNumber(p.localId)) return;
      const declared = slots?.params[i] ?? null;
      const seed = slots?.paramSeeds[i] ?? null;
      if (declared !== null) env.set(p.localId, classSeed(declared));
      else if (seed !== null) env.set(p.localId, { ...seed });
      else env.set(p.localId, { ...TOP });
    });
    this.collect = true;
    this.retSlot = slots !== undefined && slots.ret !== null ? { cls: slots.ret, path: slots.retPath! } : null;
    this.execStmts(fn.body, env);
  }

  private retSlot: { cls: IntClass; path: string } | null = null;

  private emit(v: AbsVal, path: string, cls: IntClass, loc: SrcLoc): void {
    if (!this.collect) return;
    this.verdicts.push(checkBoundary(v, path, cls, loc));
  }

  /** One lowered write can conservatively cover several same-class source
   * contract slots. Check once per path so every attestation identity
   * survives into a refusal instead of inheriting the first declarer's
   * label. */
  private emitRecordSlot(v: AbsVal, slot: RecordIntSlot, loc: SrcLoc): void {
    for (const path of slot.paths) this.emit(v, path, slot.cls, loc);
  }

  /* ── statements ─────────────────────────────────────────────────────── */

  private execStmts(stmts: IrStmt[], env: Env | null): Env | null {
    for (const s of stmts) {
      if (env === null) return null; // unreachable remainder
      env = this.execStmt(s, env);
    }
    return env;
  }

  private execStmt(s: IrStmt, env: Env): Env | null {
    switch (s.kind) {
      case "varDecl": {
        if (s.init === null) return env;
        const v = this.evalExpr(s.init, env);
        this.clearPathsRootedAt(env, s.localId);
        if (this.bindingCarriesNumber(s.localId)) env.set(s.localId, v);
        return env;
      }
      case "assign": {
        const v = this.evalExpr(s.value, env);
        this.clearPathsRootedAt(env, s.localId);
        if (this.bindingCarriesNumber(s.localId)) env.set(s.localId, v);
        return env;
      }
      case "exprStmt":
        this.evalExpr(s.expr, env);
        return env;
      case "if": {
        this.evalExpr(s.cond, env);
        const allowPaths = this.stablePathGuard(s.cond);
        const thenEnv = this.refine(cloneEnv(env), s.cond, true, allowPaths);
        const elseEnv = this.refine(cloneEnv(env), s.cond, false, allowPaths);
        const a = thenEnv === null ? null : this.execStmts(s.then, thenEnv);
        const b = s.else_ === null ? elseEnv : elseEnv === null ? null : this.execStmts(s.else_, elseEnv);
        return joinEnv(a, b);
      }
      case "while":
        return this.execLoop(env, { cond: s.cond, body: s.body, labels: s.labels ?? [] });
      case "for": {
        let e: Env | null = env;
        if (s.init !== null) e = this.execStmt(s.init, e);
        if (e === null) return null;
        return this.execLoop(e, {
          ...(s.cond !== null ? { cond: s.cond } : {}),
          body: s.body,
          ...(s.update !== null ? { update: s.update } : {}),
          labels: s.labels ?? [],
        });
      }
      case "doWhile":
        return this.execLoop(env, { cond: s.cond, body: s.body, labels: s.labels ?? [], doWhile: true });
      case "forOf": {
        this.evalExpr(s.iterable, env);
        const elemF64 = this.bindingCarriesNumber(s.localId);
        return this.execLoop(env, {
          body: s.body,
          labels: s.labels ?? [],
          alwaysExits: true, // the iteration ends when the array runs out
          ...(elemF64 ? { seedEachIteration: s.localId } : {}),
        });
      }
      case "switch": {
        this.evalExpr(s.disc, env);
        const frame: LoopFrame = { kind: "switch", labels: s.labels ?? [], breaks: [], continues: [] };
        this.frames.push(frame);
        let running: Env | null = null; // the fallthrough path
        let hasDefault = false;
        try {
          for (const c of s.cases) {
            if (c.test === null) hasDefault = true;
            else this.evalExpr(c.test, env);
            running = this.execStmts(c.body, joinEnv(running, cloneEnv(env)));
          }
        } finally {
          this.frames.pop();
        }
        let out = running;
        for (const b of frame.breaks) out = joinEnv(out, b);
        // Without a default (or with tests that all miss) control skips past.
        if (!hasDefault) out = joinEnv(out, env);
        return out;
      }
      case "arraySet":
      case "bytesSet":
        this.evalExpr(s.arr, env);
        this.evalExpr(s.index, env);
        this.evalExpr(s.value, env);
        clearPathFacts(env);
        return env;
      case "fieldSet":
        this.evalExpr(s.obj, env);
        this.evalExpr(s.value, env);
        clearPathFacts(env);
        return env;
      case "recordSet": {
        this.evalExpr(s.obj, env);
        const v = this.evalExpr(s.value, env);
        const slot = this.cfg.records.get(s.shapeId)?.get(s.field);
        if (slot !== undefined) this.emitRecordSlot(v, slot, s.loc);
        // The RHS and its boundary obligation observe the pre-write value;
        // only the completed heap write invalidates paths (JS evaluation
        // order, and what lets `m.count = m.count + 1` prove).
        clearPathFacts(env);
        return env;
      }
      case "recordKeySet": {
        this.evalExpr(s.obj, env);
        this.evalExpr(s.key, env);
        const v = this.evalExpr(s.value, env);
        // A runtime key can dispatch to any declared field of the shape.
        // overflowOnly proves a literal key names no declared field; every
        // other keyed write must therefore discharge every integer slot it
        // could select. Multiple classified fields intentionally emit
        // independent obligations (their classes and paths may differ).
        if (s.overflowOnly !== true) {
          for (const slot of this.cfg.records.get(s.shapeId)?.values() ?? []) {
            this.emitRecordSlot(v, slot, s.loc);
          }
        }
        clearPathFacts(env);
        return env;
      }
      case "recordKeyDelete":
        this.evalExpr(s.obj, env);
        this.evalExpr(s.key, env);
        clearPathFacts(env);
        return env;
      case "return": {
        if (s.value !== null) {
          const v = this.evalExpr(s.value, env);
          if (this.retSlot !== null) this.emit(v, this.retSlot.path, this.retSlot.cls, s.loc);
        }
        return null;
      }
      case "throw":
        this.evalExpr(s.value, env);
        return null;
      case "rethrow":
      case "runtimeFence":
        return null;
      case "break": {
        const frame = this.jumpTarget(s.label, "break");
        if (frame !== null) frame.breaks.push(cloneEnv(env));
        return null;
      }
      case "continue": {
        const frame = this.jumpTarget(s.label, "continue");
        if (frame !== null) frame.continues.push(cloneEnv(env));
        return null;
      }
      case "block": {
        if ((s.labels ?? []).length === 0) return this.execStmts(s.body, env);
        const frame: LoopFrame = { kind: "block", labels: s.labels!, breaks: [], continues: [] };
        this.frames.push(frame);
        let out: Env | null;
        try {
          out = this.execStmts(s.body, env);
        } finally {
          this.frames.pop();
        }
        for (const b of frame.breaks) out = joinEnv(out, b);
        return out;
      }
      case "tryCatch": {
        const entry = cloneEnv(env);
        const afterTry = this.execStmts(s.tryBody, env);
        let afterCatch: Env | null = null;
        if (s.catchBody !== null) {
          // The exception may have unwound from ANY point of the try
          // body: every binding the try can write (and every global —
          // a callee may have mutated some before throwing) is unknown.
          afterCatch = this.execStmts(s.catchBody, this.havocForCatch(entry, s.tryBody));
        }
        let out = joinEnv(afterTry, afterCatch);
        if (s.finallyBody !== null) {
          // The finally also runs on the pending-exception and
          // pending-return paths; obligations inside it must hold there
          // too, so it executes over the havoc-joined state.
          out = this.execStmts(s.finallyBody, joinEnv(out, this.havocForCatch(entry, s.tryBody)) ?? this.havocForCatch(entry, s.tryBody));
        }
        return out;
      }
    }
  }

  private jumpTarget(label: string | undefined, kind: "break" | "continue"): LoopFrame | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (label !== undefined) {
        if (f.labels.includes(label) && (kind === "break" || f.kind === "loop")) return f;
        continue;
      }
      if (kind === "break" && (f.kind === "loop" || f.kind === "switch")) return f;
      if (kind === "continue" && f.kind === "loop") return f;
    }
    return null;
  }

  private havocForCatch(entry: Env, tryBody: IrStmt[]): Env {
    const out = cloneEnv(entry);
    const assigned = new Set<string>();
    const visitStmt = (s: IrStmt): void => {
      if (s.kind === "assign" || s.kind === "varDecl") assigned.add(s.localId);
      for (const v of Object.values(s) as unknown[]) {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item !== null && typeof item === "object" && typeof (item as { kind?: unknown }).kind === "string") {
              const node = item as { kind: string };
              if (isStmtKind(node.kind)) visitStmt(item as IrStmt);
              else visitExpr(item as IrExpr);
            } else if (item !== null && typeof item === "object") {
              const cs = item as { body?: IrStmt[] };
              if (Array.isArray(cs.body)) cs.body.forEach(visitStmt);
            }
          }
        } else if (v !== null && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string") {
          const node = v as { kind: string };
          if (isStmtKind(node.kind)) visitStmt(v as IrStmt);
          else visitExpr(v as IrExpr);
        }
      }
    };
    const visitExpr = (e: IrExpr): void => {
      if (e.kind === "assignExpr" || e.kind === "incDec") assigned.add(e.localId);
      if (e.kind === "seqExpr") e.stmts.forEach(visitStmt);
      for (const v of Object.values(e) as unknown[]) {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item !== null && typeof item === "object" && typeof (item as { kind?: unknown }).kind === "string") {
              visitExpr(item as IrExpr);
            }
          }
        } else if (v !== null && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string") {
          visitExpr(v as IrExpr);
        }
      }
    };
    tryBody.forEach(visitStmt);
    for (const id of assigned) {
      if (this.bindingCarriesNumber(id)) out.set(id, { ...TOP });
    }
    // Globals: any callee may have written before the throw.
    for (const k of [...out.keys()]) {
      if (isGlobalId(k)) out.delete(k); // absent global = TOP
    }
    clearPathFacts(out);
    return out;
  }

  /* ── loops: header widening + body-edge refinement ──────────────────── */

  private execLoop(
    env: Env,
    opts: {
      cond?: IrExpr;
      body: IrStmt[];
      update?: IrStmt;
      labels: string[];
      doWhile?: boolean;
      seedEachIteration?: string;
      alwaysExits?: boolean;
    },
  ): Env | null {
    // Loop headers/backedges are outside the deliberately straight-line
    // access-path scope. Guards inside the body can establish fresh facts.
    clearPathFacts(env);
    const savedCollect = this.collect;
    this.collect = false;
    let head = cloneEnv(env);
    let joins = 0;
    // Phase 1: fixpoint (collect off). `head` is the state at the loop
    // header (the condition's evaluation point; for do-while, the body's
    // entry). Widening applies ONLY here — an acyclic join converges by
    // itself and keeps its precision; precision the header loses is
    // recovered by the body-edge refinement below.
    for (let iter = 0; iter < LOOP_CAP; iter++) {
      const trip = this.runLoopBodyOnce(head, opts);
      let next = joinEnv(head, trip.back)!;
      joins++;
      if (joins > WIDEN_AFTER) next = widenEnv(head, next);
      if (envEquals(head, next)) break;
      head = next;
      if (iter === LOOP_CAP - 1) {
        // Safety net (the thresholds converge long before this): give up
        // on precision rather than loop.
        for (const k of [...head.keys()]) head.set(k, { ...TOP });
      }
    }
    // Phase 2: one collect pass over the stabilized header state — the
    // pass that emits verdicts sees the loop-body edge's refined values
    // (the header may have widened to [0, 2^31−1]; the body sees n < 10
    // and proves [0, 9]).
    this.collect = savedCollect;
    const frame: LoopFrame = { kind: "loop", labels: opts.labels, breaks: [], continues: [] };
    const final = this.runLoopBodyOnce(head, opts, frame);
    // The exit state: the condition's false edge (evaluated at the
    // header for while/for, after the body for do-while), joined with
    // every break's state. A condition-free, non-iterating loop
    // (`for (;;)`) exits only through breaks.
    let exit: Env | null = null;
    if (opts.doWhile ?? false) {
      exit = opts.cond !== undefined && final.postBody !== null ? this.refine(final.postBody, opts.cond, false, false) : null;
    } else if (opts.cond !== undefined) {
      exit = this.refine(cloneEnv(head), opts.cond, false, false);
    } else if (opts.alwaysExits ?? false) {
      exit = cloneEnv(head); // for-of ends when the array runs out
    }
    for (const b of frame.breaks) exit = joinEnv(exit, b);
    return exit;
  }

  /** One trip around the loop from the header state: refine by the
   * condition's true edge (unless do-while, whose condition sits after
   * the body), execute the body, fold continues, run the update, and for
   * do-while apply the condition's true edge to form the back edge.
   * `back` is the back-edge environment (null when the body never reaches
   * it); `postBody` is the do-while exit candidate — the state at the
   * condition, before its verdict. */
  private runLoopBodyOnce(
    head: Env,
    opts: { cond?: IrExpr; body: IrStmt[]; update?: IrStmt; labels: string[]; doWhile?: boolean; seedEachIteration?: string; alwaysExits?: boolean },
    frame?: LoopFrame,
  ): { back: Env | null; postBody: Env | null } {
    const f: LoopFrame = frame ?? { kind: "loop", labels: opts.labels, breaks: [], continues: [] };
    let bodyIn: Env | null = cloneEnv(head);
    if (opts.cond !== undefined && !(opts.doWhile ?? false)) {
      this.evalExpr(opts.cond, bodyIn);
      bodyIn = this.refine(bodyIn, opts.cond, true, false);
    }
    if (bodyIn !== null && opts.seedEachIteration !== undefined) {
      bodyIn.set(opts.seedEachIteration, { ...TOP });
    }
    this.frames.push(f);
    let out: Env | null;
    try {
      out = bodyIn === null ? null : this.execStmts(opts.body, bodyIn);
    } finally {
      this.frames.pop();
    }
    for (const c of f.continues) out = joinEnv(out, c);
    if (opts.update !== undefined && out !== null) out = this.execStmt(opts.update, out);
    let postBody: Env | null = null;
    if ((opts.doWhile ?? false) && opts.cond !== undefined && out !== null) {
      this.evalExpr(opts.cond, out);
      postBody = cloneEnv(out);
      out = this.refine(out, opts.cond, true, false);
    }
    return { back: out, postBody };
  }

  /* ── branch refinement ──────────────────────────────────────────────── */

  /** Refine an environment under `cond === branch`. Returns null when the
   * edge is impossible. Every ordered comparison (and ===) evaluates
   * false when either side is NaN, so the edge where one HELD proves both
   * operands NaN-free; on the failed edge NaN survives while the negated
   * comparison still refines the numeric members. */
  private refine(env: Env | null, cond: IrExpr, branch: boolean, allowPaths = false): Env | null {
    if (env === null) return null;
    switch (cond.kind) {
      case "boolLit":
        return cond.value === branch ? env : null;
      case "unary":
        if (cond.op === "!") return this.refine(env, cond.operand, !branch, allowPaths);
        return env;
      case "logical": {
        const isAnd = cond.op === "&&";
        if (isAnd === branch) {
          // (a && b) true  — both held; (a || b) false — both failed.
          return this.refine(this.refine(env, cond.left, branch, allowPaths), cond.right, branch, allowPaths);
        }
        // (a && b) false — a failed, or a held and b failed; dually for ||.
        const viaLeft = this.refine(cloneEnv(env), cond.left, branch, allowPaths);
        const viaRight = this.refine(
          this.refine(cloneEnv(env), cond.left, !branch, allowPaths),
          cond.right,
          branch,
          allowPaths,
        );
        return joinEnv(viaLeft, viaRight);
      }
      case "unionIsTag": {
        const unionType: IrType = { kind: "union", unionId: cond.unionId };
        if (numberCarrierKind(unionType, this.mod) !== "optional") return env;
        const def = this.mod.unions?.find((u) => u.id === cond.unionId);
        const arm = def?.arms[cond.tag];
        const key = this.refinementKey(cond.value, allowPaths);
        if (arm === undefined || key === null) return env;
        const tagMatches = cond.negated ? !branch : branch;
        // The abstract value describes only PRESENT f64 inhabitants. A
        // branch selecting a unit arm has no numeric inhabitants; likewise
        // a branch excluding the optional carrier's sole f64 arm.
        if ((tagMatches && arm.kind !== "f64") || (!tagMatches && arm.kind === "f64")) {
          const out = cloneEnv(env);
          out.set(key, { ...BOTTOM });
          return out;
        }
        return env;
      }
      case "bin": {
        if (!CMP_OPS.has(cond.op)) return env;
        if (cond.left.type.kind !== "f64" || cond.right.type.kind !== "f64") return env;
        if (!this.isPure(cond.left) || !this.isPure(cond.right)) return env;
        const op = branch ? cond.op : NEGATE[cond.op]!;
        // NaN makes < <= > >= === evaluate false, so the edge where one of
        // those was TRUE proves both operands NaN-free (!== held excludes
        // nothing — NaN !== x is true).
        const clearNaN = branch ? cond.op !== "!==" : cond.op === "!==";
        const a = this.evalPure(cond.left, env);
        const b = this.evalPure(cond.right, env);
        const out = cloneEnv(env);
        const leftKey = this.refinementKey(cond.left, allowPaths);
        const rightKey = this.refinementKey(cond.right, allowPaths);
        if (leftKey !== null) out.set(leftKey, refineLhs(op, a, b, clearNaN));
        if (rightKey !== null) out.set(rightKey, refineLhs(FLIP[op]!, b, a, clearNaN));
        return out;
      }
      case "toBool": {
        const inner = cond.operand;
        if (inner.type.kind !== "f64" || !this.isPure(inner)) return env;
        const key = this.refinementKey(inner, allowPaths);
        if (key === null) return env;
        const v = this.evalPure(inner, env);
        const out = cloneEnv(env);
        if (branch) {
          // Truthy: not NaN, not zero — endpoint exclusion when whole.
          let r: AbsVal = { ...v, maybeNaN: false };
          if (r.whole && r.lo === 0 && r.hi >= 1) r = absVal(1, r.hi, r.whole, false, r.spelling);
          else if (r.whole && r.hi === 0 && r.lo <= -1) r = absVal(r.lo, -1, r.whole, false, r.spelling);
          out.set(key, r);
        } else {
          // Falsy: 0, -0, or NaN.
          out.set(key, meetInterval(v, 0, 0, false));
        }
        return out;
      }
      default:
        return env;
    }
  }

  /** No side effects anywhere in the tree: safe to (re-)evaluate during
   * refinement. */
  private isPure(e: IrExpr): boolean {
    switch (e.kind) {
      case "incDec":
      case "assignExpr":
      case "seqExpr":
      case "call":
      case "ffiCall":
      case "callValue":
      case "new":
      case "newValue":
      case "virtualCall":
      case "dynCall":
      case "dynInvoke":
      case "intrinsic":
      case "yieldExpr":
      case "awaitExpr":
      case "awaitUnionExpr":
        return false;
      case "libCall":
        return e.fn.startsWith("math.") && e.args.every((a) => this.isPure(a));
      case "numLit":
      case "strLit":
      case "boolLit":
      case "varRef":
      case "unitLit":
      case "selfRef":
        return true;
      case "recordGet":
      case "fieldGet":
        return this.staticAccessPath(e) !== null;
      case "unionNarrow":
        return this.isPure(e.value);
      case "bin":
      case "strEq":
      case "strCmp":
        return this.isPure(e.left) && this.isPure(e.right);
      case "unary":
        return this.isPure(e.operand);
      case "logical":
        return this.isPure(e.left) && this.isPure(e.right);
      case "toBool":
        return this.isPure(e.operand);
      default:
        return false;
    }
  }

  /** The abstract value of a PURE f64 expression, no env writes. */
  private evalPure(e: IrExpr, env: Env): AbsVal {
    switch (e.kind) {
      case "numLit":
        return constVal(e.value, e.spelling);
      case "varRef":
        return this.bindingCarriesNumber(e.localId) ? envGet(env, e.localId) : { ...TOP };
      case "recordGet": {
        const slot = this.cfg.records.get(e.shapeId)?.get(e.field);
        if (numberCarrierKind(e.type, this.mod) === null) return { ...TOP };
        const key = this.pathKey(e, slot?.cls ?? null);
        return key === null ? (slot === undefined ? { ...TOP } : classSeed(slot.cls)) : envGet(env, key);
      }
      case "fieldGet": {
        if (numberCarrierKind(e.type, this.mod) === null) return { ...TOP };
        const key = this.pathKey(e, null);
        return key === null ? { ...TOP } : envGet(env, key);
      }
      case "unionNarrow":
        return e.type.kind === "f64" && numberCarrierKind(e.value.type, this.mod) === "optional"
          ? this.evalPure(e.value, env)
          : { ...TOP };
      case "unary":
        if (e.op === "-") return transferNeg(this.evalPure(e.operand, env));
        if (e.op === "~") return transferBitNot(this.evalPure(e.operand, env));
        return { ...TOP };
      case "bin":
        return transferBin(e.op, this.evalPure(e.left, env), this.evalPure(e.right, env));
      case "libCall":
        return this.evalMath(e, env, false) ?? { ...TOP };
      default:
        return { ...TOP };
    }
  }

  /** A canonical static data path. Source spellings that lower to the same
   * IR access (`m.total`, `m["total"]`) intentionally share a key; distinct
   * receiver bindings never do. Accessors/dynamic keys/computed receivers
   * have different IR nodes and are excluded. */
  private staticAccessPath(
    e: IrExpr,
  ): { rootId: string | null; steps: string[][] } | null {
    switch (e.kind) {
      case "varRef":
        return { rootId: e.localId, steps: [["var", e.localId]] };
      case "selfRef":
        return { rootId: null, steps: [["self"]] };
      case "recordGet": {
        const base = this.staticAccessPath(e.obj);
        if (base === null) return null;
        return { rootId: base.rootId, steps: [...base.steps, ["record", e.shapeId, e.field]] };
      }
      case "unionNarrow":
        return this.staticAccessPath(e.value);
      case "fieldGet": {
        const base = this.staticAccessPath(e.obj);
        if (base === null) return null;
        return { rootId: base.rootId, steps: [...base.steps, ["field", e.className, e.field]] };
      }
      default:
        return null;
    }
  }

  private readonly pathRoots = new Map<string, string | null>();

  private pathKey(e: IrExpr, cls: IntClass | null): string | null {
    const path = this.staticAccessPath(e);
    if (path === null) return null;
    const prefix = cls === null ? PATH_TOP_PREFIX : cls === "i64" ? PATH_I64_PREFIX : PATH_U64_PREFIX;
    const key = `${prefix}${JSON.stringify(path.steps)}`;
    this.pathRoots.set(key, path.rootId);
    return key;
  }

  private refinementKey(e: IrExpr, allowPaths: boolean): string | null {
    if (e.kind === "varRef") return e.localId;
    if (e.kind === "unionNarrow" && e.type.kind === "f64") {
      return this.refinementKey(e.value, allowPaths);
    }
    if (!allowPaths || numberCarrierKind(e.type, this.mod) === null) return null;
    if (e.kind === "recordGet") {
      const slot = this.cfg.records.get(e.shapeId)?.get(e.field);
      return this.pathKey(e, slot?.cls ?? null);
    }
    return e.kind === "fieldGet" ? this.pathKey(e, null) : null;
  }

  /** Path facts are admitted only when the entire guard is synchronous,
   * call-free, assignment-free static data access. This prevents a later
   * subexpression from mutating a field and `refine` subsequently
   * reconstructing a stale fact from the guard syntax. */
  private stablePathGuard(e: IrExpr): boolean {
    switch (e.kind) {
      case "numLit":
      case "strLit":
      case "boolLit":
      case "unitLit":
      case "varRef":
      case "selfRef":
        return true;
      case "recordGet":
      case "fieldGet":
        return this.staticAccessPath(e) !== null;
      case "unionIsTag":
      case "unionDisc":
        return this.stablePathGuard(e.value);
      case "unionNarrow":
        return this.stablePathGuard(e.value);
      case "bin":
      case "strEq":
      case "strCmp":
      case "logical":
        return this.stablePathGuard(e.left) && this.stablePathGuard(e.right);
      case "unary":
      case "toBool":
        return this.stablePathGuard(e.operand);
      default:
        return false;
    }
  }

  private clearPathsRootedAt(env: Env, localId: string): void {
    for (const k of [...env.keys()]) {
      if (pathSeedOfKey(k) !== null && this.pathRoots.get(k) === localId) env.delete(k);
    }
  }

  /* ── expression evaluation (side effects applied to env) ────────────── */

  private evalMath(e: IrExpr & { kind: "libCall" }, env: Env, mutate: boolean): AbsVal | null {
    const arg = (i: number): AbsVal => (mutate ? this.evalExpr(e.args[i]!, env) : this.evalPure(e.args[i]!, env));
    switch (e.fn) {
      case "math.trunc": return transferMathRound("trunc", arg(0));
      case "math.floor": return transferMathRound("floor", arg(0));
      case "math.ceil": return transferMathRound("ceil", arg(0));
      case "math.round": return transferMathRound("round", arg(0));
      case "math.abs": return transferAbs(arg(0));
      case "math.min": return transferMinMax("min", [arg(0), arg(1)]);
      case "math.max": return transferMinMax("max", [arg(0), arg(1)]);
      case "math.random": return absVal(0, 1, false, false); // [0, 1): never NaN, never whole beyond 0
      default: return null;
    }
  }

  private bindingCarriesNumber(id: string): boolean {
    return this.numberBindings.has(id);
  }
  private numberBindings = new Set<string>();

  seedBindings(fn: IrFunction, mod: IrModule): void {
    this.numberBindings = new Set();
    for (const l of fn.locals) {
      if (numberCarrierKind(l.type, mod) !== null && l.boxed !== true) this.numberBindings.add(l.id);
    }
    for (const g of mod.globals ?? []) {
      if (numberCarrierKind(g.type, mod) !== null) this.numberBindings.add(g.id);
    }
  }

  /** Evaluate an expression over the environment, applying the side
   * effects of nested writes and calls (a call havocs the globals its
   * transitive callee set can write; an indirect call havocs them all).
   * The returned value is meaningful for f64-typed expressions; anything
   * without a modeled transfer is TOP. */
  private evalExpr(e: IrExpr, env: Env): AbsVal {
    switch (e.kind) {
      case "numLit":
        return constVal(e.value, e.spelling);
      case "strLit":
      case "boolLit":
      case "unitLit":
      case "regexLit":
      case "templateStrings":
      case "classRef":
      case "selfRef":
      case "chainRecv":
        return { ...TOP };
      case "varRef":
        return this.bindingCarriesNumber(e.localId) ? envGet(env, e.localId) : { ...TOP };
      case "bin": {
        const a = this.evalExpr(e.left, env);
        const b = this.evalExpr(e.right, env);
        if (CMP_OPS.has(e.op)) return { ...TOP };
        if (e.left.type.kind !== "f64" || e.right.type.kind !== "f64") return { ...TOP };
        return transferBin(e.op, a, b);
      }
      case "strEq":
      case "strCmp":
        this.evalExpr(e.left, env);
        this.evalExpr(e.right, env);
        return { ...TOP };
      case "unionIsTag":
      case "unionDisc":
        this.evalExpr(e.value, env);
        return { ...TOP };
      case "unary": {
        const v = this.evalExpr(e.operand, env);
        if (e.op === "-") return transferNeg(v);
        if (e.op === "~") return transferBitNot(v);
        return { ...TOP };
      }
      case "incDec": {
        const old = this.bindingCarriesNumber(e.localId) ? envGet(env, e.localId) : { ...TOP };
        const next = transferAdd(old, constVal(e.op === "+" ? 1 : -1));
        if (this.bindingCarriesNumber(e.localId)) env.set(e.localId, next);
        return e.prefix ? next : old;
      }
      case "assignExpr": {
        const v = this.evalExpr(e.value, env);
        this.clearPathsRootedAt(env, e.localId);
        if (this.bindingCarriesNumber(e.localId)) env.set(e.localId, v);
        return v;
      }
      case "ternary": {
        this.evalExpr(e.cond, env);
        const allowPaths = this.stablePathGuard(e.cond);
        const thenEnv = this.refine(cloneEnv(env), e.cond, true, allowPaths);
        const elseEnv = this.refine(cloneEnv(env), e.cond, false, allowPaths);
        const a = thenEnv === null ? BOTTOM : this.evalExpr(e.then, thenEnv);
        const b = elseEnv === null ? BOTTOM : this.evalExpr(e.else_, elseEnv);
        mergeInto(env, joinEnv(thenEnv, elseEnv));
        return join(a, b);
      }
      case "logical":
      case "nullish":
      case "orDefault": {
        const left = this.evalExpr(e.left, env);
        const rightEnv = cloneEnv(env);
        const right = this.evalExpr(e.right, rightEnv);
        // A stable logical tree cannot change the environment, so its
        // short-circuit join must not discard an access-path fact merely
        // because the RHS may not execute.
        if (!this.stablePathGuard(e)) mergeInto(env, joinEnv(env, rightEnv));
        return numberCarrierKind(e.type, this.mod) !== null ? join(left, right) : { ...TOP };
      }
      case "optChain": {
        this.evalExpr(e.receiver, env);
        const bodyEnv = cloneEnv(env);
        const body = this.evalExpr(e.body, bodyEnv);
        mergeInto(env, joinEnv(env, bodyEnv));
        return numberCarrierKind(e.type, this.mod) !== null ? body : { ...TOP };
      }
      case "seqExpr": {
        // Expression-position statements: no jumps can escape them.
        let running: Env | null = env;
        for (const s of e.stmts) {
          if (running === null) break;
          running = this.execStmt(s, running);
        }
        if (running === null) return BOTTOM;
        if (running !== env) mergeInto(env, running);
        return this.evalExpr(e.result, env);
      }
      case "call": {
        // Arguments evaluate left to right and the VALUES captured here
        // are exactly what the call passes (a later argument's side
        // effect cannot reach an earlier argument's already-read value).
        const vals = e.args.map((a) => this.evalExpr(a, env));
        const slots = this.cfg.fns.get(e.callee);
        if (slots !== undefined) {
          e.args.forEach((arg, i) => {
            const cls = slots.params[i] ?? null;
            if (cls === null) return;
            this.emit(vals[i]!, slots.paramPaths[i]!, cls, arg.loc);
          });
        }
        this.havocCall(e.callee, env);
        if (slots?.ret != null) return classSeed(slots.ret);
        return { ...TOP };
      }
      case "unionWrap": {
        const value = this.evalExpr(e.value, env);
        if (numberCarrierKind(e.type, this.mod) !== "optional") return { ...TOP };
        // Unit arms are absence, not an integer crossing. The one f64 arm
        // contributes its abstract value unchanged.
        return e.value.type.kind === "f64" ? value : BOTTOM;
      }
      case "unionNarrow": {
        const value = this.evalExpr(e.value, env);
        return e.type.kind === "f64" && numberCarrierKind(e.value.type, this.mod) === "optional"
          ? value
          : { ...TOP };
      }
      case "libCall": {
        const math = this.evalMath(e, env, true);
        if (math !== null) {
          clearPathFacts(env);
          return math;
        }
        for (const a of e.args) this.evalExpr(a, env);
        if (e.args.some((a) => typeContainsFunc(a.type))) this.havocAllGlobals(env);
        clearPathFacts(env);
        return { ...TOP };
      }
      case "callValue":
      case "newValue":
      case "dynCall":
      case "dynInvoke":
      case "virtualCall":
      case "new":
      case "intrinsic": {
        for (const v of childExprs(e)) this.evalExpr(v, env);
        this.havocAllGlobals(env);
        return { ...TOP };
      }
      case "ffiCall":
      case "yieldExpr":
      case "awaitExpr":
      case "awaitUnionExpr": {
        for (const v of childExprs(e)) this.evalExpr(v, env);
        clearPathFacts(env);
        return { ...TOP };
      }
      case "recordLit": {
        const slotMap = this.cfg.records.get((e.type as { kind: "record"; shapeId: string }).shapeId);
        for (const f of e.fields) {
          const v = this.evalExpr(f.value, env);
          const slot = slotMap?.get(f.name);
          if (slot !== undefined && numberCarrierKind(f.value.type, this.mod) !== null) {
            this.emitRecordSlot(v, slot, f.value.loc);
          }
        }
        return { ...TOP };
      }
      case "recordGet": {
        // A declared record-field slot is an assumption on the read side,
        // exactly like a declared parameter inside its callee: every write
        // into the field discharged the class's obligations, so its path
        // starts at the class seed. An ordinary numeric field starts at TOP
        // but can acquire the same straight-line guard facts as a local.
        this.evalExpr(e.obj, env);
        const slot = this.cfg.records.get(e.shapeId)?.get(e.field);
        if (numberCarrierKind(e.type, this.mod) !== null) {
          const key = this.pathKey(e, slot?.cls ?? null);
          return key === null ? (slot === undefined ? { ...TOP } : classSeed(slot.cls)) : envGet(env, key);
        }
        return { ...TOP };
      }
      case "fieldGet": {
        this.evalExpr(e.obj, env);
        if (numberCarrierKind(e.type, this.mod) === null) return { ...TOP };
        const key = this.pathKey(e, null);
        return key === null ? { ...TOP } : envGet(env, key);
      }
      default: {
        for (const v of childExprs(e)) this.evalExpr(v, env);
        // Unmodeled expressions do not participate in the cheap
        // straight-line proof. Some can invoke runtime/user machinery;
        // refusing to carry a field fact through them is the safe verdict.
        clearPathFacts(env);
        return { ...TOP };
      }
    }
  }

  private havocCall(callee: string, env: Env): void {
    clearPathFacts(env);
    if (this.effects.havocAll.has(callee) || !this.effects.perFn.has(callee)) {
      this.havocAllGlobals(env);
      return;
    }
    for (const g of this.effects.perFn.get(callee)!) env.delete(g); // absent global = TOP
  }

  private havocAllGlobals(env: Env): void {
    clearPathFacts(env);
    for (const k of [...env.keys()]) {
      if (isGlobalId(k)) env.delete(k);
    }
  }
}

function cloneEnv(env: Env): Env {
  return new Map(env);
}

function mergeInto(dst: Env, src: Env | null): void {
  if (src === null || src === dst) return;
  dst.clear();
  for (const [k, v] of src) dst.set(k, v);
}

function typeContainsFunc(t: unknown): boolean {
  return JSON.stringify(t).includes('"func"');
}

/** Every direct IrExpr child of a node, order-preserving (evaluation
 * order for the shapes we don't model precisely). */
function childExprs(e: IrExpr): IrExpr[] {
  const out: IrExpr[] = [];
  for (const [key, v] of Object.entries(e)) {
    if (key === "type") continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== null && typeof item === "object") {
          if (typeof (item as { kind?: unknown }).kind === "string" && !isStmtKind((item as { kind: string }).kind)) {
            out.push(item as IrExpr);
          } else {
            for (const sub of Object.values(item as object)) {
              if (sub !== null && typeof sub === "object" && typeof (sub as { kind?: unknown }).kind === "string" && !isStmtKind((sub as { kind: string }).kind)) {
                out.push(sub as IrExpr);
              }
            }
          }
        }
      }
    } else if (v !== null && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && !isStmtKind((v as { kind: string }).kind)) {
      out.push(v as IrExpr);
    }
  }
  return out;
}

/* ── the entry point ───────────────────────────────────────────────────── */

/** Run the inference over every function of a lowered library module and
 * return one verdict per (obligation site) — internal call arguments into
 * declared integer parameters, returns of declared integer returns, and
 * writes into declared record-field slots. Callers turn REFUSE verdicts
 * into diagnostics; PROVE verdicts carry the proven crossing range. */
export function checkLibraryIntegerSlots(mod: IrModule, cfg: IntSlotConfig): IntVerdict[] {
  const verdicts: IntVerdict[] = [];
  if (!hasIntSlots(cfg)) return verdicts;
  const effects = globalEffectsOf(mod);
  for (const fn of mod.functions) {
    const analyzer = new FnAnalyzer(mod, cfg, effects, verdicts);
    analyzer.seedBindings(fn, mod);
    analyzer.analyze(fn);
  }
  return verdicts;
}
