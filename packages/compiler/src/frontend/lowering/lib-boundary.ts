/* The lib-boundary pass: the checked-coercion chokepoint between lowered
 * statements and the validator's libCall/intrinsic signature tables.
 *
 * Builtin-call lowerings assemble their IR at hundreds of sites, and most
 * lower their arguments with plain lowerExpr — no coerceToExpected against
 * the runtime signature. A TYPED argument can't go wrong there (tsc already
 * agreed with the surface), but a CHECKED-DYNAMIC one can: JS sources have
 * no annotations, so untyped helpers return dyn (`common.platformTimeout(10)`
 * feeding setTimeout's ms), and the raw dyn used to sail into the validator
 * as an ICE — or, worse, past it into the emitter as invalid C.
 *
 * This pass runs once per lowered statement (lowerStmts calls it inside the
 * per-statement poison window) and re-checks every libCall / strIntrinsic /
 * regexIntrinsic / arrIntrinsic / callValue argument against the SAME
 * signature tables the validator enforces (exported from ir/validate.ts —
 * one table, two consumers, no drift):
 *
 *   - a dyn argument whose slot dynCheck can validate (JSON-safe types,
 *     undefined-armed unions of those, bytes<u8>, the %Error root) is
 *     WRAPPED in a dynCheck — the trust-but-verify stance coerceToExpected
 *     already applies at declaration/assignment/return edges, extended to
 *     the builtin-call edges that bypassed it. A dyn holding the right
 *     value passes; a lying one throws the catchable TypeError.
 *   - a dyn argument whose slot dynCheck can NOT validate (functions,
 *     opaque handles like stats/sockets) is FENCED with the SC1100 message
 *     requireExactShape would have used — in JS sources the statement
 *     compiles to its runtime fence, in TS it is a compile diagnostic.
 *     Either way: named, never an ICE, never invalid C.
 *   - unit-typed and union-typed arguments in scalar slots fence the same
 *     way (`setTimeout(cb, value)` over a number|string array), with the
 *     union-mismatch wording the coercion edges use.
 *   - callValue arity mismatches (calling through a checked-dynamic-typed
 *     function value with more arguments than its lowered signature) fence
 *     with the call shape named.
 *
 * The pass never rewrites a well-typed argument: typeEquals matches are
 * untouched, so byte-stability holds for every program that lowered
 * cleanly before. The validator stays the backstop for anything else. */
import type { Lowerer } from "./lowerer.js";
import { PoisonError } from "./lowerer.js";
import { canAdaptDynFuncTo, canMarshalTypedFuncIntoIsland, DYN, IrExpr, IrType, JSVAL, SrcLoc, STRING, isUnitType, typeEquals } from "../../ir/ir.js";
import { LIB_FN_SIGS, REGEX_INTRINSIC_SIGS, STR_INTRINSIC_SIGS } from "../../ir/validate.js";
import { unionMismatchDiag, unsupportedDiag } from "../../diagnostics/diagnostic.js";

/** What a dynCheck can validate — coerceToExpected's dyn→typed domain,
 * kept in lockstep with the wrap it emits there. Adaptable FUNCTION
 * targets are in (the checked-dynamic function boundary: a dyn-wrapped
 * callback flowing into setTimeout's `() => void` slot adapts through
 * the per-target shim). */
function dynCheckable(lowerer: Lowerer, want: IrType): boolean {
  if (lowerer.jsonSafe(want)) return true;
  if (want.kind === "bytes" && want.elem === "u8") return true;
  if (want.kind === "object" && want.className === "%Error") return true;
  if (want.kind === "func") {
    return canAdaptDynFuncTo(want, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id));
  }
  if (want.kind === "union") {
    const def = lowerer.unions.get(want.unionId);
    return !!def && def.arms.every((a) => a.kind === "undefinedT" || lowerer.jsonSafe(a));
  }
  return false;
}

/** The checked coercion for one argument slot, or the named fence. Returns
 * the (possibly wrapped) expression; throws PoisonError on a fence so the
 * statement takes the runtime-fence path in JS sources. */
