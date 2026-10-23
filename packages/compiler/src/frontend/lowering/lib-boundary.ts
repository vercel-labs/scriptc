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
 * signature tables the validator enforces (owned by the IR contract —
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
import {
  everyExprChild,
  everyStmtChild,
  mapExprChildren,
  mapStmtChildren,
} from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";
import { PoisonError } from "./lowerer.js";
import {
  canAdaptDynFuncTo,
  DYN,
  DYN_HANDLE_KINDS,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
  STRING,
  isDynTypedRefType,
  isUnitType,
  typeEquals,
} from "../../ir/ir.js";
import { LIB_FN_SIGS } from "../../ir/builtin-signatures.js";
import { REGEX_INTRINSIC_SIGS, STR_INTRINSIC_SIGS } from "../../ir/intrinsic-signatures.js";
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
  if (isDynTypedRefType(want) || DYN_HANDLE_KINDS.has(want.kind)) return true;
  if (want.kind === "func") {
    return canAdaptDynFuncTo(
      want,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    );
  }
  if (want.kind === "union") {
    const def = lowerer.unions.get(want.unionId);
    return (
      !!def &&
      def.arms.every(
        (a) =>
          a.kind === "undefinedT" ||
          lowerer.jsonSafe(a) ||
          isDynTypedRefType(a) ||
          DYN_HANDLE_KINDS.has(a.kind),
      )
    );
  }
  return false;
}

/** The checked coercion for one argument slot, or the named fence. Returns
 * the (possibly wrapped) expression; throws PoisonError on a fence so the
 * statement takes the runtime-fence path in JS sources. */
