import { varRef } from "../../ir/build.js";
import { BOOL, isUnitType, typeEquals, VOID } from "../../ir/ir.js";
import type { IrExpr, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../ir/ir.js";
import type * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** A MAYBE-PROMISE union (`T | Promise<T>`, `Promise<R | void> | R |
 * void`): one promise arm beside at least one data arm. The type mapper
 * mints these only when no data arm is thenable, so the union tag decides
 * exactly what JS's await decides: the promise arm settles, every other
 * arm is a non-thenable that answers itself. Promise-or-unit unions keep
 * their own lowerings (awaitUnionExpr). */
export interface MaybePromiseUnion {
  def: IrUnionDef;
  promiseTag: number;
  promise: IrType & { kind: "promise" };
}

export function maybePromiseUnionOf(lowerer: Lowerer, t: IrType): MaybePromiseUnion | null {
  const armed = promiseArmedUnionOf(lowerer, t);
  if (!armed || armed.def.arms.every((a, i) => i === armed.promiseTag || isUnitType(a)))
    return null;
  return armed;
}

/** The promise arm of a promise-or-unit union (`Promise<void> | void`,
 * `Promise<T> | undefined`): exactly one promise arm and only nullish
 * arms beside it, so no other arm carries a value the promise path would
 * have to reconcile. A guard that proves the value present (`?.`, an
 * explicit narrow) leaves this arm alone. */
export function promiseOrUnitUnionOf(lowerer: Lowerer, t: IrType): MaybePromiseUnion | null {
  const armed = promiseArmedUnionOf(lowerer, t);
  if (!armed) return null;
  if (!armed.def.arms.every((a, i) => i === armed.promiseTag || isUnitType(a))) return null;
  return armed;
}

/** Any union with exactly one promise arm: a maybe-promise union or a
 * promise-or-unit union (`Promise<void> | void`). An async `return`
 * resolves both the same way: adopt the promise arm, fulfill otherwise. */
export function promiseArmedUnionOf(lowerer: Lowerer, t: IrType): MaybePromiseUnion | null {
  if (t.kind !== "union") return null;
  const def = lowerer.unions.get(t.unionId);
  if (!def) return null;
  const tags = def.arms.flatMap((a, i) => (a.kind === "promise" ? [i] : []));
  if (tags.length !== 1) return null;
  const promiseTag = tags[0]!;
  const promise = def.arms[promiseTag]!;
  if (promise.kind !== "promise") return null;
  return { def, promiseTag, promise };
}

function unionTagTest(mp: MaybePromiseUnion, value: IrExpr, tag: number, loc: SrcLoc): IrExpr {
  return {
    kind: "unionIsTag",
    unionId: mp.def.id,
    tag,
    negated: false,
    value,
    type: BOOL,
    loc,
  };
}

/** The value of `ref` (a repeatable read of the maybe-promise union) as
 * `target`, given that it does not hold the promise arm: each remaining
 * arm extracts and converts. Null when some arm cannot convert. */
function nonPromiseArmsAs(
  lowerer: Lowerer,
  mp: MaybePromiseUnion,
  ref: IrExpr,
  target: IrType,
  loc: SrcLoc,
): IrExpr | null {
  const pieces: { tag: number; value: IrExpr }[] = [];
  for (let tag = 0; tag < mp.def.arms.length; tag++) {
    if (tag === mp.promiseTag) continue;
    const arm = mp.def.arms[tag]!;
    const source: IrExpr =
      arm.kind === "undefinedT" || arm.kind === "nullT"
        ? {
            kind: "unitLit",
            unit: arm.kind === "undefinedT" ? "undefined" : "null",
            type: arm,
            loc,
          }
        : { kind: "unionNarrow", unionId: mp.def.id, tag, value: ref, type: arm, loc };
    const value = lowerer.coerceToExpected(source, target);
    if (!typeEquals(value.type, target)) return null;
    pieces.push({ tag, value });
  }
  let result: IrExpr | null = null;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const piece = pieces[i]!;
    result =
      result === null
        ? piece.value
        : {
            kind: "ternary",
            cond: unionTagTest(mp, ref, piece.tag, loc),
            then: piece.value,
            else_: result,
            type: target,
            loc,
          };
  }
  return result;
}

function hopStmt(loc: SrcLoc): IrStmt {
  return {
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "async.hop", args: [], type: VOID, loc },
    loc,
  };
}

/** `await u` over a maybe-promise union. JS's await resolves the operand:
 * a native promise is awaited directly (resumption one turn after it
 * settles; a rejection throws here), and any other non-thenable value
 * resumes after exactly one microtask turn with the value itself. The
 * result type is the checker's type of the await expression (`Awaited`
 * of the union), which holds the promise's settled type and every data
 * arm. */