function coerceSlot(lowerer: Lowerer, arg: IrExpr, want: IrType, what: string): IrExpr {
  if (typeEquals(arg.type, want)) return arg;
  // An ISLAND value in a typed intrinsic slot (`/x/.test(anyText)`,
  // `" ".repeat(anyN)` — checker-`any` arguments the surface signatures
  // accept): the VALIDATED island exit, exactly the dynCheck stance one
  // branch down — strict for primitives, JSON round-trip for composites,
  // a lying handle throws the catchable TypeError. Targets outside the
  // exit set keep the named fence.
  if (arg.type.kind === "jsval" && want.kind !== "jsval") {
    // A jsval into a dyn slot: the by-reference jsval→dyn wrap — the same
    // edge coerceToExpected converts (dyn slots accept engine values;
    // world unification's engine-handle kind).
    if (want.kind === "dyn") {
      return { kind: "dynFromJsval", value: arg, type: DYN, loc: arg.loc };
    }
    if (lowerer.boundaryExitSafe(want)) {
      return { kind: "jsExit", value: arg, type: want, loc: arg.loc };
    }
    fence(lowerer, "SC1100", arg.loc, `passing 'any'-typed values where '${lowerer.fmt(want)}' is expected (${what})`);
  }
  if (arg.type.kind === "dyn" && want.kind !== "dyn") {
    if (dynCheckable(lowerer, want)) {
      return { kind: "dynCheck", value: arg, type: want, loc: arg.loc };
    }
    fence(lowerer, "SC1100", arg.loc, `passing 'unknown' values where '${lowerer.fmt(want)}' is expected (${what})`);
  }
  if (isUnitType(arg.type) && want.kind !== "union" && !isUnitType(want)) {
    fence(lowerer, "SC1090", arg.loc, `'${arg.type.kind === "undefinedT" ? "undefined" : "null"}' values where '${lowerer.fmt(want)}' is expected (${what})`);
  }
  if (arg.type.kind === "union" && want.kind !== "union" && !containsDynOrUnit(want)) {
    lowerer.pushDiag(unionMismatchDiag(lowerer.fmt(want), lowerer.fmt(arg.type), arg.loc));
    throw new PoisonError();
  }
  // Every other mismatch: leave it for the validator (the backstop). The
  // signature tables carry program-independent slots only; the shapes this
  // pass exists for are the dyn/unit/union escapes above.
  return arg;
}

function containsDynOrUnit(t: IrType): boolean {
  return t.kind === "dyn" || isUnitType(t);
}

function fence(lowerer: Lowerer, code: "SC1090" | "SC1100", loc: SrcLoc, feature: string): never {
  lowerer.pushDiag(unsupportedDiag(code, loc, feature));
  throw new PoisonError();
}

/** Walks one lowered statement's IR in place, coercing or fencing every
 * signature-table argument slot. Idempotent: a wrapped argument matches its
 * slot on a revisit (nested statement lists are walked by their own
 * lowerStmts call first, then again inside the enclosing statement). */
