import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  isClassOwnEnumerableFieldName,
  typeEquals,
  type IrExpr,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import { PoisonError, type Lowerer } from "./lowerer.js";
import { unsupportedDiag } from "../../diagnostics/diagnostic.js";
import { findMethodOn, type ClassInfo } from "./lower-classes.js";
import { classPropertiesHelper } from "./class-dynamic-dispatch.js";
import { observedPrototypeMethod } from "./class-prototypes.js";
import { checkedIterableSpread } from "./checked-iterable-spread.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";

/** Unmodified typed methods retain direct or virtual native dispatch.
 * JavaScript notification methods keep their checked property fallback,
 * except in files TypeScript checks, whose methods join the method census
 * like TypeScript methods. */
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
        isJsSourceFile(ts.getSourceFileOfNode(info.decl)) &&
        !lowerer.checkedJsFile(ts.getSourceFileOfNode(info.decl)) &&
        found.sig.params.length === 0 &&
        found.sig.ret.kind === "void"))
  );
}

/** The census marked `name` and the receiver's class keeps the method in
 * its prototype data, so the property bag answers every read. */
function observedSlot(lowerer: Lowerer, receiver: IrExpr, name: string, loc: SrcLoc): boolean {
  const info =
    receiver.type.kind === "object" ? lowerer.classes.get(receiver.type.className) : undefined;
  return info
    ? observedPrototypeMethod(lowerer, info, name, loc, receiver)
    : lowerer.prototypeMethodAccesses.has(name);
}

function callbackBag(
  lowerer: Lowerer,
  receiver: IrExpr,
  loc: SrcLoc,
  name: string,
  readOnly = false,
): IrExpr {
  // Builds the prototype data that an observed read falls back to.
  observedSlot(lowerer, receiver, name, loc);
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
  const result: IrExpr = observedSlot(lowerer, receiver, name, loc)
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

/** Notes a checked conversion of a replaceable method's result for the
 * key-order witness: the result is a value the method or its replacement
 * returns, not a record built from a dynamic value. */
function methodResult(lowerer: Lowerer, checked: IrExpr, name: string): IrExpr {
  return checked.kind === "dynCheck" ? lowerer.keyOrder.methodResult(checked, name) : checked;
}

export function classCallbackCall(
  lowerer: Lowerer,
  receiver: IrExpr,
  name: string,
  argumentNodes: readonly ts.Expression[],
  fallback: IrExpr,
  loc: SrcLoc,
  calleeName = name,
  original?: { originalId: () => string | undefined; directCall: () => IrExpr },
): IrExpr {
  const bag = lowerer.declareHiddenLocal("%callbackBag", DYN);
  const present = lowerer.declareHiddenLocal("%callbackPresent", BOOL);
  const callback = lowerer.declareHiddenLocal("%callback", DYN);
  const value = varRef(bag.id, DYN, loc);
  const key: IrExpr = { kind: "strLit", value: name, type: STRING, loc };
  const spreads: { arg: number; what: string }[] = [];
  const args = argumentNodes.map((argument, index) => {
    if (!ts.isSpreadElement(argument)) return lowerer.lowerExprExpecting(argument, DYN);
    const spelling = ts.getTextOfNode(argument.expression);
    spreads.push({ arg: index, what: spelling });
    return checkedIterableSpread(lowerer, lowerer.lowerExpr(argument.expression), spelling, loc);
  });
  const call: IrExpr = {
    kind: "dynCall",
    callee: varRef(callback.id, DYN, loc),
    receiver: lowerer.coerceToExpected(receiver, DYN),
    calleeName,
    args,
    ...(spreads.length > 0 ? { spreads } : {}),
    type: DYN,
    loc,
  };
  const observed = observedSlot(lowerer, receiver, name, loc);
  const boxed =
    observed || fallback.type.kind === "void" ? null : lowerer.coerceToExpected(fallback, DYN);
  let answer: IrExpr;
  if (boxed !== null && boxed.type.kind !== "dyn") {
    // A result with no checked-dynamic form (an Iterable<T>, whose
    // generator arm does not box) keeps its native type: the unchanged
    // method's result stays as it is, and a replacement's dynamic result
    // takes the checked conversion into that type.
    const converted = methodResult(lowerer, lowerer.coerceToExpected(call, fallback.type), name);
    if (!typeEquals(converted.type, fallback.type)) {
      lowerer.pushDiag(
        unsupportedDiag(
          "SC1090",
          loc,
          `calling replaceable method '${calleeName}' with a '${lowerer.fmt(fallback.type)}' result`,
        ),
      );
      throw new PoisonError();
    }
    answer = {
      kind: "ternary",
      cond: varRef(present.id, BOOL, loc),
      then: converted,
      else_: fallback,
      type: fallback.type,
      loc,
    };
  } else {
    const result: IrExpr = observed
      ? call
      : {
          kind: "ternary",
          cond: varRef(present.id, BOOL, loc),
          then: call,
          else_: boxed ?? {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: fallback, loc }],
            result: dynUndefinedExpr(loc),
            type: DYN,
            loc,
          },
          type: DYN,
          loc,
        };
    answer =
      fallback.type.kind === "void"
        ? result
        : methodResult(lowerer, lowerer.coerceToExpected(result, fallback.type), name);
  }
  // Read after observedSlot built the prototype data and its originals.
  const originalId = observed ? original?.originalId() : undefined;
  if (original && originalId !== undefined) {
    // The slot still holds the method's original value: calling it is
    // calling the method, so the call stays native (no boxed arguments,
    // dynamic call or checked result). A replacement takes the dynamic call.
    const unchanged: IrExpr = {
      kind: "libCall",
      fn: "dyn.sameValue",
      args: [varRef(callback.id, DYN, loc), varRef(originalId, DYN, loc)],
      type: BOOL,
      loc,
    };
    answer =
      fallback.type.kind === "void"
        ? {
            kind: "ternary",
            cond: unchanged,
            then: {
              kind: "seqExpr",
              stmts: [{ kind: "exprStmt", expr: original.directCall(), loc }],
              result: dynUndefinedExpr(loc),
              type: DYN,
              loc,
            },
            else_: call,
            type: DYN,
            loc,
          }
        : {
            kind: "ternary",
            cond: unchanged,
            then: original.directCall(),
            else_: answer,
            type: answer.type,
            loc,
          };
  }
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
        init: observed
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
