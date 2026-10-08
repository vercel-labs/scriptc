import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  isClassOwnEnumerableFieldName,
  type IrExpr,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { findMethodOn, type ClassInfo } from "./lower-classes.js";
import { classPropertiesHelper } from "./class-dynamic-dispatch.js";
import { classPrototypeData } from "./class-prototypes.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";

/** Unmodified typed methods retain direct or virtual native dispatch.
 * JavaScript notification methods keep their checked property fallback. */
export function isClassCallback(lowerer: Lowerer, info: ClassInfo, name: string): boolean {
  if (!isClassOwnEnumerableFieldName(name) || name.startsWith("get:") || name.startsWith("set:"))
    return false;
  if (
    info.def.runtime ||
    info.builtinError ||
    info.builtinEmitter ||
    info.builtinStream ||
    info.fields.has(name)
  )
    return false;
  const found = findMethodOn(lowerer, info, name);
  return (
    !!found &&
    !found.sig.abstract &&
    (lowerer.prototypeMethodAccesses.has(name) ||
      (info.decl !== null &&
        isJsSourceFile(info.decl.getSourceFile()) &&
        found.sig.params.length === 0 &&
        found.sig.ret.kind === "void"))
  );
}

function callbackBag(
  lowerer: Lowerer,
  receiver: IrExpr,
  loc: SrcLoc,
  name: string,
  readOnly = false,
): IrExpr {
  const info =
    receiver.type.kind === "object" ? lowerer.classes.get(receiver.type.className) : null;
  if (info && lowerer.prototypeMethodAccesses.has(name)) classPrototypeData(lowerer, info, loc);
  return {
    kind: "call",
    callee: classPropertiesHelper(lowerer, loc, readOnly).name,
    args: [lowerer.coerceToExpected(receiver, DYN)],
    type: DYN,
    loc,
  };
}

/** A read-only bag may still be absent. Reads must not create own storage
 * merely to select an unchanged method, nor read a key from undefined. */
function callbackPresent(value: IrExpr, key: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "ternary",
    cond: { kind: "dynTest", test: "undefined", value, type: BOOL, loc },
    then: { kind: "boolLit", value: false, type: BOOL, loc },
    else_: { kind: "libCall", fn: "dyn.hasKey", args: [value, key], type: BOOL, loc },
    type: BOOL,
    loc,
  };
}

export function lowerClassCallbackAssign(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrStmt | null {
  const access = expr.left;
  if (!ts.isPropertyAccessExpression(access) || access.questionDotToken) return null;
  const receiver = tryLowerExpression(lowerer, access.expression);
  if (!receiver) return null;
  const info =
    receiver.type.kind === "object" ? lowerer.classes.get(receiver.type.className) : undefined;
  if (!info || !isClassCallback(lowerer, info, access.name.text)) return null;
  const loc = locOf(expr);
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.keySet",
      args: [
        callbackBag(lowerer, receiver, loc, access.name.text),
        { kind: "strLit", value: access.name.text, type: STRING, loc },
        lowerer.lowerExprExpecting(expr.right, DYN),
      ],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** Read the property before arguments run, retaining callback identity
 * and the original native receiver for JavaScript's `this` binding. */
export function classCallbackValue(
  lowerer: Lowerer,
  receiver: IrExpr,
  name: string,
  fallback: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const bag = lowerer.declareHiddenLocal("%callbackBag", DYN);
  const value = varRef(bag.id, DYN, loc);
  const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
  const result: IrExpr = lowerer.prototypeMethodAccesses.has(name)
    ? { kind: "dynKeyGet", value, key, type: DYN, loc }
    : {
        kind: "ternary",
        cond: callbackPresent(value, key, loc),
        then: { kind: "dynKeyGet", value, key, type: DYN, loc },
        else_: lowerer.coerceToExpected(fallback, DYN),
        type: DYN,
        loc,
      };
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "varDecl",
        localId: bag.id,
        init: callbackBag(lowerer, receiver, loc, name, true),
        loc,
      },
    ],
    result,
    type: DYN,
    loc,
  };
}

export function classCallbackCall(
  lowerer: Lowerer,
  receiver: IrExpr,
  name: string,
  args: IrExpr[],
  fallback: IrExpr,
  loc: SrcLoc,
  calleeName = name,
): IrExpr {
  const bag = lowerer.declareHiddenLocal("%callbackBag", DYN);
  const present = lowerer.declareHiddenLocal("%callbackPresent", BOOL);
  const callback = lowerer.declareHiddenLocal("%callback", DYN);
  const value = varRef(bag.id, DYN, loc);
  const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
  const call: IrExpr = {
    kind: "dynCall",
    callee: varRef(callback.id, DYN, loc),
    receiver: lowerer.coerceToExpected(receiver, DYN),
    calleeName,
    args,
    type: DYN,
    loc,
  };
  const result: IrExpr = lowerer.prototypeMethodAccesses.has(name)
    ? call
    : {
        kind: "ternary",
        cond: varRef(present.id, BOOL, loc),
        then: call,
        else_:
          fallback.type.kind === "void"
            ? {
                kind: "seqExpr",
                stmts: [{ kind: "exprStmt", expr: fallback, loc }],
                result: dynUndefinedExpr(loc),
                type: DYN,
                loc,
              }
            : lowerer.coerceToExpected(fallback, DYN),
        type: DYN,
        loc,
      };
  const answer =
    fallback.type.kind === "void" ? result : lowerer.coerceToExpected(result, fallback.type);
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "varDecl",
        localId: bag.id,
        init: callbackBag(lowerer, receiver, loc, name, true),
        loc,
      },
      {
        kind: "varDecl",
        localId: present.id,
        init: lowerer.prototypeMethodAccesses.has(name)
          ? { kind: "boolLit", value: true, type: BOOL, loc }
          : callbackPresent(value, key, loc),
        loc,
      },
      {
        kind: "varDecl",
        localId: callback.id,
        init: {
          kind: "ternary",
          cond: { kind: "dynTest", test: "undefined", value, type: BOOL, loc },
          then: dynUndefinedExpr(loc),
          else_: { kind: "dynKeyGet", value, key, type: DYN, loc },
          type: DYN,
          loc,
        },
        loc,
      },
    ],
    result: answer,
    type: answer.type,
    loc,
  };
}