export function enforceLibBoundary(lowerer: Lowerer, node: unknown): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) enforceLibBoundary(lowerer, item);
    return;
  }
  const rec = node as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== "loc") enforceLibBoundary(lowerer, rec[key]);
  }
  const kind = rec["kind"];
  if (kind === "libCall") {
    const e = rec as unknown as Extract<IrExpr, { kind: "libCall" }>;
    const sig = LIB_FN_SIGS[e.fn];
    if (!sig) return;
    e.args.forEach((a, i) => {
      const want = sig.argTypes[i];
      if (want) e.args[i] = coerceSlot(lowerer, a, want, `argument ${i + 1} of ${e.fn}`);
    });
    return;
  }
  if (kind === "strIntrinsic") {
    const e = rec as unknown as Extract<IrExpr, { kind: "strIntrinsic" }>;
    e.receiver = coerceSlot(lowerer, e.receiver, STRING, `the receiver of .${e.method}`);
    const sig = STR_INTRINSIC_SIGS[e.method];
    if (!sig) return;
    e.args.forEach((a, i) => {
      const want = sig.argTypes[i];
      if (want) e.args[i] = coerceSlot(lowerer, a, want, `argument ${i + 1} of .${e.method}`);
    });
    return;
  }
  if (kind === "regexIntrinsic") {
    const e = rec as unknown as Extract<IrExpr, { kind: "regexIntrinsic" }>;
    const sig = REGEX_INTRINSIC_SIGS[e.method];
    if (!sig) return;
    e.receiver = coerceSlot(lowerer, e.receiver, sig.receiver, `the receiver of .${e.method}`);
    e.args.forEach((a, i) => {
      const want = sig.argTypes[i];
      if (want) e.args[i] = coerceSlot(lowerer, a, want, `argument ${i + 1} of .${e.method}`);
    });
    return;
  }
  if (kind === "arrIntrinsic") {
    const e = rec as unknown as Extract<IrExpr, { kind: "arrIntrinsic" }>;
    if (e.receiver.type.kind === "dyn" || e.receiver.type.kind === "jsval" || isUnitType(e.receiver.type)) {
      // No element type exists to validate a dyn receiver against — the
      // honest answer is the operations-on-unknown fence. An island
      // (jsval) receiver fences too: the exit would COPY the engine
      // array, so a static intrinsic over it silently mutates the copy —
      // the producing sites route jsval receivers through the engine's
      // own methods instead. Other non-array receivers stay the
      // validator's ICE (frontend breakage, not a checked-dynamic
      // escape).
      fence(lowerer, "SC1100", e.receiver.loc, `'.${e.method}()' on '${lowerer.fmt(e.receiver.type)}' array receivers`);
    }
    return;
  }
  if (kind === "callValue") {
    const e = rec as unknown as Extract<IrExpr, { kind: "callValue" }>;
    if (e.callee.type.kind === "dyn" || e.callee.type.kind === "jsval" || isUnitType(e.callee.type)) {
      fence(lowerer, "SC1100", e.loc, `calling '${lowerer.fmt(e.callee.type)}' values`);
    }
    if (e.callee.type.kind !== "func") return; // validator's ICE otherwise
    const params = e.callee.type.params;
    if (e.args.length !== params.length) {
      fence(
        lowerer,
        "SC1090",
        e.loc,
        `calling a function value with ${e.args.length} argument${e.args.length === 1 ? "" : "s"} where its lowered signature takes ${params.length}`,
      );
    }
    e.args.forEach((a, i) => {
      const want = params[i];
      if (want) e.args[i] = coerceSlot(lowerer, a, want, `argument ${i + 1} of the call`);
    });
    return;
  }
  if (kind === "jsOp") {
    // Engine-op arguments must be jsval. The producing sites marshal with
    // jsvalIn, but a checker-`any` expression can LOWER to another world
    // (dyn.this, the checked-dynamic tree WeakSet placeholder, JS rest-args) — re-apply
    // jsvalIn's rules here: units become the engine's own units, typed
    // values with an island representation marshal in, and dyn values (no
    // dyn→engine bridge that preserves handles/functions) fence with
    // jsvalIn's own message.
    const e = rec as unknown as Extract<IrExpr, { kind: "jsOp" }>;
    e.args.forEach((a, i) => {
      if (a.type.kind === "jsval") return;
      if (isUnitType(a.type)) {
        e.args[i] = { kind: "jsOp", op: a.type.kind === "undefinedT" ? "undefLit" : "nullLit", args: [], type: JSVAL, loc: a.loc };
        return;
      }
      if (a.type.kind === "dyn") {
        fence(lowerer, "SC1100", a.loc, "passing 'unknown' values into dynamically-executed ('any'-typed) code (validate with 'as <type>' first)");
      }
      if (
        lowerer.boundarySafe(a.type) ||
        (a.type.kind === "func" && canMarshalTypedFuncIntoIsland(a.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id)))
      ) {
        e.args[i] = { kind: "jsMarshal", value: a, type: JSVAL, loc: a.loc };
        return;
      }
      fence(lowerer, "SC1090", a.loc, `'${lowerer.fmt(a.type)}' values crossing into dynamically-executed ('any'-typed) code`);
    });
    return;
  }
  if (kind === "dynCall" || kind === "dynInvoke") {
    // Checked-dynamic call arguments must be dyn. Convertible typed values
    // take the ordinary dynFrom crossing; island values have NO bridge
    // into the checked-dynamic tree (a jsval handle cannot ride the deep-copy), so they
    // fence — named, catchable at runtime in JS sources, never an ICE.
    const e = rec as unknown as Extract<IrExpr, { kind: "dynCall" | "dynInvoke" }>;
    if (kind === "dynInvoke") {
      const inv = e as Extract<IrExpr, { kind: "dynInvoke" }>;
      if (inv.recv.type.kind !== "dyn") {
        fence(lowerer, "SC1100", inv.recv.loc, `'.${inv.method}()' calls through '${lowerer.fmt(inv.recv.type)}' receivers in checked-dynamic positions`);
      }
    }
    e.args.forEach((a, i) => {
      if (a.type.kind === "dyn") return;
      if (a.type.kind === "jsval") {
        // An island value in a checked-dynamic argument slot: the
        // jsval→dyn crossing (by-reference wrap, scalars normalized) —
        // the routed call converts it back by reference at the boundary.
        e.args[i] = { kind: "dynFromJsval", value: a, type: DYN, loc: a.loc };
        return;
      }
      if (a.kind === "unitLit" || lowerer.dynConvertible(a.type)) {
        e.args[i] = { kind: "dynFrom", value: a, type: DYN, loc: a.loc };
        return;
      }
      fence(lowerer, "SC1100", a.loc, `passing '${lowerer.fmt(a.type)}' values into calls through 'unknown' values`);
    });
    return;
  }
}
