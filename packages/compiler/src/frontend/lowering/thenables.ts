/* Thenable adoption for `await` of checked-dynamic values, and the Promise
 * prototype as a value (execa's `(async () => {})().constructor.prototype`
 * Promise mixin; results/opt-execa-thenable/NOTES.md). */
import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  STRING,
  type IrExpr,
  type IrGlobal,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { arrayClassOfType } from "./builtins/array-classes.js";
import { thenReader } from "./checked-promise-all.js";
import { builtinGlobalValue } from "./expressions/property-access.js";
import type { Lowerer } from "./lowerer.js";

/** `await v` over a checked-dynamic value: PromiseResolve(v), then the await
 * of that promise, as JavaScript defines it. A promise is itself, a plain
 * value takes one tick, and an object with a callable `then` is adopted.
 * Whether a value is a thenable is a fact about that value when the await
 * runs, however its `then` got there (a literal key, a computed one, a class
 * method, a proxy trap), so every such await asks the value. */
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

/** Whether the static type of a checked-dynamic value already rules a
 * thenable out: every arm is the standard library's Promise (which the
 * dynamic await awaits), a primitive, null or undefined. `any`, `unknown`,
 * a type parameter and an object type rule nothing out, since a dynamic
 * object can carry more than its type says: there the value answers at run
 * time. */
export function neverThenable(lowerer: Lowerer, type: ts.Type): boolean {
  const plain =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Null;
  for (const part of type.isUnionType() ? ts.constituentTypes(type) : [type]) {
    if (part.flags & plain) continue;
    const symbol = part.getSymbol();
    if (
      symbol !== undefined &&
      ts.symbolName(symbol) === "Promise" &&
      lowerer.isStdlibSymbol(symbol)
    )
      continue;
    return false;
  }
  return true;
}

/** The arms of the static type `type` whose values may be thenables: each
 * has a `then` member that can be called. Arms that map to a promise are the
 * promise lowering's own, and a `then` that cannot be called (`{ then: 5 }`)
 * makes no thenable. A type with no such arm answers none, and its await
 * stays the one-turn hop. */
function thenableArms(lowerer: Lowerer, type: ts.Type, at: ts.Node): ts.Type[] {
  const { checker } = lowerer;
  const skip = ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null;
  const arms: ts.Type[] = [];
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
        arms.push(part);
        break;
      }
    }
  }
  return arms;
}

/** `await v` over a typed value whose static type has a callable `then`:
 * JavaScript calls it, so the value takes the same PromiseResolve as a
 * checked-dynamic one, and what the thenable resolves with is checked into
 * the awaited type where it is used. The call goes through the value's
 * checked-dynamic form, so the form has to carry the member: a record and a
 * class instance do; an instance of a class that extends Array is boxed as
 * the array, without its class's methods, and is refused. Null for a type
 * with no thenable arm. */
export function awaitTypedThenable(
  lowerer: Lowerer,
  node: ts.AwaitExpression,
  value: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  const arms = thenableArms(lowerer, lowerer.typeOf(node.expression), node.expression);
  if (arms.length === 0) return null;
  const carried = arms.every((arm) => {
    const mapped = lowerer.mapTypeOf(arm);
    return (
      mapped !== null &&
      (mapped.kind === "record" || mapped.kind === "object") &&
      arrayClassOfType(lowerer, arm) === null
    );
  });
  if (!carried || !lowerer.dynConvertible(value.type)) {
    lowerer.unsupported(
      "SC1090",
      node,
      `awaiting '${lowerer.fmt(value.type)}' (its type has a 'then' method, so the await calls it, and this value has no checked-dynamic form that carries the method)`,
    );
  }
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
