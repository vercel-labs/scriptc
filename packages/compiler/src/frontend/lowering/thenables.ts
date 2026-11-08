/* Thenable adoption for `await` of checked-dynamic values, and the Promise
 * prototype as a value (execa's `(async () => {})().constructor.prototype`
 * Promise mixin; results/opt-execa-thenable/NOTES.md). */
import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  STRING,
  canDynCheckTo,
  typeEquals,
  type IrExpr,
  type IrGlobal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { thenReader } from "./checked-promise-all.js";
import { builtinGlobalValue } from "./expressions/property-access.js";
import type { Lowerer } from "./lowerer.js";

/** Whether any program source can define a thenable: a `then` method or
 * function (generic ones too), a `then:` key, a quoted `'then'` key, or an
 * assignment to `then` (a class field such as `then = (resolve) => ...` or
 * a `.then` property). `.then(` calls alone do not count. Programs without
 * one keep the plain checked-dynamic await. */
export function programMayDefineThenables(lowerer: Lowerer): boolean {
  if (lowerer.thenablesMayBeDefined === null) {
    const pattern = /(^|[^.\w$])then\s*[(<]|\bthen\s*:|['"`]then['"`]|(^|[^\w$])then\s*=(?![=>])/m;
    lowerer.thenablesMayBeDefined = lowerer.program
      .getImplementationSourceFiles()
      .some((sf) => !sf.isDeclarationFile && ts.sourceTextMatches(sf, pattern));
  }
  return lowerer.thenablesMayBeDefined;
}

/** `await v` over a checked-dynamic value: PromiseResolve(v), then the await
 * of that promise, as JavaScript defines it. A promise is itself, a plain
 * value takes one tick, and an object with a callable `then` is adopted. */
export function awaitDynThenable(lowerer: Lowerer, value: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "awaitExpr",
    value: {
      kind: "libCall",
      fn: "dyn.promiseResolve",
      args: [value, thenReader(lowerer, loc)],
      type: { kind: "promise", inner: DYN },
      loc,
    },
    type: DYN,
    loc,
  };
}

/** The parts of the static type `type` whose values may be thenables that
 * are not promises: each has a `then` member that can be called and does
 * not map to the promise type. The library's PromiseLike is one, and so is
 * an interface, a class or an object literal of the program that declares
 * such a member. A `then` that cannot be called (`{ then: 5 }`) makes no
 * thenable. */
export function thenableParts(lowerer: Lowerer, type: ts.Type, at: ts.Node): ts.Type[] {
  const { checker } = lowerer;
  const skip =
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Null |
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown;
  const parts: ts.Type[] = [];
  for (const part of type.isUnionType() ? ts.constituentTypes(type) : [type]) {
    if (part.flags & skip) continue;
    const then = checker.getPropertyOfType(part, "then");
    if (then === undefined) continue;
    if (lowerer.mapTypeOf(part)?.kind === "promise") continue;
    const member = checker.getTypeOfSymbolAtLocation(then, at);
    for (const arm of member.isUnionType() ? ts.constituentTypes(member) : [member]) {
      if (
        arm.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
        checker.getCallSignatures(arm).length > 0
      ) {
        parts.push(part);
        break;
      }
    }
  }
  return parts;
}

/** PromiseResolve over a value whose static type has a thenable part (a
 * slot declared `PromiseLike<T>`, an object of the program with a `then`
 * method): what `Promise.resolve(v)` answers and what a combinator makes of
 * each entry. A promise is itself, a thenable is adopted through its `then`
 * one job later, and anything else fulfils a new promise; the value takes
 * its checked-dynamic form, where the runtime asks it. The promise settles
 * with `want`'s payload when given, otherwise with the checker's awaited
 * type of the operand when that maps, checked where the thenable hands its
 * value over. Null when the type has no thenable part or the value has no
 * checked-dynamic form that carries the member. */
export function promiseResolveThenable(
  lowerer: Lowerer,
  node: ts.Expression,
  value: IrExpr,
  loc: SrcLoc,
  want?: IrType & { kind: "promise" },
): IrExpr | null {
  if (value.type.kind === "promise") return null;
  const type = lowerer.typeOf(node);
  if (thenableParts(lowerer, type, node).length === 0) return null;
  if (value.type.kind !== "dyn" && !lowerer.dynConvertible(value.type)) return null;
  const dynPromise: IrType & { kind: "promise" } = { kind: "promise", inner: DYN };
  const resolved: IrExpr = {
    kind: "libCall",
    fn: "dyn.promiseResolve",
    args: [lowerer.coerceToExpected(value, DYN), thenReader(lowerer, loc)],
    type: dynPromise,
    loc,
  };
  let target = want;
  if (target === undefined) {
    const awaited = lowerer.checker.getAwaitedType(type);
    const mapped = awaited !== undefined && awaited !== type ? lowerer.mapTypeOf(awaited) : null;
    target = mapped === null ? dynPromise : { kind: "promise", inner: mapped };
  }
  if (target.inner.kind === "dyn") return resolved;
  const direct = lowerer.coerceToExpected(resolved, target);
  if (typeEquals(direct.type, target)) return direct;
  if (
    !canDynCheckTo(
      target,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  )
    return null;
  return {
    kind: "dynCheck",
    value: { kind: "dynFrom", value: resolved, type: DYN, loc },
    type: target,
    loc,
  };
}

/** `await v` over a typed value whose static type has a thenable part (an
 * object of the program with a `then` method): JavaScript calls it, so the
 * value takes the same PromiseResolve as a checked-dynamic one, and what the
 * thenable hands over is checked into the awaited type where it is used.
 * Null for a type with no thenable part, and for a value whose
 * checked-dynamic form does not carry the member (the await then keeps the
 * lowering it has). */
export function awaitTypedThenable(
  lowerer: Lowerer,
  node: ts.AwaitExpression,
  value: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (value.type.kind !== "record" && value.type.kind !== "object") return null;
  if (thenableParts(lowerer, lowerer.typeOf(node.expression), node.expression).length === 0)
    return null;
  if (!lowerer.dynConvertible(value.type)) return null;
  return awaitDynThenable(lowerer, lowerer.coerceToExpected(value, DYN), loc);
}

const PROTOTYPE_GLOBAL = "%g.%promise.prototype";

/** Promise.prototype as a checked object: own, non-enumerable `then`,
 * `catch` and `finally` (the runtime's promise method values, which act on
 * their receiver) and `constructor`. Built once when the program starts. */
export function promisePrototypeValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  let global = lowerer.globalsList.find((g) => g.id === PROTOTYPE_GLOBAL);
  if (!global) {
    global = {
      id: PROTOTYPE_GLOBAL,
      name: "PromisePrototype",
      type: DYN,
      mutable: true,
    } as IrGlobal;
    lowerer.globalsList.push(global);
    const promise: IrExpr = {
      kind: "dynFrom",
      value: {
        kind: "libCall",
        fn: "dyn.promiseResolve",
        args: [dynUndefinedExpr(loc), thenReader(lowerer, loc)],
        type: { kind: "promise", inner: DYN },
        loc,
      },
      type: DYN,
      loc,
    };
    const str = (value: string): IrExpr => ({
      kind: "dynFrom",
      value: { kind: "strLit", value, type: STRING, loc },
      type: DYN,
      loc,
    });
    const bool = (value: boolean): IrExpr => ({
      kind: "dynFrom",
      value: { kind: "boolLit", value, type: BOOL, loc },
      type: DYN,
      loc,
    });
    const define = (key: string, value: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.defineProperty",
        args: [
          varRef(PROTOTYPE_GLOBAL, DYN, loc),
          str(key),
          {
            kind: "dynObjLit",
            fields: [
              { key: { kind: "strLit", value: "value", type: STRING, loc }, value },
              { key: { kind: "strLit", value: "writable", type: STRING, loc }, value: bool(true) },
              {
                key: { kind: "strLit", value: "enumerable", type: STRING, loc },
                value: bool(false),
              },
              {
                key: { kind: "strLit", value: "configurable", type: STRING, loc },
                value: bool(true),
              },
            ],
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      },
      loc,
    });
    const method = (name: string): IrExpr => ({
      kind: "dynKeyGet",
      value: promise,
      key: { kind: "strLit", value: name, type: STRING, loc },
      type: DYN,
      loc,
    });
    lowerer.mainPrelude.push(
      {
        kind: "assign",
        localId: PROTOTYPE_GLOBAL,
        value: { kind: "dynObjLit", fields: [], type: DYN, loc },
        loc,
      },
      define("constructor", builtinGlobalValue("Promise", loc)!),
      define("then", method("then")),
      define("catch", method("catch")),
      define("finally", method("finally")),
    );
  }
  return varRef(PROTOTYPE_GLOBAL, DYN, loc);
}