export function lowerMaybePromiseAwait(
  lowerer: Lowerer,
  expr: ts.AwaitExpression,
  value: IrExpr,
  mp: MaybePromiseUnion,
  loc: SrcLoc,
): IrExpr {
  const resultT = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (!resultT || resultT.kind === "void" || resultT.kind === "dyn" || isUnitType(resultT)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `awaiting '${lowerer.fmt(value.type)}' (the awaited result type has no compiled representation)`,
    );
  }
  const local = lowerer.declareHiddenLocal("%maybePromise", value.type);
  const ref = varRef(local.id, value.type, loc);
  const inner = mp.promise.inner;
  const awaited: IrExpr = {
    kind: "awaitExpr",
    value: {
      kind: "unionNarrow",
      unionId: mp.def.id,
      tag: mp.promiseTag,
      value: ref,
      type: mp.promise,
      loc,
    },
    type: inner,
    loc,
  };
  let settled: IrExpr | null;
  if (inner.kind === "void") {
    const undef = lowerer.wrappedUndefined(resultT, loc);
    settled =
      undef === null
        ? null
        : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: awaited, loc }],
            result: undef,
            type: resultT,
            loc,
          };
  } else {
    settled = lowerer.coerceToExpected(awaited, resultT);
    if (!typeEquals(settled.type, resultT)) settled = null;
  }
  const rest = nonPromiseArmsAs(lowerer, mp, ref, resultT, loc);
  if (settled === null || rest === null) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `awaiting '${lowerer.fmt(value.type)}' (its arms do not all convert to the awaited result '${lowerer.fmt(resultT)}')`,
    );
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result: {
      kind: "ternary",
      cond: unionTagTest(mp, ref, mp.promiseTag, loc),
      then: settled,
      else_: { kind: "seqExpr", stmts: [hopStmt(loc)], result: rest, type: resultT, loc },
      type: resultT,
      loc,
    },
    type: resultT,
    loc,
  };
}

/** `return u` of a promise-armed union from an async function (or a then
 * handler's lifted body) whose settled type is `R`: the promise arm is
 * adopted exactly like `return p` (the spec's thenable resolution, with
 * its then-job turn), and the other arms fulfill directly. Null when an
 * arm cannot convert to R. */
export function maybePromiseReturnStmt(
  lowerer: Lowerer,
  value: IrExpr,
  mp: MaybePromiseUnion,
  R: IrType,
  coerce: (awaited: IrExpr) => IrExpr,
): IrStmt | null {
  const loc = value.loc;
  const local = lowerer.declareHiddenLocal("%maybePromise", value.type);
  const ref = varRef(local.id, value.type, loc);
  const promise: IrExpr = {
    kind: "unionNarrow",
    unionId: mp.def.id,
    tag: mp.promiseTag,
    value: ref,
    type: mp.promise,
    loc,
  };
  let otherwise: IrStmt[];
  if (R.kind === "void") {
    otherwise = [{ kind: "return", value: null, loc }];
  } else {
    const rest = nonPromiseArmsAs(lowerer, mp, ref, R, loc);
    if (rest === null) return null;
    otherwise = [{ kind: "return", value: rest, loc }];
  }
  return {
    kind: "block",
    body: [
      { kind: "varDecl", localId: local.id, init: value, loc },
      {
        kind: "if",
        cond: unionTagTest(mp, ref, mp.promiseTag, loc),
        then: [lowerer.adoptingReturn(promise, R, coerce)],
        else_: otherwise,
        loc,
      },
    ],
    loc,
  };
}

/** `Promise.resolve(u)` over a maybe-promise union: a promise argument is
 * returned as is (every scriptc promise is native, so the spec's
 * constructor check answers identity), any other value fulfills a fresh
 * promise. Null when the promise arm is not already the result type (no
 * identity-preserving payload adapter exists) or a data arm cannot convert. */
export function maybePromiseResolve(
  lowerer: Lowerer,
  value: IrExpr,
  mp: MaybePromiseUnion,
  resultT: IrType & { kind: "promise" },
  loc: SrcLoc,
): IrExpr | null {
  const local = lowerer.declareHiddenLocal("%maybePromise", value.type);
  const ref = varRef(local.id, value.type, loc);
  let promise: IrExpr = {
    kind: "unionNarrow",
    unionId: mp.def.id,
    tag: mp.promiseTag,
    value: ref,
    type: mp.promise,
    loc,
  };
  if (!typeEquals(mp.promise, resultT)) {
    if (resultT.inner.kind !== "void") return null;
    promise = { kind: "promiseVoidWiden", value: promise, type: resultT, loc };
  }
  let fresh: IrExpr;
  if (resultT.inner.kind === "void") {
    fresh = { kind: "intrinsic", name: "promise.resolve", args: [], type: resultT, loc };
  } else {
    const rest = nonPromiseArmsAs(lowerer, mp, ref, resultT.inner, loc);
    if (rest === null) return null;
    fresh = { kind: "intrinsic", name: "promise.resolve", args: [rest], type: resultT, loc };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result: {
      kind: "ternary",
      cond: unionTagTest(mp, ref, mp.promiseTag, loc),
      then: promise,
      else_: fresh,
      type: resultT,
      loc,
    },
    type: resultT,
    loc,
  };
}

/** `u instanceof Promise` over a maybe-promise (or promise-or-unit) union:
 * the union tag test. */
export function maybePromiseInstanceOf(
  lowerer: Lowerer,
  value: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const def = lowerer.unions.get(value.type.unionId);
  const tag = def ? def.arms.findIndex((a) => a.kind === "promise") : -1;
  if (!def || tag < 0) return null;
  return { kind: "unionIsTag", unionId: def.id, tag, negated: false, value, type: BOOL, loc };
}