function coerceSlot(lowerer: Lowerer, arg: IrExpr, want: IrType, what: string): IrExpr {
  if (typeEquals(arg.type, want)) return arg;

  // Checked-value arguments validate against supported native slot types.
  // A mismatch throws a catchable TypeError; unsupported targets refuse.
  if (arg.type.kind === "dyn" && want.kind !== "dyn") {
    if (dynCheckable(lowerer, want)) {
      return { kind: "dynCheck", value: arg, type: want, loc: arg.loc };
    }
    fence(
      lowerer,
      "SC1100",
      arg.loc,
      `passing 'unknown' values where '${lowerer.fmt(want)}' is expected (${what})`,
    );
  }
  if (isUnitType(arg.type) && want.kind !== "union" && !isUnitType(want)) {
    fence(
      lowerer,
      "SC1090",
      arg.loc,
      `'${arg.type.kind === "undefinedT" ? "undefined" : "null"}' values where '${lowerer.fmt(want)}' is expected (${what})`,
    );
  }
  if (arg.type.kind === "union" && want.kind !== "union" && !containsDynOrUnit(want)) {
    // The slot's type or undefined (a read that may miss, or a function
    // returning one): the checked extraction, which throws a catchable
    // TypeError for undefined, as other storage that cannot hold it does.
    if (typeEquals(lowerer.stripUndefinedArm(arg.type), want)) {
      const helper = lowerer.narrowedArmHelper(arg.type.unionId, want, arg.loc);
      if (helper) return lowerer.checkedNarrowCall(helper, arg, want, arg.loc);
    }
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
export function enforceLibBoundary(lowerer: Lowerer, node: IrStmt | IrStmt[]): void {
  const stmt = (value: IrStmt): boolean => everyStmtChild(value, expr, stmt);
  const expr = (value: IrExpr): boolean => {
    everyExprChild(value, expr, stmt);
    enforceExprBoundary(lowerer, value);
    return true;
  };
  if (Array.isArray(node))
    node.forEach((value) => {
      stmt(value);
    });
  else stmt(node);
}

function enforceExprBoundary(lowerer: Lowerer, node: IrExpr): void {
  const kind = node.kind;
  if (kind === "libCall") {
    const e = node;
    const sig = LIB_FN_SIGS[e.fn];
    if (!sig) return;
    e.args.forEach((a, i) => {
      const want = sig.argTypes[i];
      if (want) e.args[i] = coerceSlot(lowerer, a, want, `argument ${i + 1} of ${e.fn}`);
    });
    return;
  }
  if (kind === "strIntrinsic") {
    const e = node;
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
    const e = node;
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
    const e = node;
    if (e.receiver.type.kind === "dyn" || isUnitType(e.receiver.type)) {
      // No element type exists to validate a checked-value receiver against.
      // Copying it would redirect mutations, so use its native checked-value
      // methods instead. Other non-array receivers stay the
      // validator's ICE (frontend breakage, not a checked-dynamic
      // escape).
      fence(
        lowerer,
        "SC1100",
        e.receiver.loc,
        `'.${e.method}()' on '${lowerer.fmt(e.receiver.type)}' array receivers`,
      );
    }
    return;
  }
  if (kind === "callValue") {
    const e = node;
    if (e.callee.type.kind === "dyn" || isUnitType(e.callee.type)) {
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
  if (kind === "dynCall" || kind === "dynInvoke") {
    // Checked-value call arguments must be dyn. Convert supported typed
    // values and refuse the rest with a named diagnostic.
    const e = node;
    if (kind === "dynInvoke") {
      const inv = e as Extract<IrExpr, { kind: "dynInvoke" }>;
      if (inv.recv.type.kind !== "dyn") {
        fence(
          lowerer,
          "SC1100",
          inv.recv.loc,
          `'.${inv.method}()' calls through '${lowerer.fmt(inv.recv.type)}' receivers in checked-dynamic positions`,
        );
      }
    }
    e.args.forEach((a, i) => {
      if (a.type.kind === "dyn") return;

      if (a.kind === "unitLit" || lowerer.dynConvertible(a.type)) {
        e.args[i] = { kind: "dynFrom", value: a, type: DYN, loc: a.loc };
        return;
      }
      fence(
        lowerer,
        "SC1100",
        a.loc,
        `passing '${lowerer.fmt(a.type)}' values into calls through 'unknown' values`,
      );
    });
    return;
  }
}

/** JavaScript evaluates surplus arguments before invoking a fixed native callback. */
export function lowerSurplusCalls(lowerer: Lowerer, body: IrStmt[]): IrStmt[] {
  const stmt = (value: IrStmt): IrStmt => {
    // Only JavaScript permits this call shape. Preserve untouched IR
    // identities, including the compiler's own recursive union layouts.
    let needed = false;
    const inspectStmt = (node: IrStmt): boolean => everyStmtChild(node, inspectExpr, inspectStmt);
    const inspectExpr = (node: IrExpr): boolean => {
      if (
        node.kind === "callValue" &&
        node.callee.type.kind === "func" &&
        node.args.length > node.callee.type.params.length &&
        /\.(?:[cm]?js)$/.test(node.loc.file)
      )
        needed = true;
      return everyExprChild(node, inspectExpr, inspectStmt);
    };
    inspectStmt(value);
    if (!needed) return value;
    const next = mapStmtChildren(value, expr, stmt);
    if (next.kind === "return")
      for (const entry of lowerer.ctx.inferReturn?.entries ?? []) {
        if (entry.stmt === value) entry.stmt = next;
      }
    return next;
  };
  const expr = (value: IrExpr): IrExpr => {
    const e = mapExprChildren(value, expr, stmt);
    if (e.kind !== "callValue" || e.callee.type.kind !== "func") return e;
    const params = e.callee.type.params;
    if (e.args.length > params.length && /\.(?:[cm]?js)$/.test(e.loc.file)) {
      const callee = lowerer.declareHiddenLocal("%surplusCallee", e.callee.type);
      const stmts: IrStmt[] = [{ kind: "varDecl", localId: callee.id, init: e.callee, loc: e.loc }];
      let receiver = e.receiver;
      if (receiver) {
        const local = lowerer.declareHiddenLocal("%surplusReceiver", receiver.type);
        stmts.push({ kind: "varDecl", localId: local.id, init: receiver, loc: receiver.loc });
        receiver = { kind: "varRef", localId: local.id, type: receiver.type, loc: receiver.loc };
      }
      const args = e.args.map((value) => {
        const local = lowerer.declareHiddenLocal("%surplusArgument", value.type);
        stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
        return { kind: "varRef" as const, localId: local.id, type: local.type, loc: value.loc };
      });
      const result: IrExpr = {
        ...e,
        callee: { kind: "varRef", localId: callee.id, type: e.callee.type, loc: e.loc },
        args: args.slice(0, params.length),
      };
      if (receiver) result.receiver = receiver;
      result.args.forEach((value, i) => {
        result.args[i] = coerceSlot(lowerer, value, params[i]!, `argument ${i + 1} of the call`);
      });
      return { kind: "seqExpr", stmts, result, type: e.type, loc: e.loc };
    }
    return e;
  };
  return body.map(stmt);
}
